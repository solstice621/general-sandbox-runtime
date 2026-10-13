# DSH Bash adapter

Use the installable `@solstice621/sandbox-runtime-dsh` bundle and [shared installer](../../PLUGINS.md). The tested host is the published DSH 0.2.1-alpha.2 package.

For a custom trusted composition:

```ts
import { createBashOnlyPlugin } from '@solstice621/sandbox-runtime/dsh'

await ctx.plugin(createBashOnlyPlugin({
  runnerPath: '/trusted/sandbox-runtime/bin/sandbox-runner',
  network: 'deny',
  denyRead: [{ path: '/existing/private/data', scope: 'tree' }],
  denyWrite: [{ path: '/existing/workspace/trusted-config', scope: 'tree' }],
}))
```

Resolve the adapter's DSH imports from the host installation. The plugin installs private sandbox and subprocess services for the Bash executor. An invocation-local record ties each prepared argv to its launch; other consumers keep their original services. Preparation builds the policy and command arguments. The runner checks OS support when executing the command.

The native Bash executor retains policy resolution, approval, output handling, cancellation, timeout and jobs. `read-only` and `workspace-write` use the shared runtime; DSH's explicit `danger-full-access` remains an unconfined bypass. Runtime failure never selects that bypass automatically. Error text is not treated as evidence that a command had no side effects.

PTC, PTY, native file tools, MCP and direct subprocess calls are outside this Bash integration. The private subprocess rejects terminal operations. Install the runtime, host and dependencies outside writable workspaces. The adapter cleans the launch environment before starting the runner.

Run the actual registered-tool and executor suites against an installed host:

```sh
python3 scripts/test-dsh-installed.py --prefix /absolute/installed/library --report /absolute/test-results/dsh.tap
python3 tests/plugins/dsh_profile_acceptance.py --prefix /absolute/installed/library --work-root /absolute/fixtures --report /absolute/test-results/profile.json
```

Tests drive the actual host policy and approval services with deterministic responses; no model or human approval UI is involved. macOS process-group limits and the runtime's SIGKILL cleanup limits still apply. Linux tests use the runtime's PID namespace; they do not require or establish DSH's optional native cgroup containment.

In 0.4, `RuntimeClient` from `@solstice621/sandbox-runtime/client` replaces the old provider wrapper. Remove `scope` and `checkTimeoutMs` from adapter configuration. Bash scope is fixed by this adapter, and preparation no longer launches a separate preflight process.
