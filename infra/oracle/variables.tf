# All five OCI credentials come from the config snippet Oracle shows after
# "Add API Key" in the console (Profile -> My Profile -> API Keys).
variable "tenancy_ocid" {
  type        = string
  description = "OCID of the tenancy"
}

variable "user_ocid" {
  type        = string
  description = "OCID of the API user"
}

variable "fingerprint" {
  type        = string
  description = "Fingerprint of the uploaded API signing key"
}

variable "private_key_path" {
  type        = string
  description = "Path to the downloaded API private key (.pem)"
}

variable "region" {
  type        = string
  description = "OCI region, e.g. ap-mumbai-1 or ap-hyderabad-1"
}

variable "compartment_ocid" {
  type        = string
  description = "Compartment to build in; defaults to the tenancy root"
  default     = ""
}

variable "ssh_public_key" {
  type        = string
  description = "Contents of your SSH public key, used for node access"
}

# The Always Free allowance is 4 OCPUs and 24 GB of Ampere A1 across the whole
# tenancy. Using all of it in one node keeps the cluster simple.
variable "ocpus" {
  type    = number
  default = 4
}

variable "memory_in_gbs" {
  type    = number
  default = 24
}

variable "instance_name" {
  type    = string
  default = "gitops-k3s"
}
