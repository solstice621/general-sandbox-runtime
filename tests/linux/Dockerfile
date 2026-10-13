FROM node:24.19.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap python3 gcc libc6-dev procps && rm -rf /var/lib/apt/lists/*
RUN test "$(id -u node)" = 1000
WORKDIR /src
COPY . /src
RUN npm ci && npm run build
USER 1000:1000
ENV SANDBOX_RUNTIME_INTEGRATION=1
# The test host must support user/PID/mount namespaces and seccomp.
# Run with --cap-add SYS_ADMIN --security-opt seccomp=unconfined
# --security-opt systempaths=unconfined to permit nested bubblewrap setup.
# No host bind mounts are required. All runtime workloads still drop every cap.
CMD ["/bin/sh", "-c", "node --test dist/test/*.test.js && python3 tests/acceptance.py --runner /src/bin/sandbox-runner --node /usr/local/bin/node --report /tmp/ts-linux-acceptance.json && python3 tests/benchmark.py --runner /src/bin/sandbox-runner --node /usr/local/bin/node --report /tmp/ts-linux-benchmark.json"]
