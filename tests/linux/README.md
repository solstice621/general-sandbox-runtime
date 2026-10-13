# Linux validation

Use Node 24.19.0+, Python 3, a C compiler and non-setuid `/usr/bin/bwrap`. The host must permit user, mount, PID and IPC namespaces plus seccomp. Network deny also needs a network namespace. Run as an ordinary user to exercise permission-sensitive cleanup.

```sh
npm ci
SANDBOX_RUNTIME_INTEGRATION=1 npm test
python3 tests/acceptance.py --runner "$PWD/bin/sandbox-runner" --node /absolute/selected/node --report test-results/linux-acceptance.json
python3 tests/linux/supervisor_acceptance.py --runner "$PWD/bin/sandbox-runner" --node /absolute/selected/node --report test-results/linux-supervisor.json
```

The build prints the Node path bound into the launcher. Use that path for `--node`. Benchmark and plugin test commands are in [tests/README.md](../README.md) and [PLUGINS.md](../../PLUGINS.md).

The [Dockerfile](Dockerfile) provides a disposable test host with UID 1000:

```sh
docker build -t sandbox-runtime-tests -f tests/linux/Dockerfile .
docker create --name sandbox-runtime-tests-run --cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt systempaths=unconfined sandbox-runtime-tests
docker start -a sandbox-runtime-tests-run
docker inspect --format '{{.State.ExitCode}}' sandbox-runtime-tests-run
docker cp sandbox-runtime-tests-run:/tmp/ts-linux-acceptance.json test-results/linux-acceptance.json
docker rm -v sandbox-runtime-tests-run
```

The outer container settings permit nested Bubblewrap setup; each workload drops its capabilities and receives its own mount and seccomp restrictions. This fixture needs no host bind mounts or Docker socket.

The TypeScript supervisor forwards signals through a private anonymous socketpair and closes its copies of application communication channels after spawn. PID namespace teardown ends descendants even if they changed process groups. The separate supervisor suite verifies descriptor access and inspector behavior. Cancellation during startup can race with workload startup; a failure code or diagnostic message alone does not prove the workload never ran. Uncatchable SIGKILL can leave temporary resources.
