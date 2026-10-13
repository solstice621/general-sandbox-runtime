# DSH Bash adapter

This adapter targets DeepSeek Harness commit `d743267388641bc76f17c45ce8b4c231aed1d32c` and Node.js 24.19.0 or newer. Production adapter and runtime code are TypeScript; the root strict NodeNext build emits the executable JavaScript and type declarations into `dist/`. It replaces the Bash executor using the existing `SandboxBashExecutor` and `LocalSubprocessRuntime`. It does not modify the user's installed DSH.

## Installation

Run `npm run build` from the runtime root, then install the complete runtime tree and generated `bin/sandbox-runner` launcher at a trusted, canonical absolute path **outside every writable workspace**. Its file must have one hard link and must not be writable by group or others. Keep this adapter and the DSH installation outside writable workspaces as well; include any workspace-resident trusted control files in `denyWrite`.

Installation guards compare filesystem device/inode identities through ancestor paths, including aliases on case-insensitive filesystems. The plugin derives and protects the entire enclosing DSH monorepo or outer `node_modules` tree from its package locations. A writable grant to a different package such as approvals is therefore rejected too. An unrecognized deployment layout fails closed. These checks do not replace the caller's own `denyWrite` configuration for trusted workspace control files.

In a trusted DSH composition that already provides `subprocess` with the pinned `LocalSubprocessRuntime` and `sandboxPolicy`, replace the existing Bash executor plugin with:

```js
import { createBashOnlyPlugin } from '/trusted/sandbox-runtime/dist/adapters/dsh/plugin.js'

await ctx.plugin(createBashOnlyPlugin({
  scope: 'bash-only',
  runnerPath: '/trusted/sandbox-runtime/bin/sandbox-runner',
  network: 'deny',
  denyRead: [{ path: '/existing/private/data', scope: 'tree' }],
  denyWrite: [{ path: '/existing/workspace/trusted-config', scope: 'tree' }],
}, { graceMs: 3000 }))
```

The DSH packages imported by `plugin.js` must resolve from the **same pinned DSH installation** as the host composition. When packaging, install the runtime beside those packages or provide the host's module-resolution mechanism. This is a composition module, not a claim that copying a JSON option into any DSH release installs it. Standard Bash tools can continue to consume `ctx.shell`.

The installer creates private `sandbox` and `subprocess` scopes and captures the constructed Bash executor's context. Cordis normally rebinds service contexts to the caller; the bound method prevents a root `ctx.shell.execute()` call from accidentally selecting the shared services. An `AsyncLocalStorage` invocation record and one-shot argv identity link preparation to launch, including concurrent calls. The shared provider and subprocess remain unchanged for other consumers.

Never register `RuntimeSandboxProvider` as the shared DSH provider. The core mapper's returned argv is insufficient without the safe launch boundary. `scope: 'shared'`, PTC, and PTY installation requests are rejected. The private subprocess rejects terminal operations and control pipes. Existing PTC/PTY consumers keep their original providers; they gain no protection from this adapter. Native file tools, MCP, and direct subprocess calls are likewise outside this adapter's coverage.

## Environment and policy

`read-only` maps to no ordinary writable paths and no private temp. `workspace-write` maps to the resolved workspace directory and a unique Runner temp directory. The adapter imports the shared `Policy`/`Rule` contracts and `validatePolicy` from `src/policy.ts`; it does not maintain a separate runtime policy schema. Both modes include the configured deny rules, host-readable files, the chosen `deny`/`host` network mode, and denied host Unix sockets. `danger-full-access` retains DSH's explicit complete bypass, including its original environment behavior; Runner failure never triggers that mode automatically.

