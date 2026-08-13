resource "azurerm_resource_group" "main" {
  name     = "${var.name}-rg"
  location = var.location
}

resource "azurerm_virtual_network" "main" {
  name                = "${var.name}-vnet"
  address_space       = ["10.0.0.0/16"]
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_subnet" "main" {
  name                 = "${var.name}-subnet"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.0.1.0/24"]
}

resource "azurerm_network_security_group" "main" {
  name                = "${var.name}-nsg"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  # Administrative ports are reachable only from admin_source_cidr. They were
  # open to "*" — the entire internet — while every other layer of this
  # platform was carefully scoped: the NetworkPolicy carves out the metadata
  # service, pods run under restricted Pod Security Admission, and the ArgoCD
  # project cannot create RBAC. An unrestricted control plane undoes all of it.
  security_rule {
    name                       = "ssh"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = var.admin_source_cidr
    destination_address_prefix = "*"
  }

  # Every pr-<n> hostname arrives on these two ports; ingress-nginx routes by
  # Host header from there.
  security_rule {
    name                       = "http"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "https"
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  # Kubernetes API, so kubectl and helm can run from a laptop. Anyone who
  # reaches this port and holds the node's kubeconfig is cluster-admin, so it
  # is gated the same way SSH is.
  security_rule {
    name                       = "kubeapi"
    priority                   = 130
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "6443"
    source_address_prefix      = var.admin_source_cidr
    destination_address_prefix = "*"
  }
}

# Static, because the preview hostnames encode the address. A dynamic address
# would change on every deallocate and silently break every preview URL.
resource "azurerm_public_ip" "main" {
  name                = "${var.name}-ip"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  allocation_method   = "Static"
  sku                 = "Standard"
}

resource "azurerm_network_interface" "main" {
  name                = "${var.name}-nic"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = azurerm_subnet.main.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.main.id
  }
}

resource "azurerm_network_interface_security_group_association" "main" {
  network_interface_id      = azurerm_network_interface.main.id
  network_security_group_id = azurerm_network_security_group.main.id
}

resource "azurerm_linux_virtual_machine" "k3s" {
  name                  = var.name
  location              = azurerm_resource_group.main.location
  resource_group_name   = azurerm_resource_group.main.name
  size                  = var.vm_size
  admin_username        = var.admin_username
  network_interface_ids = [azurerm_network_interface.main.id]

  # Spot capacity, at roughly a tenth of the on-demand price.
  #
  # This is affordable here for a reason that is specific to this platform: it
  # already proves it can be rebuilt from code. The VM has been destroyed and
  # recreated with the whole platform and every preview environment restored by
  # the bootstrap script alone, and the public IP is static so no URL changes.
  # An eviction is that same path, minus the destroy.
  #
  # max_bid_price = -1 means pay up to the on-demand price and never be evicted
  # over price — only when the region genuinely needs the capacity back. Naming
  # a lower bid trades a little more money saved for evictions during the day.
  #
  # Deallocate rather than Delete: the OS disk survives, so coming back is a
  # start, not a rebuild. .github/workflows/spot-watchdog.yml notices an
  # evicted VM and starts it again on free runner minutes.
  priority        = var.use_spot ? "Spot" : "Regular"
  eviction_policy = var.use_spot ? "Deallocate" : null
  max_bid_price   = var.use_spot ? -1 : null

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.ssh_public_key
  }

  os_disk {
    caching = "ReadWrite"
    # Standard_LRS is spinning disk and the cheapest tier Azure offers. k3s,
    # ArgoCD and Prometheus are not IO-bound at this size; paying for SSD here
    # buys nothing a preview environment can perceive.
    storage_account_type = "Standard_LRS"
    disk_size_gb         = var.disk_size_gb
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  # The address is known before the machine boots because the public IP is
  # allocated statically above, so k3s can sign its API certificate for it.
  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml", {
    public_ip = azurerm_public_ip.main.ip_address
  }))
}

# Deallocates the VM every night, free of charge.
#
# Compute is the entire bill here — the disk and the static IP together cost
# less than two days of the VM running. A cluster that is up 24/7 for a project
# demonstrated a few hours a week is paying for nothing, and `make azure-stop`
# only helps on the days somebody remembers to run it.
#
# Azure's DevTest shutdown schedule is itself free; it is the same deallocate
# `make azure-stop` performs, on a timer. Bringing it back is `make azure-start`
# — or the spot watchdog, which starts it whenever it finds it stopped.
#
# Nothing is lost by being deallocated. ArgoCD reconciles the whole fleet from
# git on the way back up, and the static IP means every preview URL still
# resolves to the same place.
resource "azurerm_dev_test_global_vm_shutdown_schedule" "nightly" {
  count = var.auto_shutdown_time == "" ? 0 : 1

  virtual_machine_id = azurerm_linux_virtual_machine.k3s.id
  location           = azurerm_resource_group.main.location
  enabled            = true

  daily_recurrence_time = var.auto_shutdown_time
  timezone              = var.auto_shutdown_timezone

  notification_settings {
    enabled = false
  }
}
