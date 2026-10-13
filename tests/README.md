# Runtime acceptance tests

`acceptance.py` is a black-box test runner using only the Python standard library and the host C compiler. It invokes the public CLI, performs actual reads/writes/connections, checks resulting bytes and process behavior, and returns nonzero for any failed required test. It does not read generated profiles as evidence that confinement worked. It also inspects the executing Node process and tests startup-environment isolation.

Run the suite from the repository root after building the binary:

```sh
python3 tests/acceptance.py \
  --runner "$PWD/bin/sandbox-runner" \
  --node /absolute/path/to/node \
  --report test-results/typescript/acceptance.json
```

Run outside an existing process sandbox: nesting restrictions can prevent macOS `sandbox-exec` or Linux user namespaces from starting. The runner remains inside its own tested OS boundary. Linux requires Bubblewrap, enabled unprivileged user namespaces, and a C compiler. Host IPv6 loopback support is mandatory for the full matrix; unavailable capabilities produce failures rather than silent passes.

`--only substring` is for diagnosis and sets `partial: true` in the JSON report. A partial result is not a release pass. Interpreter/entry identity is always observed, including partial runs. `--keep` retains fixtures for investigation. Normally every case receives separate fixture trees, and the suite removes them when done. Its fixtures are outside the runner installation so an ordinary allow-write fixture cannot accidentally authorize editing test infrastructure.

The current nonroot macOS matrix contains 52 required cases and one separately classified SIGKILL boundary observation. Linux root runs 51 required cases plus that observation: it adds the namespace/capability probe and does not run the macOS case-folding or nonroot DAC cleanup-failure cases. Linux nonroot also runs the cleanup-failure case. Missing platform coverage is not counted as a passing test.

Measure startup overhead and exercise a real interpreter/compiler separately:

```sh
python3 tests/benchmark.py \
  --runner "$PWD/bin/sandbox-runner" \
  --node /absolute/path/to/node \
  --report test-results/typescript/benchmark.json
```

The benchmark warms both paths five times, then alternates 30 direct and 30 sandboxed `/usr/bin/true` executions. It records all samples, median, p95, median added latency and aggregate child CPU. A separate compatibility smoke test uses Python JSON/SQLite/tempfiles/subprocess and compiles and runs a small C program inside the sandbox. These measurements describe the tested machine; they do not establish a performance service level or memory bound.

`--node` names the canonical Node executable selected by the generated launcher. Acceptance and benchmark inspect the running process and entry path: macOS uses `proc_pidpath` and `KERN_PROCARGS2`, and Linux uses `/proc/PID/exe` and `/proc/PID/cmdline`. `--runtime-root` can specify the package root explicitly.

## Evidence groups

