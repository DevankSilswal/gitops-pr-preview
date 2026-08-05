terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

provider "azurerm" {
  features {}
  # Credentials come from `az login`, so nothing secret lives in this
  # repository or in a tfvars file.
  subscription_id = var.subscription_id
}
