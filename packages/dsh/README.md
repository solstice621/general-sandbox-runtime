# DSH Bash plugin

Install together with `@solstice621/sandbox-runtime@0.4.0` and DSH (tested with `@deepseek-ai/dsh@0.2.1-alpha.2`). Add this package after `@deepseek-ai/dsh-base` in `dsh.profile.bundles`. Its bundle disables `bash-sandbox` and registers `sandbox-runtime-bash`. The host's resolved policy, approval, output and job behavior remain in charge.

Use the repository's `scripts/install-plugins.py` for an isolated installation and `dsh-sandbox` launcher. Full instructions, version constraints and coverage limits are in `PLUGINS.md`.
