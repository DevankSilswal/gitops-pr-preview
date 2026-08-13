output "public_ip" {
  description = "Public IP of the k3s node; every preview hostname resolves here via nip.io"
  value       = azurerm_public_ip.main.ip_address
}

output "ssh_command" {
  value = "ssh ${var.admin_username}@${azurerm_public_ip.main.ip_address}"
}

output "fetch_kubeconfig" {
  description = "Run this to point your local kubectl at the cluster"
  value       = <<-EOT
    ssh ${var.admin_username}@${azurerm_public_ip.main.ip_address} "sudo cat /etc/rancher/k3s/k3s.yaml" \
      | sed "s/127.0.0.1/${azurerm_public_ip.main.ip_address}/" > ~/.kube/gitops-k3s.yaml
    export KUBECONFIG=~/.kube/gitops-k3s.yaml
  EOT
}

# One argument, the node address. This printed an extra <github-owner> in front
# of it for a while after the script's signature changed, so anyone who copied
# it bootstrapped the cluster with NODE_IP set to the literal word.
output "bootstrap_command" {
  value = "GITHUB_TOKEN=$(gh auth token) ./scripts/bootstrap-cluster.sh ${azurerm_public_ip.main.ip_address}"
}

# nip.io reads dashes as address separators, so the dotted form would be
# misparsed when it follows a label like pr-1.
#
# The slug prefix is not decoration: pull request #1 exists in every repository
# ever created, so without it the second repository onboarded would take over
# the first one's namespace.
output "preview_url_pattern" {
  value = "https://<slug>-pr-<number>.${replace(azurerm_public_ip.main.ip_address, ".", "-")}.nip.io"
}
