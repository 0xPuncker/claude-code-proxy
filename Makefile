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

docker-build: ## Build Docker image
	docker-compose build

docker-run: ## Run Docker container
	docker-compose up -d

docker-logs: ## Show Docker logs
	docker-compose logs -f

docker-stop: ## Stop Docker containers
	docker-compose down

docker-clean: ## Remove Docker containers and images
	docker-compose down -v
	docker rmi claude-code-proxy_claude-code-proxy

docker-restart: docker-stop docker-run ## Restart Docker containers

lint: ## Run linter
	npm run lint

format: ## Format code
	npm run format

all: install build test ## Install, build and test
