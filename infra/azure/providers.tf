terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }

  # State lives in Azure rather than on one laptop. Local state means losing
  # that laptop leaves resources that Terraform can no longer manage or
  # destroy, only found and deleted by hand in the portal. Blob storage also
  # provides leases, so two applies cannot run over each other.
  #
  # The storage account is created out of band — it cannot be managed by the
  # state it stores. See docs/runbook.md.
  backend "azurerm" {
    resource_group_name  = "gitops-tfstate-rg"
    storage_account_name = "gitopstfstate25555f49"
    container_name       = "tfstate"
    key                  = "azure.tfstate"
  }
}

provider "azurerm" {
  features {}
  # Credentials come from `az login`, so nothing secret lives in this
  # repository or in a tfvars file.
  subscription_id = var.subscription_id
}
