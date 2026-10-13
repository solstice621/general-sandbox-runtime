# OpenCode Bash plugin

Install together with `@solstice621/sandbox-runtime@0.3.0`. The audited host is OpenCode **2.0.14**, using its v2 plugin API. Register this package in `plugins` with `mode: workspace-write` or `read-only`; network defaults to `deny`.

The plugin hooks native shell creation, keeps the original command visible to permissions, and selects a generated Bash wrapper. The shared runtime prepares the policy under Node even though OpenCode runs on Bun. Output, background jobs, timeout and cancellation stay native.

Use the repository's `scripts/install-plugins.py` and `opencode-sandbox` launcher. See `PLUGINS.md` for coverage limits and the startup API caveat.
