# Runtime and upstream design references

Sandbox Runtime implements its production core, policy validation, platform
backends, Linux supervisor, and DSH adapter in TypeScript. The build emits ESM
JavaScript and type declarations. A minimal shell launcher binds a trusted Node
executable and checks raw caller FD grants before Node initializes its own
descriptors. There is no Go runtime, custom native production helper, or embedded
upstream sandbox runtime.

Node.js 24.19.0 or newer, macOS `/usr/bin/sandbox-exec`, and Linux
`/usr/bin/bwrap` are external runtime components. The source package does not
bundle their executables. TypeScript and `@types/node` are pinned build-only
dependencies; their exact resolved versions and notices are available through
`package-lock.json` and the installed packages. DSH integration obtains the
DSH packages from its trusted host installation. Python and the C syscall
probe are validation tools, not production runtime dependencies.

The architecture uses public operating-system interfaces and fixed upstream
implementations as research references:

- OpenAI Codex, commit `816fa702ec66a4c81b204701a03371a1ac3511e6`, Apache-2.0:
  [repository](https://github.com/openai/codex/tree/816fa702ec66a4c81b204701a03371a1ac3511e6).
  Seatbelt operation selection, ancestor unlink protection, and fcntl 80/110
  protections informed the macOS compiler.
- Anthropic Sandbox Runtime, commit
  `24eb39e94a6de386e83d126c52317d8e0fa49522`:
  [repository and license](https://github.com/anthropics/sandbox-runtime/tree/24eb39e94a6de386e83d126c52317d8e0fa49522).
  Used as a research reference for platform boundaries and lifecycle tradeoffs;
  not embedded as a runtime dependency.
- DeepSeek Harness, commit `d743267388641bc76f17c45ce8b4c231aed1d32c`:
  [repository](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c).
  The adapter imports its public package APIs. Integration tests use the
  published host packages installed from the npm lockfile.
- [Bubblewrap](https://github.com/containers/bubblewrap) supplies Linux namespace,
  mount, capability and seccomp setup as an external system dependency. The
  host must support the namespaces and seccomp features used by the runtime.

Preserve upstream license notices if subsequently vendoring code or external
executables. No independent license choice for this newly authored project has
been inferred on the user's behalf.
