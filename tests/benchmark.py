#!/usr/bin/env python3
"""Small reproducible startup benchmark and real tool compatibility smoke."""
import argparse
import datetime
import json
import math
import os
from pathlib import Path
import platform
import resource
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time

from runtime_identity import capture_runtime_identity, observe_runtime_process


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runner", required=True)
    parser.add_argument("--node", required=True, help="exact Node executable selected by the launcher")
    parser.add_argument("--runtime-root", help="deployed package root; defaults to launcher.parent.parent")
    parser.add_argument("--report", required=True)
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--warmup", type=int, default=5)
    args = parser.parse_args()
    assert args.samples >= 5 and args.warmup >= 0
    runner = str(Path(args.runner).resolve(strict=True))
    node = str(Path(args.node).resolve(strict=True))
    identity = capture_runtime_identity(runner, node, args.runtime_root)
    with tempfile.TemporaryDirectory(prefix="srt-benchmark-") as fixture:
        root = Path(fixture).resolve()
        policy = {"version": 1,
                  "filesystem": {"read": "host", "denyRead": [],
                                 "allowWrite": [{"path": str(root), "scope": "tree"}],
                                 "denyWrite": [], "temp": "private"},
                  "network": {"mode": "deny"}, "ipc": {"hostUnixSockets": "deny"},
                  "environment": {"inherit": ["HOME", "LANG", "LC_ALL", "TZ"]}}
        def confined(command):
            return [runner, "run", "--policy-json", json.dumps(policy), "--", *command]
        def execute(command):
            result = subprocess.run(command, cwd=root, capture_output=True, timeout=30)
            if result.returncode:
                raise RuntimeError(f"command {command[0]} exit {result.returncode}: {result.stderr.decode(errors='replace')}")
            return result
        py = str(Path(sys.executable).resolve())
        ready = root / "runtime-identity-ready"
        identity_code = f"import pathlib,time; pathlib.Path({str(ready)!r}).write_text('ready'); time.sleep(30)"
        observation_process = subprocess.Popen(confined([py, "-c", identity_code]), cwd=root,
                                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic()+8
            while not ready.exists() and observation_process.poll() is None and time.monotonic()<deadline:
                time.sleep(.02)
            assert ready.exists(), "runtime did not launch the interpreter-identity payload"
            observed_runtime = observe_runtime_process(observation_process.pid, identity)
        finally:
            if observation_process.poll() is None:
                observation_process.send_signal(signal.SIGTERM)
                try: observation_process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    observation_process.kill(); observation_process.communicate()
        true = "/usr/bin/true"
        for _ in range(args.warmup):
            execute([true]); execute(confined([true]))
        direct, isolated = [], []
        cpu_before = resource.getrusage(resource.RUSAGE_CHILDREN)
        for _ in range(args.samples):
            start = time.perf_counter(); execute([true]); direct.append((time.perf_counter()-start)*1000)
            start = time.perf_counter(); execute(confined([true])); isolated.append((time.perf_counter()-start)*1000)
        cpu_after = resource.getrusage(resource.RUSAGE_CHILDREN)
        def summarize(samples):
            return {"median_ms": round(statistics.median(samples), 3),
                    "p95_ms": round(sorted(samples)[math.ceil(.95 * len(samples))-1], 3),
                    "min_ms": round(min(samples), 3), "max_ms": round(max(samples), 3),
                    "samples_ms": [round(v, 3) for v in samples]}
        python_result = execute(confined([py, "-c", "import json,os,tempfile,sqlite3,subprocess; p=os.environ['TMPDIR']; f=tempfile.NamedTemporaryFile(); assert os.path.dirname(f.name)==p; db=sqlite3.connect(':memory:'); assert db.execute('select 6*7').fetchone()[0]==42; assert subprocess.check_output(['/usr/bin/true'])==b''; print(json.dumps({'python':True,'sqlite':True,'privateTemp':p,'child':True}))"]))
        python_evidence = json.loads(python_result.stdout)
        assert not Path(python_evidence["privateTemp"]).exists()
        source = root / "hello.c"
        output = root / "hello"
        source.write_text('#include <stdio.h>\nint main(void) { puts("sandbox-compiled-program"); return 0; }\n')
        cc = shutil.which("cc")
        assert cc, "C compiler required for compatibility test"
        execute(confined([cc, "-Wall", "-Wextra", str(source), "-o", str(output)]))
        binary_result = execute(confined([str(output)]))
        assert binary_result.stdout == b"sandbox-compiled-program\n"
        report = {"platform": sys.platform, "runner": runner,
                  "os_version": platform.platform(), "python_version": platform.python_version(),
                  "measured_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "runtime_identity": identity,
                  "observed_runtime": observed_runtime,
                  "samples_each": args.samples, "warmup_each": args.warmup,
                  "direct_true": summarize(direct), "sandbox_true": summarize(isolated),
                  "median_added_ms": round(statistics.median(isolated)-statistics.median(direct), 3),
                  "sample_children_cpu_seconds": {"user": round(cpu_after.ru_utime-cpu_before.ru_utime, 4),
                                                   "system": round(cpu_after.ru_stime-cpu_before.ru_stime, 4)},
                  "compatibility": {"python": python_evidence, "c_compiler": cc,
                                    "compiled_program_stdout": binary_result.stdout.decode(),
                                    "compiler_and_binary_both_confined": True},
                  "limitations": ["Warm local measurements on this host, not a throughput or resource quota guarantee.",
                                  "Timing includes the CLI supervisor, policy validation, OS setup and cleanup.",
                                  "CPU is combined child CPU over both sample series; no isolated peak-memory measurement."]}
    destination = Path(args.report)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps({k: report[k] for k in ("platform", "samples_each", "median_added_ms", "compatibility")}, indent=2))


if __name__ == "__main__":
    main()
