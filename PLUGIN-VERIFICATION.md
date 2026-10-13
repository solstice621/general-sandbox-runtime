# 0.3.0 verification — 2026-10-14

The installable DSH and OpenCode plugins have been exercised from the **three shipped npm tarballs**, with the included host dependency lock and generated launchers. Both actual hosts were tested on macOS arm64 and Linux arm64. Personal DSH/OpenCode configuration was not changed; these were isolated installations and deterministic native-tool tests, not live model conversations.

| Verification | macOS arm64 | Linux arm64 |
|---|---:|---:|
| Runtime unit cases | 72 pass, 1 not applicable | 71 pass, 2 not applicable |
| Runtime OS acceptance | 52 pass | 52 pass |
| Published DSH native executor/tool services | 25 pass | 25 pass |
| Actual DSH CLI/profile/bundle | 2 pass | 2 pass |
| Actual OpenCode CLI/native shell/tool services | 18 pass | 18 pass |
| Install, existing-config preservation and uninstall | 9 pass | 9 pass |

All executed cases passed. The unit omissions are platform-specific: the non-macOS availability case on macOS; the macOS backend and case-insensitive filesystem cases on Linux. The separate SIGKILL boundary observation is retained in each runtime acceptance JSON and is **not** counted as a successful cleanup guarantee.

## What the tests establish

- DSH's published `0.2.1-alpha.2` CLI composes and boots the installable bundle, disables/replaces the original Bash executor, permits workspace writes and rejects writes outside it and in read-only mode. Its native registered Bash/job tools preserve foreground output, status, promotion to background, cancellation, deadlines, job output/kill, session policy changes and one-shot/rejected approvals.
- OpenCode **2.0.14** loads the packed v2 plugin in its actual compiled Bun host. Its real registered ShellTool and native shell service preserve quoted command strings, stdout/stderr, exits, approval resources, one-shot/rejected decisions, output truncation, background completion and AbortSignal cancellation. Checked file effects establish allowed/denied writes and fixed workspace boundaries; loopback TCP and hostile environment inheritance are denied.
- OpenCode's wrapper rejects execution without a prepared policy. The default-shell guard is checked with the runtime plugin absent; invalid plugin options also fail before any payload side effect. No test silently substitutes an ordinary shell for a failed sandbox.
- Installation uses the exact host dependency lock through `npm ci`, validates tarball/lock hashes, binds the current Node executable, creates a dedicated DSH profile and separate startup commands, and preserves existing OpenCode inline permission/plugin settings. Reinstallation cannot overwrite an existing prefix. Uninstall refuses modified configuration before partial removal and preserves session/auth state and unrelated DSH files.

The native approval services receive simulated test replies; no human approval dialog or model API was exercised. DSH executor-only fixtures use a resolved policy, while registered-tool cases use the real upstream policy and approval services. OpenCode's test-only plugin invokes the registered native ShellTool and supplies session/permission requests; it does not implement a replacement shell executor.

## Provenance and reproducibility

- macOS: **26.6.2 (25G83), arm64, Node 24.19.0** and the user's installed OpenCode 2.0.14 binary.
- Linux: **6.10.14-linuxkit, Debian 12, aarch64, Node 24.19.0, Bubblewrap 0.8.0, ordinary named UID 1000**. Disposable Docker fixture based on cached `redis:7.4`; no host bind mounts. Outer namespace setup used `SYS_ADMIN` and relaxed outer seccomp/system paths; runtime workloads still use the runtime's own capability, mount, namespace and seccomp restrictions. The fixture and its anonymous volume were removed after evidence capture.
- Official Linux Node archive SHA-256: `01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc`.
- Official OpenCode Linux binary came from `@opencode/cli-linux-arm64@2.0.14`; npm SHA-512 integrity was verified before extracting it. Binary SHA-256: `525f24ec428dcc71bbaebccc7b2fa1ec3910bfd4c3be9cda9c288a9e5fe3a406`.
- Both installed-code identity reports assert byte equality with every regular tarball file except generated `bin/` launchers; those launchers are hashed separately after binding. The installed host lock matches the shipped lock byte for byte.

| Artifact | SHA-256 |
|---|---|
| Runtime tarball | `430ab0d4099f860921d9d90e9c360d49b8fbbc446de311282abcc0e2aba26853` |
| DSH plugin tarball | `6993211c6c6aeef874fcf6dd60509999d3ef96e31f0848abbfad53e1df908b31` |
| OpenCode plugin tarball | `e8f8fb7ca75bfa35ece85259ecce6284841772fb4e876da6e27484abc6773c24` |
| Host dependency lock | `f44a6f759b309f43e4fe9f8fa82161146b50a610a70f9f616f81a45a8dc4c8a8` |

Runtime full-build closure SHA-256: macOS `cbf7465779002e16988065ef345240b8fe94c930b82d5095db1d0b416835140e`; Linux `4a620c0126759eefe971e81c5717d8e808730e3dd7d555b991256e3aa22a433b`. These closures include the bound Node/launcher and full build output; the smaller npm deployment closures are independently recorded in `evidence/plugins/*-installed-identity.json`. All shared deployed/metadata artifacts from the full runtime reports still match the delivered source-tree build byte for byte.

Machine-readable evidence is under [evidence/plugins](evidence/plugins/): platform-specific runtime unit TAP, runtime acceptance JSON, DSH tool TAP, DSH profile JSON, OpenCode JSON, installer JSON and installed-code identity JSON. [PLUGINS.md](PLUGINS.md) provides installation, exact reproduction commands and coverage limits.

## Limits

This release certifies the tested Bash paths and host versions. It does not certify Windows, Linux x64 execution, OpenCode v1, other DSH/OpenCode versions, live LLM orchestration, native file tools, MCP, PTC or a sandboxed PTY. DSH's explicit `danger-full-access` remains unconfined. Host/plugin/configuration code must remain trusted; workspace auto-loaded configuration/plugins are outside a Bash-only boundary. The generated OpenCode guarded shell rejects unsupported interactive invocation forms.

The runtime's existing macOS process-group/SIGKILL limitations remain. Native DSH systemd/cgroup containment was not certified; its declared process-group fallback and this runtime's namespace confinement are separate properties. No new performance benchmark was run for 0.3.0. The frozen `REPORT.md` body, `evidence/typescript/` and `test-results/typescript/` describe **0.2.0** and must not be relabeled as this release's measurements.
