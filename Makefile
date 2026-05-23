.PHONY: build test lint format clean help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

build: ## Compile TypeScript to dist/ (excludes tests)
	npx tsc -p tsconfig.build.json

test: ## Run vitest
	npx vitest run

typecheck: ## Type-check including tests
	npx tsc --noEmit

lint: ## Prettier check
	npx prettier --check .

format: ## Prettier write
	npx prettier --write .

clean: ## Remove build artefacts
	rm -rf dist node_modules
