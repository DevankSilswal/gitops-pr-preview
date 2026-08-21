variable "subscription_id" {
  type        = string
  description = "Azure subscription to build in (az account show --query id -o tsv)"
}

variable "location" {
  type        = string
  description = "Azure region"
  default     = "eastasia"
}

variable "name" {
  type        = string
  description = "Prefix for every resource created here"
  default     = "gitops-k3s"
}

# Sizing is a runway decision, not a performance one. On a student credit the
# question is how many months the cluster survives:
#
#   Standard_B2als_v2  2 vCPU / 4 GB  AMD burstable, the cheapest size that
#                                     holds k3s + ArgoCD + Prometheus at once
#   Standard_B2ats_v2  2 vCPU / 1 GB  cheaper still, and ArgoCD alone does not
#                                     fit in 1 GB — measured, not assumed
#   Standard_B1ms      1 vCPU / 2 GB  roughly half the burn, but the repo
#                                     generator and Prometheus contend for the
#                                     single core and provisioning latency
#                                     misses its SLO
#
# Size is the third-largest lever, behind spot pricing and the nightly
# shutdown. See docs/cost.md for what each is actually worth.
variable "vm_size" {
  type    = string
  default = "Standard_B2as_v2"
}

# Spot capacity is the single biggest saving available here — roughly a tenth
# of on-demand — and it is affordable precisely because this platform rebuilds
# itself from git. Set it false for a demo you cannot afford to have
# interrupted; everything else in the repository works identically either way.
variable "use_spot" {
  type        = bool
  description = "Run the node on Azure Spot capacity"
  # False, because the live VM is Regular and has been since it was built. The
  # default said true for months while reality said otherwise, which meant a
  # terraform apply would have destroyed the machine to rebuild it as Spot —
  # taking the OS disk, k3s, ArgoCD, every environment and the control plane
  # database with it, since the disk is declared inline in the VM resource.
  #
  # Turning this on is a deliberate rebuild at a chosen time, not a default.
  default = false
}

# Where SSH (22) and the Kubernetes API (6443) may be reached from.
#
# There is no safe default, so there is no default: leaving these open to the
# internet is exactly the hole this variable exists to close. Use your own
# address, e.g. "203.0.113.4/32" — `curl -s ifconfig.me` prints it. Ports 80
# and 443 stay open to everyone, because serving preview URLs to reviewers is
# the entire point.
variable "admin_source_cidr" {
  type        = string
  description = "CIDR permitted to reach SSH and the Kubernetes API"

  validation {
    condition     = can(cidrhost(var.admin_source_cidr, 0))
    error_message = "admin_source_cidr must be a CIDR block, for example 203.0.113.4/32."
  }

  validation {
    condition     = var.admin_source_cidr != "0.0.0.0/0"
    error_message = "0.0.0.0/0 exposes SSH and the Kubernetes API to the internet. Name your own address instead."
  }
}

# Nightly deallocation, in 24-hour HHmm. Free, and worth more than any sizing
# decision: compute is the whole bill, so the hours the cluster is not being
# looked at are the hours worth not paying for. Empty disables the schedule.
variable "auto_shutdown_time" {
  type        = string
  description = "Local time to deallocate the VM each night, HHmm. Empty to disable."
  # Empty, because no such schedule exists in Azure — the resource is absent and
  # az returns ResourceNotFound for it. The default said 2000, so an apply would
  # have created one and started deallocating production every night at eight.
  #
  # That also contradicts the permanent demo, whose entire purpose is answering
  # when nobody is watching. docs/cost.md still describes this saving; it is not
  # in effect, and the bill has been on-demand all along.
  default = ""
}

variable "auto_shutdown_timezone" {
  type        = string
  description = "Windows timezone name for auto_shutdown_time"
  default     = "India Standard Time"
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
