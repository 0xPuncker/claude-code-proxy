.PHONY: help build dev test docker-build docker-run docker-stop docker-clean install

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install dependencies
	npm install

build: ## Build TypeScript
	npm run build

dev: ## Run in development mode
	npm run dev

test: ## Run tests
	npm test

podman-build: ## Build image with podman compose
	podman compose build

podman-run: ## Run containers with podman compose
	podman compose up -d

podman-logs: ## Show container logs
	podman compose logs -f

podman-stop: ## Stop containers
	podman compose down

podman-clean: ## Remove containers and images
	podman compose down -v
	podman rmi claude-code-proxy-cc-proxy:latest 2>/dev/null || true

podman-restart: podman-stop podman-run ## Restart containers

lint: ## Run linter
	npm run lint

format: ## Format code
	npm run format

all: install build test ## Install, build and test
