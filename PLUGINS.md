# DSH and OpenCode Bash plugins — 0.4.0

One TypeScript runtime, two thin host adapters. The downloadable npm tarballs are private/local installation artifacts; this release does not publish them to the npm registry.

| Component | Tested version / entry |
|---|---|
| Runtime | `@solstice621/sandbox-runtime@0.4.0`, Node **24.19.0+** |
| DSH bundle | `@solstice621/sandbox-runtime-dsh@0.4.0`, **DSH 0.2.1-alpha.2** |
| OpenCode plugin | `@solstice621/sandbox-runtime-opencode@0.4.0`, **OpenCode 2.0.14** |
| macOS backend | system `/usr/bin/sandbox-exec` |
| Linux backend | non-setuid `/usr/bin/bwrap`, namespaces and seccomp |

The installation lock selects DSH 0.2.1-alpha.2. OpenCode 2.0.14 is the tested host; its version string is not used as a runtime gate. Other host versions require compatibility testing. OpenCode v1 uses a different plugin API.

## Install and launch

Download/extract the complete 0.4.0 release. It includes `artifacts/`, `installation/` and `scripts/`. Have the supported Node, npm, Python 3 and OpenCode installed. The installer uses `npm ci` with the included host dependency lock, suppresses dependency lifecycle scripts, and binds the runtime launchers to the selected Node. DSH is installed privately beside the runtime. It does not replace the user's existing DSH or OpenCode executable.

On this macOS machine:

```sh
python3 scripts/install-plugins.py install \
  --opencode "$HOME/.opencode/bin/opencode" \
  --proxy http://proxy.sha.sap.corp:8080
```

Use the proxy option only while the SAP proxy is reachable. Other environments can omit it. The installer does not change system or npm proxy settings. To reuse an existing DSH home and its authentication/settings, add `--dsh-home "$HOME/.dsh"`; otherwise it creates an isolated DSH home below the installation prefix. Both choices create a **new** `sandbox-runtime-web` profile. Existing profile/home patches are preserved.

Default macOS installation prefix: `$HOME/Library/Application Support/sandbox-runtime/0.4.0`. Linux defaults to `$HOME/.local/share/sandbox-runtime/0.4.0`. `--prefix /absolute/path` changes it. The prefix, DSH home and host installations must be outside writable workspaces; overlapping workspaces fail rather than receive broader rights.

From the project directory you want to work in:

```sh
"$HOME/Library/Application Support/sandbox-runtime/0.4.0/bin/dsh-sandbox"
"$HOME/Library/Application Support/sandbox-runtime/0.4.0/bin/opencode-sandbox"
```

Optional interactive aliases (add them to your own shell configuration if desired):

```sh
alias dsh-sandbox='"$HOME/Library/Application Support/sandbox-runtime/0.4.0/bin/dsh-sandbox"'
alias opencode-sandbox='"$HOME/Library/Application Support/sandbox-runtime/0.4.0/bin/opencode-sandbox"'
```

The default policy permits writes within the invocation's workspace and denies network access. `--mode read-only` selects a read-only default. `--network host` explicitly enables host networking. Confined payloads receive a fixed system PATH and a small clean environment; proxy settings, tokens, Node loader options and arbitrary host environment variables do not reach them. Host LLM/network access remains the host's responsibility.

`dsh-sandbox` opens the dedicated web profile and forwards extra web arguments. `opencode-sandbox` forwards normal CLI arguments. The latter merges its plugin into `OPENCODE_CONFIG_CONTENT`, preserves existing permission/plugin entries, and selects a guarded default shell. The ordinary `dsh` / `opencode` commands are unchanged. **Use the generated launchers to enable this installation.**

Uninstall with the same prefix:

```sh
python3 scripts/install-plugins.py uninstall \
  --prefix "$HOME/Library/Application Support/sandbox-runtime/0.4.0"
```

