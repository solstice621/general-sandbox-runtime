NODE ?= node
NPM ?= npm
PYTHON ?= python3

.PHONY: install build test typecheck acceptance benchmark

install:
	"$(NPM)" ci

build:
	"$(NODE)" scripts/build.ts

test: build
	"$(NODE)" --test dist/test/*.test.js

typecheck:
	"$(NODE)" node_modules/typescript/bin/tsc --noEmit

acceptance: build
	"$(PYTHON)" tests/acceptance.py --runner "$(CURDIR)/bin/sandbox-runner" --node "$$('$(NODE)' -p 'require("node:fs").realpathSync(process.execPath)')" --report test-results/ts-local-acceptance.json

benchmark: build
	"$(PYTHON)" tests/benchmark.py --runner "$(CURDIR)/bin/sandbox-runner" --node "$$('$(NODE)' -p 'require("node:fs").realpathSync(process.execPath)')" --report test-results/ts-local-benchmark.json