| Contract | Independent checks |
|---|---|
| CLI and command semantics | Empty arguments, spaces, quotes, newlines, shell-looking literal text, binary stdin/stdout, exact stderr, command exit codes, command-generated signal |
| TypeScript startup | Host process executable is the expected Node at the required version and process arguments reference the compiled CLI; injected NODE_OPTIONS preload cannot execute before confinement |
| File effects | Allowed writes succeed; outside writes fail without changing bytes; host reads work; denied reads and writes fail; read-only mode; child interpreter remains restricted; cwd does not add permissions |
| Mutable paths | Outside-target symlink, protected-target symlink, protected ancestor rename, authorization-root rename, overlapping writable roots, identified pre-existing protected hardlink, newly created cross-boundary hardlink |
| macOS path aliases | Uppercase spelling in a file operation and uppercase spelling in a deny-write declaration both address the same underlying object without opening write access; the test requires a case-insensitive fixture volume |
| Validation | Unknown fields, unsupported network mode, relative paths, missing protection objects, unsupported scope and unsupported target-environment overrides fail before creating the payload marker |
| Environment | Dangerous inheritance names rejected; host-injected Python/Node/shell variables removed; a malicious Python startup hook never executes; target PATH is the documented fixed search path |
| Network | Actual local IPv4 and IPv6 TCP/UDP host listeners receive bytes in host mode and receive none in deny mode; socket creation denial and connection denial both enforce deny mode |
| IPC | Host pathname Unix socket denied with both network modes; anonymous stream socketpair works; datagram socketpair cannot reach a named host endpoint |
| FD capabilities | Inherited but unapproved low and high file descriptors are absent by inode identity, and no internal descriptors are present across FD 3–255 plus the process FD inventory; approved communication FD reaches the payload and a descendant after exec; invalid targets, duplicate assignments and file-handle grants rejected |
| Node FD bootstrap | Absent caller source descriptors 3–16 cannot be substituted by Node/libuv-created channels; same-number, swapped source/target, high-source (192 or higher), target 64, and two low-number target channels retain actual bytes; authorized descendant communication remains valid |
| Lifecycle | Already expired deadline prevents spawn effects; running timeout escalates past ignored SIGTERM; signal handler exit code is retained; caller death ends execution; leader exit stops the remaining group; parallel runs have unique temp directories; cancelling one leaves another running |
| Results and cleanup | A payload can write a side effect, forge runtime-looking stderr, and retain its real exit code; actual permission-induced cleanup errors retain both zero and nonzero payload exits and report cleanup failure |
| Optional diagnostics | Explicit diagnostics contain only redacted event fields, omit seeded argv/environment secrets, keep a consistent run ID and policy digest, and preserve exact payload stdout bytes and exit code; shared stderr remains unauthenticated |
| Trusted installation | A copied complete TS deployment under a broad allow-write root retains the launcher overwrite/rename checks and additionally protects every deployed JavaScript file, package metadata and the deployment directory itself; creating a new module beneath `dist/` also fails |
| Low-level surfaces | macOS fcntl commands 80 and 110; Linux AF_VSOCK and io_uring_setup; host baseline outcomes recorded separately; protected bytes unchanged |
| Linux process state | New PID namespace, zero effective capabilities, and no_new_privs observed by the payload |

`syscall_probe.c` exists because these low-level operations are not adequately represented by ordinary file or connection probes. The report includes both host and confined results. A host EPERM (for example, from a container's outer seccomp profile) is not independent proof of this runner's filter; backend filter tests and a suitable Linux test environment remain necessary.

## Coverage boundaries

- A successful macOS run does not establish Linux support, or conversely. Reports record platform, effective UID, interpreter and observed behavior. Run the suite separately on each target platform.
- Permission-induced cleanup failure is tested for nonroot users. Linux container root bypasses directory discretionary permissions, so this case is not run under UID 0 and is not counted as passing. Run as a nonroot account to obtain that evidence. The test intentionally creates a temporary cleanup error, then verifies run ID, owner UID, expected root and unpredictable marker before removing the exact owned leftover.
- The macOS backend controls the managed process group. Arbitrary descendants that deliberately detach from that group are outside the cleanup guarantee. Runner SIGKILL cannot execute cleanup code; stale resources are not automatically deleted based only on a PID. The explicit SIGKILL probe reports `observed_limitation`, which is excluded from the passing-test count. It records leftover temp and continuing payload heartbeat, then kills only its previously recorded owned host process group and removes its exact verified resource. It never labels unconditional cleanup as passing.
- Local UDP probes verify direct packet egress, including DNS-like UDP traffic. They do not certify a host's system resolver, caches, external DNS infrastructure or a public Internet route.
- Existing unknown cross-boundary hardlink aliases are a deployment constraint; one identified protected-alias test is not a general inode-isolation proof.
- DSH Provider contract tests are separate from this CLI suite. Actual Bash background jobs, installed PTC protocol behavior and PTY interaction require end-to-end consumer tests before those combinations can be marked supported.
- Fault injection for unavailable dependencies, cancellation at specific preparation barriers, cleanup reentrancy and setup rollback belongs in backend/runner unit tests or a controlled host fixture. This suite's invalid-policy marker and expired-before-spawn checks do not replace all such injections.
- There is no claim of resource exhaustion resistance, hostile same-UID host isolation, minimum-OS certification or adversarial kernel resistance.

The adversarial cases use only files and listener endpoints created by the test. They do not contact public services or modify system proxy settings.