Uninstall removes owned packages, launchers and generated configuration, including configuration you edited; session/auth state and unrelated DSH files remain. It does not overwrite an existing installation, edit `.zshrc`, or change global OpenCode configuration. If installation fails, newly created installation/profile files are rolled back.

## Integration behavior

DSH's bundle disables its original `bash-sandbox` row and installs a private Bash executor. Native permission handling, session policy resolution, standard streams, output limits, timeouts, cancellation and jobs stay with DSH. Its explicit `danger-full-access` mode remains an **unconfined DSH bypass**, never an automatic fallback for runtime errors.

OpenCode hooks `shell.create.before` and replaces the executable while retaining the exact command string. Native permission scanning therefore sees the user's original command; one-shot approvals, denial, output truncation, background handles and cancellation retain native behavior. Its Bun host delegates policy preparation to the bound Node CLI. Each command gets an independent immutable policy and runner.

The OpenCode launcher also chooses the wrapper as the configured/default shell. Without a successful plugin preparation, that wrapper exits 125. This protects the normal Bash path when a plugin is absent and while plugins initialize. An invalid option or failed policy preparation produces an error. There is no ordinary-shell fallback. Manual plugin installations must configure the same default-shell guard; a plugin hook alone does not protect requests made before asynchronous activation.

## Coverage and trust boundary

This is **Bash command confinement**, not a sandbox around either entire application. Native file tools, other plugins, MCP, arbitrary direct child-process calls, PTY/persistent terminals and the host's own startup/configuration evaluation are not certified by these plugins. The OpenCode guarded default shell rejects interactive/PTY invocation forms; this release does not provide a sandboxed interactive terminal. DSH PTC/PTY consumers retain their own existing providers.

Host/plugin code, configuration, installation directories and approved policy choices are trusted. In particular, project auto-loaded plugins/configuration can execute in the host: putting them inside an agent-writable workspace is not made safe by installing this Bash adapter. Protect such control files with explicit deny rules or keep them outside writable roots. OpenCode's direct shell API with an explicitly supplied alternate shell, or a later trusted hook that replaces our values, is outside the generated launcher's normal guarded tool path.

The default permits host-readable files; it is not a secrets-reading denylist. Use `denyRead` / `denyWrite` runtime rules when needed. Do not treat a failing exit code or fatal-looking stderr as proof that no payload side effect occurred. macOS cannot guarantee descendant cleanup after the runner itself receives SIGKILL; the runtime README describes this boundary.

The delivered artifacts and tests do not activate plugins in the user's personal profiles. Installation tests use isolated host trees and existing-config fixtures. No model API or human approval UI is exercised: native tool/approval services are driven by deterministic test clients.

## Reproduce

```sh
npm ci
python3 scripts/pack-plugins.py
python3 tests/plugins/installer_acceptance.py --opencode /absolute/opencode \
  --cache /absolute/npm-cache --work-root /absolute/fixtures --report /absolute/installer.json
python3 tests/plugins/dsh_profile_acceptance.py --prefix /absolute/installed/library \
  --work-root /absolute/fixtures --report /absolute/dsh-profile.json
python3 tests/plugins/opencode_acceptance.py --opencode /absolute/opencode \
  --prefix /absolute/installed/library --work-root /absolute/fixtures --report /absolute/opencode.json
```

Install once online to populate the npm cache before the offline installer test. The DSH registered-tool tests in `adapters/dsh/test` also run directly against the published host packages; `scripts/test-dsh-installed.py` stages these test-only files beside the installed runtime for module resolution. Current test results are summarized in `README.md`. Test reports are generated locally; release packaging does not depend on stored result counts or hash manifests.

Sources: [DSH CLI](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/apps/cli), [OpenCode v2 plugin API](https://opencode.ai/v2/docs/build/plugins/). Current behavior was verified against published DSH packages and the actual OpenCode 2.0.14 binary/source, not inferred only from documentation.
