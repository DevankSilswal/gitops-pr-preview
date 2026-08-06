SHELL := /usr/bin/env bash
CHART := charts/preview-app
DEMO_HOST ?= pr-1.127.0.0.1.nip.io

KIND_CLUSTER := gitops-preview

.DEFAULT_GOAL := help
.PHONY: help init test lint render validate tf-validate workflow-scripts slugs alerts e2e bootstrap dev-cluster dev-bootstrap dev-down azure-up azure-stop azure-start azure-down clean

help: ## Show available targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk -F':.*?## ' '{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

init: ## Point a fresh fork at itself (run once, after forking)
	./scripts/init-platform.sh

test: ## Run the application test suite
	cd app && npm ci --silent && npm test

lint: ## Lint the Helm chart in both TLS modes
	helm lint $(CHART) --set ingress.host=$(DEMO_HOST)
	helm lint $(CHART) --set ingress.host=$(DEMO_HOST) --set ingress.tls.enabled=true

render: ## Render the chart as ArgoCD would for pull request 1
	@helm template preview-pr-1 $(CHART) \
		--set environment=pr-1 \
		--set prNumber=1 \
		--set ingress.host=$(DEMO_HOST)

tf-validate: ## Validate the Terraform for every supported cloud
	@for dir in infra/*/; do \
		echo "== $$dir"; \
		terraform -chdir="$$dir" init -backend=false -input=false >/dev/null; \
		terraform -chdir="$$dir" validate; \
	done

workflow-scripts: ## Syntax-check the JavaScript embedded in workflows
	./scripts/check-workflow-scripts.sh

alerts: ## Unit-test the Prometheus alert rules
	./scripts/check-alerts.sh

slugs: ## Check the Ruby and shell slug derivations agree
	./scripts/check-slug-agreement.sh

validate: test lint workflow-scripts slugs alerts tf-validate ## Everything that can be checked without a cluster
	@echo "All offline checks passed."

bootstrap: ## Install the platform onto the cluster in the current kube context
	@test -n "$(NODE_IP)" || { echo "usage: make bootstrap NODE_IP=<ip>"; exit 1; }
	./scripts/bootstrap-cluster.sh $(NODE_IP)

e2e: ## Run the end-to-end test against a throwaway kind cluster
	@test -n "$(IMAGE_TAG)" || { echo "usage: make e2e IMAGE_TAG=main-<sha>"; exit 1; }
	kind create cluster --name e2e --config scripts/kind-cluster.yaml
	@kubectl config use-context kind-e2e >/dev/null
	-./scripts/e2e-test.sh ghcr.io/devanksilswal/preview-app $(IMAGE_TAG)
	kind delete cluster --name e2e

dev-cluster: ## Create a local kind cluster with ports 80 and 443 mapped
	kind create cluster --name $(KIND_CLUSTER) --config scripts/kind-cluster.yaml

dev-bootstrap: ## Install the platform onto the local kind cluster
	DEV_CLUSTER=1 GITHUB_TOKEN="$$(gh auth token)" \
		./scripts/bootstrap-cluster.sh 127.0.0.1

dev-down: ## Delete the local kind cluster
	kind delete cluster --name $(KIND_CLUSTER)

azure-up: ## Provision the Azure VM and print the bootstrap command
	terraform -chdir=infra/azure init -input=false
	terraform -chdir=infra/azure apply

# Deallocating stops compute charges while keeping the disk and the static IP,
# which is what actually makes a student credit last. Stopping from inside the
# guest does not: Azure keeps billing a VM it still has reserved.
azure-stop: ## Deallocate the VM so it stops costing credit
	az vm deallocate -g gitops-k3s-rg -n gitops-k3s

azure-start: ## Bring the VM back up
	az vm start -g gitops-k3s-rg -n gitops-k3s

azure-down: ## Destroy everything in Azure
	terraform -chdir=infra/azure destroy

clean: ## Remove local build artefacts
	rm -rf app/node_modules infra/*/.terraform
