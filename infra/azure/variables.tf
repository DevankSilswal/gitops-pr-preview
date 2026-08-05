variable "subscription_id" {
  type        = string
  description = "Azure subscription to build in (az account show --query id -o tsv)"
}

variable "location" {
  type        = string
  description = "Azure region"
  default     = "centralindia"
}

variable "name" {
  type        = string
  description = "Prefix for every resource created here"
  default     = "gitops-k3s"
}

# Sizing is a runway decision, not a performance one. On a student credit the
# question is how many months the cluster survives:
#
#   Standard_B2s   2 vCPU / 4 GB   comfortable for k3s + ArgoCD + monitoring
#   Standard_B1ms  1 vCPU / 2 GB   roughly half the burn, but ArgoCD is tight
#                                  and the monitoring stack will not fit
#
# `make azure-stop` deallocates the VM when it is not being demonstrated, which
# stops compute charges entirely and stretches the credit much further than
# choosing a smaller size does.
variable "vm_size" {
  type    = string
  default = "Standard_B2s"
}

variable "admin_username" {
  type    = string
  default = "ubuntu"
}

variable "ssh_public_key" {
  type        = string
  description = "Contents of your SSH public key"
}

variable "disk_size_gb" {
  type    = number
  default = 32
}
