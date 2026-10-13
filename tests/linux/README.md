# Linux validation

The TypeScript runtime requires Node.js 24.19.0 or newer, executable non-setuid `/usr/bin/bwrap`, and working user, PID, IPC, UTS and mount namespaces plus seccomp. Network-deny mode also creates a network namespace. Static `check` validates the helper and supported policy; actual Bubblewrap setup validates kernel capabilities before invoking the trusted namespace supervisor or workload. Failure never falls back to ordinary execution. This implementation does not use pidfd process-group signaling and does not claim a minimum certified kernel release.

The tested environment is native arm64 Linux 6.10.14-linuxkit in the Docker Desktop VM, Debian 12, glibc 2.36, Bubblewrap 0.8.0, ordinary named UID 1000 and official Node.js 24.19.0. Linux x64 syscall tables have bytecode tests; native x64 acceptance has not been run. Historical Go reports do not establish TypeScript behavior.

Writes overlapping `/proc`, `/dev`, `/sys`, system installation trees (`/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`) or dynamic-loader configuration are unsupported. The installation root, selected Node executable and backend helpers are protected. The DSH adapter additionally rejects writable overlap with its discovered dependency roots.

## Native Linux

Install Node.js 24.19.0+, Bubblewrap, Python 3, a C compiler and libc headers. Build in a trusted directory outside writable workload fixtures:

```sh
npm ci
npm run build
node --test dist/test/*.test.js
python3 tests/acceptance.py --runner "$PWD/bin/sandbox-runner" --node /absolute/selected/node --report evidence/typescript/linux-acceptance.json
python3 tests/benchmark.py --runner "$PWD/bin/sandbox-runner" --node /absolute/selected/node --report evidence/typescript/linux-benchmark.json
python3 tests/linux/supervisor_acceptance.py --runner "$PWD/bin/sandbox-runner" --node /absolute/selected/node --report evidence/typescript/linux-supervisor-acceptance.json
```

The build prints the exact Node path embedded in the launcher; pass that path to `--node`. Run acceptance as an ordinary named user so permission-induced cleanup failures are meaningful. Missing required OS capabilities fail the relevant checks rather than counting as passes. Reports hash the launcher, selected Node executable, package metadata and complete compiled `dist/` closure, then require it to remain unchanged during execution.

The acceptance suite checks actual file effects, IPv4/IPv6 TCP/UDP listeners, Unix socket denial, native VSOCK/io_uring controls, explicit FD grants, interpreter startup injection, lifecycle and cleanup. The SIGKILL observation is recorded separately: namespace workloads stop, while a killed host runner cannot remove its private temporary directory.

The separate Linux supervisor suite verifies that descendants which call `setsid()` stop after leader exit and timeout escalation, that the workload cannot recover unapproved secret descriptors through peer process FD paths, that the private socketpair cannot be reopened, and that signaling the supervisor with SIGUSR1 does not open a Node inspector. It also verifies that an explicitly granted channel at FD 64 still works.

## Disposable Docker fixture

The [Dockerfile](Dockerfile) copies the project, builds the TypeScript runtime and uses the official image's ordinary `node` account at UID 1000. No host bind mount is needed:

```sh
docker build -t sandbox-runtime-ts-tests -f tests/linux/Dockerfile .
docker create --name sandbox-runtime-ts-tests-run \
  --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined \
  --security-opt systempaths=unconfined \
  sandbox-runtime-ts-tests
docker start -a sandbox-runtime-ts-tests-run
docker inspect --format '{{.State.ExitCode}}' sandbox-runtime-ts-tests-run
docker cp sandbox-runtime-ts-tests-run:/tmp/ts-linux-acceptance.json evidence/typescript/linux-acceptance.json
docker cp sandbox-runtime-ts-tests-run:/tmp/ts-linux-benchmark.json evidence/typescript/linux-benchmark.json
docker rm -v sandbox-runtime-ts-tests-run
```

The container exit must be zero and both reports must exist. `SYS_ADMIN` and relaxed outer seccomp/proc-path settings permit nested Bubblewrap setup. Every workload still drops all capabilities and applies its own seccomp and mount restrictions. Do not bind a Docker socket or host directories into this fixture. The documented Dockerfile is a reproduction recipe; its image-build route is distinct from the locally executed fixture.

The actual run reused cached `redis:7.4` (Debian 12), installed test dependencies, and copied the project and checksum-verified official Node.js 24.19.0 arm64 binary. Its unused anonymous `/data` volume is removed with the container. The official Node archive SHA-256 is `01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc`. No user host directory was bound into the container.

## Signal and descriptor boundary

The host controls the trusted TypeScript supervisor through a private anonymous socketpair. The supervisor starts the workload in a process group, forwards validated signals and closes its application-channel copies immediately after spawning. The workload receives only standard streams, explicit communication grants and harmless null placeholders. Before Bubblewrap spawn, host Node enumerates its descriptor inventory and maps every unapproved target through the highest observed descriptor to `/dev/null`; this handles libuv's inherited-descriptor behavior without closing the library host's resources. An excessive descriptor number fails closed.

The namespace supervisor exits after the workload leader exits, retaining its numeric exit status and killing remaining group members. PID-namespace teardown also kills descendants that changed process groups or sessions. Host escalation kills Bubblewrap's outer group. The private control channel carries signal requests only; there is no authenticated payload-start event. A cancellation observed before host spawn prevents execution; cancellation concurrent with Bubblewrap/Node startup can race with workload startup and then terminates it. Optional stderr diagnostics do not certify payload-start state.

## DSH integration

The separate real-consumer suite uses pinned DSH sources, TypeScript 5.9.3 and Zod 4.4.3 as test-only loader dependencies. From `adapters/dsh`, as ordinary user 1000:

```sh
DSH_SOURCE_ROOT=/opt/dsh-pinned \
DSH_TYPESCRIPT_LIB=/opt/typescript-5.9.3/lib/typescript.js \
DSH_ZOD_ROOT=/opt/zod-4.4.3 \
SANDBOX_RUNNER=/opt/sandbox-runtime/bin/sandbox-runner \
/usr/local/bin/node --import ./test/source-loader.js --test --test-reporter=tap \
  test/provider.test.js test/upstream.test.js \
  test/real-runner.test.js test/tools.test.js
```

See the [adapter documentation](../../adapters/dsh/README.md) and source lock for provenance and supported Bash-only scope. These tests do not certify PTC/PTY consumers or upstream native cgroup helpers. Final evidence belongs under `evidence/typescript/`; the release report records measured counts, environment, closure identity and limitations. A rebuilt or modified closure needs fresh validation.