The generated launcher invokes a canonical absolute Node executable, so a scrubbed PATH cannot select an untrusted Node. Runner launches with fixed `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `LANG=C`, `LC_ALL=C`, `TERM=dumb`, and `HOME` resolved from the OS user record. The subprocess wrapper removes both ambient variables and DSH's synthesized proxy variables before applying these values. No model/caller environment overrides are accepted in confined mode. This may limit tools that need custom PATH, proxies, credentials, or application startup options; such support needs an explicit future contract.

Known trusted Bash metadata (`DSH_HOME`, `DSH_SHELL=1`, `DSH_SESSION_ID`, `DSH_PROFILE`, `DSH_PROFILE_DIR`) is validated before merging. The adapter adds it to the **payload** using absolute `/usr/bin/env` after the OS boundary is applied, along with fixed terminal settings. It never affects Runner's loader. This metadata appears in argv and must contain only the documented nonsecret paths and identifiers. Unknown plugin-contributed DSH keys are refused. Arbitrary credentials are never accepted as adapter configuration or environment overrides.

The provider runs bounded `check --policy-json JSON` with cancellation and validates its JSON response. `run` rechecks before executing. Policies contain no environment values or secrets, remain per-call immutable, and are capped at 64 KiB. No temporary policy file is created. Minimum DSH termination grace is 3000 ms, longer than Runner's default 500 ms termination window. DSH still owns execution deadlines, foreground waits, background handles, job termination, output, and disposal.

`runnerFailureRules` is always empty. A failed payload can print any stderr, so fatal-looking text never proves that no command ran. Denial signatures are advisory DSH display metadata only. Preparation errors have structured adapter codes; runtime setup failures can remain ordinary command failures. They must not trigger automatic retries based on an assumption of no side effects.

## Reproduce tests

Tests import the freshly compiled adapter in `dist/adapters/dsh/`; build before running them. Provider tests need no runtime DSH dependency:

```sh
npm run build
cd adapters/dsh
node --test test/provider.test.js
```

Extract the public archive recorded in `source-lock.json` into a separate directory, verify its `archiveSHA256`, then set `DSH_SOURCE_ROOT` to the extraction root. The test loader verifies hashes of the exercised integration surfaces and resolves DSH workspace packages to their unchanged source. For executor-only testing, it narrows the unrelated LLM export barrel to its original `HarnessError` module because Node's type transform does not support the barrel's unused decorators. No source patch or installed-app mutation is performed.

```sh
DSH_SOURCE_ROOT=/absolute/pinned/dsh npm run test:upstream
DSH_SOURCE_ROOT=/absolute/pinned/dsh \
SANDBOX_RUNNER=/absolute/trusted/bin/sandbox-runner npm run test:real
```

`test:upstream` uses a clearly marked passthrough fixture Runner to isolate DSH plumbing. It proves no OS isolation. `test:real` requires the actual Runner and does not skip when confinement fails. The seven upstream tests cover real Bash/local-subprocess foreground and background execution, standard streams, exit results, both modes, trusted metadata, hostile ambient environment, stderr spoofing after a side effect, deadlines, kill, preparation cancellation, grace validation, full-access bypass, and refusal of writable grants to unrelated DSH packages. Three additional real-Runner tests check actual allowed/denied writes, child inheritance, and concurrent policies.

The registered-tool suite additionally needs the test-only TypeScript 5.9.3 compiler and Zod 4.4.3 archives recorded in `source-lock.json`. Extract and verify the archive hashes, then run:

```sh
DSH_SOURCE_ROOT=/absolute/pinned/dsh \
DSH_TYPESCRIPT_LIB=/absolute/typescript-5.9.3/lib/typescript.js \
DSH_ZOD_ROOT=/absolute/zod-4.4.3 \
SANDBOX_RUNNER=/absolute/trusted/bin/sandbox-runner npm run test:tools
```

Use the same environment with `npm run test:all` to run all 25 tests, including provider and real-Runner suites. This mode transpiles original source with the standard TypeScript compiler and loads the full original LLM barrel, without the executor-only shortcut. Dependencies are isolated test inputs; installing or modifying a user DSH application is unnecessary.

The seven registered-tool tests exercise the real upstream ToolRuntime, `tool-bash`, job registry, `tool-jobs`, approval service, session policy/projections, and shell-environment registry through the actual plugin installation. They verify foreground wait timeout promotes the same job, `job_output` retrieves its completion, `job_kill` stops it with the default 3000 ms termination grace available, fatal stderr cannot invent a no-execution claim, one approved write does not widen the next call, rejection blocks execution, session mode changes take effect, foreground-only execution deadlines stop work, and cancellation of an active foreground wait stops its owned job.

Agent identity, session event storage, and working-directory service are structural in-memory fixtures. The **real approval service receives a simulated `allowed-once`/`rejected` answer through its registered approval event**; this is not a human approval UI or LLM conversation test. Executor-only tests use an already-resolved policy fixture, while registered-tool tests use the actual policy resolver and projection registry.

PTC/PTY remain explicitly unsupported; they are not counted as passing tests. The Linux DSH suite may use upstream's declared PGID fallback when its systemd scope infrastructure is unavailable; process-scope containment and this Runner's namespace sandbox are separate properties. macOS process-group limitations likewise remain. See `test-evidence.json` and the repository acceptance report for tested platform combinations and source/build hashes.

Final frozen TypeScript macOS run: **25 passed, 0 failed, 0 skipped**, on Node 24.19.0 and macOS 26.6.2/arm64. The actual case-insensitive filesystem alias regression executed. A hostile `NODE_OPTIONS` preload marker never executed. Evidence is `test/final-macos.tap`; `test/final-macos.json` records the complete runtime/adapter source and compiled closure, launcher, Node executable, and test-source hashes.

Final frozen TypeScript Linux run: **25 passed, 0 failed, 0 skipped**, on Debian 12/aarch64, Linux 6.10.14-linuxkit, Bubblewrap 0.8.0, Node 24.19.0, ordinary named UID 1000. Evidence is `../../evidence/typescript/dsh-linux.tap`; the deployment closure is recorded in `../../evidence/typescript/linux-acceptance.json` under `runtime_identity` (SHA256 `fe1cf367542f17ca10a7d8a7495c25e4b3fa5725d5f5613afa7a1d403dd1d60d`). All 37 shared compiled runtime/adapter/package artifacts compared with macOS match byte for byte; platform launchers and Node binaries differ. Linux's filesystem is case-sensitive, and its symlink/inode identity regression executed. Upstream DSH's optional native systemd/cgroup helper was not validated; this result does not establish native cgroup containment. The runtime's PID namespace boundary was exercised independently.

The Go 0.1.0 results and intermediate TypeScript discovery logs have been retired. They are not mixed with the final TypeScript evidence.

`pinned-dsh.d.ts` is a narrow build-time declaration of the audited upstream contracts. It retains the difference between raw plugin options and Cordis-validated volatile constructor settings, the mutable upstream `ConfinedArgv` type (frozen by this adapter at runtime), readonly subprocess argv, and environment tombstones. These declarations supply no runtime code and do not replace the actual pinned DSH source used by the integration tests.
