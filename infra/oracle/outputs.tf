output "public_ip" {
  description = "Public IP of the k3s node; every preview hostname resolves here via nip.io"
  value       = oci_core_instance.k3s.public_ip
}

output "ssh_command" {
  value = "ssh ubuntu@${oci_core_instance.k3s.public_ip}"
}

output "fetch_kubeconfig" {
  description = "Run this to point your local kubectl at the cluster"
  value       = <<-EOT
    ssh ubuntu@${oci_core_instance.k3s.public_ip} "sudo cat /etc/rancher/k3s/k3s.yaml" \
      | sed "s/127.0.0.1/${oci_core_instance.k3s.public_ip}/" > ~/.kube/gitops-k3s.yaml
    export KUBECONFIG=~/.kube/gitops-k3s.yaml
  EOT
}

output "preview_url_pattern" {
  value = "http://pr-<number>.${oci_core_instance.k3s.public_ip}.nip.io"
}
