#!/usr/bin/env python3
"""Black-box contract tests. No third-party Python packages; no public network.

Usage: python3 tests/acceptance.py --runner /trusted/bin/sandbox-runner --node /trusted/bin/node
Each required test must run or fail. Platform-inapplicable probes are reported
separately, never counted as passing. JSON reports include host and actual effects.
"""
import argparse
import concurrent.futures
import datetime
import errno
import fcntl
import json
import os
from pathlib import Path
import platform
import shutil
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import traceback

from runtime_identity import capture_runtime_identity, observe_runtime_process


class Suite:
    def __init__(self, args):
        self.args = args
        self.runner = str(Path(args.runner).resolve(strict=True))
        self.node = str(Path(args.node).resolve(strict=True))
        self.runtime_identity = capture_runtime_identity(self.runner, self.node, args.runtime_root)
        self.runtime_root = Path(self.runtime_identity["runtime_root"])
        self.started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self.python = str(Path(args.python).resolve(strict=True))
        self.root = Path(tempfile.mkdtemp(prefix="sandbox-acceptance-")).resolve()
        self.workspace = None
        self.outside = None
        self.results = []

    def policy(self, network="deny", temp="private"):
        return {"version": 1,
                "filesystem": {"read": "host", "denyRead": [],
                               "allowWrite": [{"path": str(self.workspace), "scope": "tree"}],
                               "denyWrite": [], "temp": temp},
                "network": {"mode": network}, "ipc": {"hostUnixSockets": "deny"},
                "environment": {"inherit": ["HOME", "LANG", "LC_ALL", "TZ"]}}

    def argv(self, code=None, *, policy=None, command=None, flags=()):
        return [self.runner, "run", "--policy-json", json.dumps(policy or self.policy()),
                *flags, "--", *(command or [self.python, "-c", code])]

    def run(self, code=None, *, policy=None, command=None, flags=(), data=None,
            pass_fds=(), cwd=None, env=None, timeout=12):
        return subprocess.run(self.argv(code, policy=policy, command=command, flags=flags),
                              input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              cwd=cwd or self.workspace, env=env, pass_fds=pass_fds,
                              timeout=timeout)

    @staticmethod
    def success(result):
        assert result.returncode == 0, (f"exit={result.returncode} "
                                        f"stdout={result.stdout!r} stderr={result.stderr!r}")

    def test(self, name, fn, observation=False):
        start = time.monotonic()
        try:
            case_root = self.root / name
            case_root.mkdir()
            self.workspace = case_root / "workspace"
            self.outside = case_root / "outside"
            self.workspace.mkdir()
            self.outside.mkdir()
            detail = fn()
            record = {"name": name, "status": "observed_limitation" if observation else "pass", "detail": detail}
        except Exception as exc:
            record = {"name": name, "status": "fail", "detail": str(exc),
                      "traceback": traceback.format_exc()}
        record["duration_seconds"] = round(time.monotonic() - start, 4)
        self.results.append(record)
        print(f"{record['status'].upper():4} {name}: {record['detail'] or ''}", flush=True)

    def rejected(self, policy, flags=()):
        marker = self.workspace / f"must-not-start-{len(self.results)}"
        marker.unlink(missing_ok=True)
        result = self.run(f"open({str(marker)!r}, 'w').write('executed')", policy=policy, flags=flags)
        assert result.returncode != 0, f"invalid request accepted: {result.stdout!r}"
        assert not marker.exists(), "payload executed before failure"
        return result.stderr.decode(errors="replace").strip()

    def check(self):
        result = subprocess.run([self.runner, "check", "--policy-json", json.dumps(self.policy())],
                                capture_output=True, timeout=12)
        self.success(result)
        report = json.loads(result.stdout)
        assert report["ok"] is True, report
        assert report["platform"] == {"darwin": "darwin", "linux": "linux"}[sys.platform], report
        assert report["network"] == "deny", report
        return report

    def typescript_runtime(self):
        ready = self.workspace / "typescript-ready"
        code = f"import pathlib,time; pathlib.Path({str(ready)!r}).write_text('ready'); time.sleep(20)"
        process = subprocess.Popen(self.argv(code), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, cwd=self.workspace)
        try:
            deadline = time.monotonic() + 8
            while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(.02)
            assert ready.exists(), "runtime did not launch its payload"
            return observe_runtime_process(process.pid, self.runtime_identity)
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                try: process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill(); process.communicate()

    def node_startup_injection(self):
        sentinel = self.outside / "node-preload-effect"
        preload = self.workspace / "preload.mjs"
        preload.write_text("import fs from 'node:fs'; fs.writeFileSync(" + json.dumps(str(sentinel)) + ", 'executed-before-policy');\n")
        result = self.run("print('payload-started')",
                          env=dict(os.environ, NODE_OPTIONS="--import=" + preload.as_uri(), NODE_PATH=str(self.workspace)))
        assert not sentinel.exists(), "NODE_OPTIONS preload executed before sandbox setup"
        self.success(result)
        assert result.stdout == b"payload-started\n"
        return "launcher strips Node startup injection before the interpreter executes runtime JS"

    def absent_fd_bootstrap(self):
        for source in range(3, 17):
            marker = self.workspace / f"absent-source-{source}"
            result = self.run(f"open({str(marker)!r},'w').write('unexpected')",
                              flags=("--grant-fd", f"{source}:7"))
            assert result.returncode != 0, f"absent caller source FD {source} accepted after Node startup"
            assert not marker.exists(), f"Node-owned descriptor substituted for caller FD {source}"
        return "absent caller FD 3..16 cannot be replaced by Node/libuv-created pipes or sockets"

    def argv_streams(self):
        arguments = ["", "a b", "quote'\"", "line\nbreak", "$(touch injected)", "*", "; exit 9"]
        code = "import sys,json; print(json.dumps(sys.argv[1:])); sys.stdout.flush(); sys.stdout.buffer.write(sys.stdin.buffer.read()); sys.stderr.write('payload-stderr\\n')"
        data = b"\x00stdin\n\xffbytes"
        result = self.run(command=[self.python, "-c", code, *arguments], data=data)
        self.success(result)
        first, remaining = result.stdout.split(b"\n", 1)
        assert json.loads(first) == arguments
        assert remaining == data, result.stdout
        assert result.stderr == b"payload-stderr\n", result.stderr
        assert not (self.workspace / "injected").exists()
        return "argv boundaries, binary stdin/stdout and exact stderr preserved"

    def exit_codes(self):
        for value in (0, 1, 23, 125):
            result = self.run(f"import sys; sys.exit({value})")
            assert result.returncode == value, (value, result.returncode, result.stderr)
        result = self.run("import os,signal; os.kill(os.getpid(), signal.SIGTERM)")
        assert result.returncode in (-signal.SIGTERM, 128 + signal.SIGTERM), result.returncode
        return "0, 1, 23, 125 and SIGTERM preserved"

    def file_effects(self):
        allowed = self.workspace / "allowed"
        blocked = self.outside / "blocked"
        blocked.write_text("original")
        code = f"open({str(allowed)!r},'w').write('allowed')\ntry:\n open({str(blocked)!r},'w').write('escaped')\nexcept OSError:\n pass\nelse:\n raise SystemExit('outside write succeeded')"
        self.success(self.run(code))
        assert allowed.read_text() == "allowed"
        assert blocked.read_text() == "original"
        return "allowed write committed; outside inode unchanged"

    def read_rules(self):
        public = self.outside / "public"
        secret = self.outside / "secret"
        public.write_text("public-data")
        secret.write_text("secret-data")
        policy = self.policy()
        policy["filesystem"]["denyRead"] = [{"path": str(secret), "scope": "file"}]
        code = f"assert open({str(public)!r}).read() == 'public-data'\ntry:\n open({str(secret)!r}).read()\nexcept OSError:\n pass\nelse:\n raise SystemExit('secret readable')\ntry:\n open({str(secret)!r},'w').write('altered')\nexcept OSError:\n pass\nelse:\n raise SystemExit('secret writable')"
        self.success(self.run(code, policy=policy))
        assert secret.read_text() == "secret-data"
        return "host-read positive control; denyRead blocks content and writes"

    def protected_tree(self):
        tree = self.workspace / "protected"
        tree.mkdir(exist_ok=True)
        file = tree / "config"
        file.write_text("trusted")
        policy = self.policy()
        policy["filesystem"]["denyWrite"] = [{"path": str(tree), "scope": "tree"}]
        code = f"import pathlib\np=pathlib.Path({str(file)!r})\nassert p.read_text() == 'trusted'\ntry:\n p.write_text('untrusted')\nexcept OSError:\n pass\nelse:\n raise SystemExit('denyWrite bypass')"
        self.success(self.run(code, policy=policy))
        assert file.read_text() == "trusted"
        return "denyWrite overrides containing allowWrite tree"

    def read_only(self):
        marker = self.workspace / "readonly-marker"
        policy = self.policy(temp="none")
        policy["filesystem"]["allowWrite"] = []
        result = self.run(f"open({str(marker)!r},'w').write('bad')", policy=policy)
        assert result.returncode != 0 and not marker.exists(), result
        return "ordinary write denied with empty allowWrite and no private temp"

    def child_policy(self):
        marker = self.outside / "child-escape"
        child = f"open({str(marker)!r},'w').write('bad')"
        code = f"import subprocess,sys\nr=subprocess.run([sys.executable,'-c',{child!r}],capture_output=True)\nassert r.returncode != 0"
        self.success(self.run(code))
        assert not marker.exists()
        return "fresh descendant interpreter remains restricted"

    def cwd_policy(self):
        marker = self.outside / "cwd-marker"
        self.success(self.run("import os; assert os.getcwd() == " + repr(str(self.outside)), cwd=self.outside))
        result = self.run("open('cwd-marker','w').write('bad')", cwd=self.outside)
        assert result.returncode != 0 and not marker.exists()
        return "cwd retained without expanding write authorization"

    def symlink(self):
        target = self.outside / "symlink-target"
        target.write_text("original")
        link = self.workspace / "escape-link"
        link.symlink_to(target)
        result = self.run(f"open({str(link)!r},'w').write('escaped')")
        assert result.returncode != 0
        assert target.read_text() == "original"
        return "write through symlink to outside rejected"

    def symlink_protection(self):
        target = self.workspace / "protected-symlink-target"
        target.write_text("secret")
        link = self.workspace / "protected-symlink-alias"
        link.symlink_to(target)
        policy = self.policy()
        policy["filesystem"]["denyRead"] = [{"path": str(target), "scope": "file"}]
        result = self.run(f"print(open({str(link)!r}).read())", policy=policy)
        assert result.returncode != 0
        assert b"secret" not in result.stdout
        assert target.read_text() == "secret"
        return "resolved alias cannot read protected target"

    def casefold_alias(self):
        for index, upper_declaration in enumerate((False, True)):
            protected = self.workspace / f"case-protected-{index}"
            protected.mkdir()
            file = protected / "control"
            file.write_text("original")
            upper_file = Path(str(file).upper())
            assert upper_file.exists() and os.path.samefile(file, upper_file), "this macOS fixture volume is case-sensitive; alias case requires separate matrix"
            policy = self.policy()
            policy["filesystem"]["denyWrite"] = [{"path": str(protected).upper() if upper_declaration else str(protected), "scope": "tree"}]
            accessed = str(file) if upper_declaration else str(upper_file)
            code = f"assert open({accessed!r}).read() == 'original'\ntry:\n open({accessed!r},'w').write('escaped')\nexcept OSError:\n pass\nelse:\n raise SystemExit('case-insensitive alias bypass')"
            self.success(self.run(code, policy=policy))
            assert file.read_text() == "original"
        return "mixed-case operation and mixed-case declared denyWrite both preserve original inode"

    def ancestor_rename(self):
        ancestor = self.workspace / "ancestor"
        protected = ancestor / "control"
        protected.mkdir(parents=True)
        file = protected / "policy"
        file.write_text("original")
        moved = self.workspace / "ancestor-moved"
        policy = self.policy()
        policy["filesystem"]["denyWrite"] = [{"path": str(protected), "scope": "tree"}]
        result = self.run(f"import os; os.rename({str(ancestor)!r},{str(moved)!r})", policy=policy)
        assert result.returncode != 0, "protected ancestor moved"
        assert file.read_text() == "original" and not moved.exists()
        return "protected entry and its mutable ancestor remain anchored"

    def root_rename(self):
        moved = self.root / "workspace-renamed"
        result = self.run(f"import os; os.rename({str(self.workspace)!r},{str(moved)!r})")
        assert result.returncode != 0
        assert self.workspace.is_dir() and not moved.exists()
        return "allowWrite root cannot be renamed out of authorization boundary"

    def nested_overlay(self):
        outer = self.workspace / "nested-overlay"
        inner = outer / "inner"
        inner.mkdir(parents=True)
        file = inner / "protected"
        file.write_text("original")
        policy = self.policy()
        policy["filesystem"]["allowWrite"].extend([
            {"path": str(outer), "scope": "tree"}, {"path": str(inner), "scope": "tree"}])
        policy["filesystem"]["denyWrite"] = [{"path": str(file), "scope": "file"}]
        result = self.run(f"open({str(file)!r},'w').write('escaped')", policy=policy)
        assert result.returncode != 0 and file.read_text() == "original"
        return "nested writable roots do not re-expose protected file"

    def hardlink(self):
        target = self.outside / "hardlink-target"
        target.write_text("original")
        alias = self.workspace / "hardlink-alias"
        os.link(target, alias)
        policy = self.policy()
        policy["filesystem"]["denyWrite"] = [{"path": str(target), "scope": "file"}]
        result = self.run(f"open({str(alias)!r},'w').write('escaped')", policy=policy)
        assert result.returncode != 0, "identified protected hardlink alias accepted"
        assert target.read_text() == "original"
        return "explicitly protected multiply-linked file is rejected or remains intact"

    def new_hardlink(self):
        target = self.outside / "new-hardlink-target"
        target.write_text("original")
        alias = self.workspace / "new-hardlink-alias"
        code = f"import os\ntry:\n os.link({str(target)!r},{str(alias)!r}); open({str(alias)!r},'w').write('escaped')\nexcept OSError:\n pass\nelse:\n raise SystemExit('new hardlink bypass')"
        self.success(self.run(code))
        assert target.read_text() == "original"
        return "new hardlink cannot make outside inode writable"

    def invalid_requests(self):
        variants = []
        p = self.policy(); p["unexpected"] = True; variants.append(p)
        p = self.policy(); p["network"]["mode"] = "proxy"; variants.append(p)
        p = self.policy(); p["filesystem"]["denyWrite"] = [{"path": "relative", "scope": "tree"}]; variants.append(p)
        p = self.policy(); p["filesystem"]["denyWrite"] = [{"path": str(self.workspace / "absent"), "scope": "file"}]; variants.append(p)
        p = self.policy(); p["filesystem"]["allowWrite"] = [{"path": str(self.workspace), "scope": "glob"}]; variants.append(p)
        p = self.policy(); p["environment"]["overrides"] = {"NODE_OPTIONS": "--require=evil.js"}; variants.append(p)
        for policy in variants:
            self.rejected(policy)
        return f"{len(variants)} invalid/unsupported policies blocked without payload effects"

    def unsafe_environment(self):
        p = self.policy(); p["environment"]["inherit"] = ["PYTHONPATH"]
        self.rejected(p)
        p = self.policy(); p["environment"]["inherit"] = ["NODE_OPTIONS"]
        self.rejected(p)
        marker = self.workspace / "env-executed"
        injection = self.workspace / "env-injection"
        injection.mkdir()
        (injection / "sitecustomize.py").write_text(f"open({str(marker)!r},'w').write('injected')")
        env = dict(os.environ, PYTHONPATH=str(injection), NODE_OPTIONS="--require=/missing",
                   BASH_ENV=str(injection / "sitecustomize.py"), SANDBOX_SECRET="must-not-leak",
                   PATH=str(injection))
        result = self.run("import os,json; print(json.dumps(dict(os.environ)))", env=env)
        self.success(result)
        actual = json.loads(result.stdout)
        for field in ("PYTHONPATH", "NODE_OPTIONS", "BASH_ENV", "SANDBOX_SECRET"):
            assert field not in actual, (field, actual)
        assert actual["PATH"] == "/usr/bin:/bin:/usr/sbin:/sbin", actual
        assert not marker.exists()
        return "dangerous inheritance rejected; injected host values removed; fixed PATH"

    def private_temp(self):
        result = self.run("import os,tempfile,json; p=os.environ['TMPDIR']; f=tempfile.NamedTemporaryFile(delete=False); f.write(b'private'); f.close(); print(json.dumps([p,f.name,oct(os.stat(p).st_mode & 0o777)]))")
        self.success(result)
        directory, file, mode = json.loads(result.stdout)
        assert Path(file).parent == Path(directory)
        assert mode == "0o700", mode
        assert not Path(directory).exists(), f"private temp remains: {directory}"
        return "private directory mode 0700; temp file and directory removed after exit"

    def tcp(self, family, mode):
        host = "127.0.0.1" if family == socket.AF_INET else "::1"
        with socket.socket(family, socket.SOCK_STREAM) as server:
            server.settimeout(0.35)
            server.bind((host, 0))
            server.listen(1)
            port = server.getsockname()[1]
            code = f"import socket\ntry:\n s=socket.socket({family},socket.SOCK_STREAM); s.settimeout(1); s.connect(({host!r},{port})); s.sendall(b'actual-connection')\nexcept OSError:\n raise SystemExit(21)"
            result = self.run(code, policy=self.policy(network=mode))
            received = None
            try:
                conn, _ = server.accept()
                with conn:
                    conn.settimeout(1)
                    received = conn.recv(100)
            except socket.timeout:
                pass
            if mode == "host":
                self.success(result)
                assert received == b"actual-connection", received
            else:
                assert result.returncode == 21, (result.returncode, result.stderr)
                assert received is None, "forbidden connection reached host listener"
            return f"{host}: {mode}; actual listener received {received!r}"

    def udp(self, family, mode):
        host = "127.0.0.1" if family == socket.AF_INET else "::1"
        with socket.socket(family, socket.SOCK_DGRAM) as server:
            server.settimeout(0.35)
            server.bind((host, 0))
            port = server.getsockname()[1]
            code = f"import socket\ntry:\n s=socket.socket({family},socket.SOCK_DGRAM); s.sendto(b'dns-egress-probe',({host!r},{port}))\nexcept OSError:\n raise SystemExit(21)"
            result = self.run(code, policy=self.policy(network=mode))
            received = None
            try:
                received = server.recvfrom(100)[0]
            except socket.timeout:
                pass
            if mode == "host":
                self.success(result)
                assert received == b"dns-egress-probe"
            else:
                assert received is None, "forbidden datagram reached host listener"
                assert result.returncode in (0, 21), (result.returncode, result.stderr)
            return f"{host}: {mode}; actual datagram received {received!r}"

    def localhost_resolution(self):
        result = self.run("import socket,json; entries=socket.getaddrinfo('localhost',0,type=socket.SOCK_STREAM); hosts=sorted(set(e[4][0] for e in entries)); assert '127.0.0.1' in hosts or '::1' in hosts; print(json.dumps(hosts))", policy=self.policy(network="host"))
        self.success(result)
        return {"localhost_addresses": json.loads(result.stdout),
                "scope": "local name resolution compatibility; not external DNS certification"}

    def unix_socket(self, mode):
        # macOS sun_path is short; keep endpoint under system /tmp, not deep TMPDIR.
        directory = Path(tempfile.mkdtemp(prefix="srt-unix-", dir="/tmp"))
        endpoint = directory / "s"
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(endpoint)); server.listen(1); server.settimeout(0.3)
                code = f"import socket\ntry:\n s=socket.socket(socket.AF_UNIX); s.connect({str(endpoint)!r}); s.sendall(b'escape')\nexcept OSError:\n raise SystemExit(21)"
                result = self.run(code, policy=self.policy(network=mode))
                assert result.returncode == 21, (result.returncode, result.stderr)
                try:
                    conn, _ = server.accept()
                except socket.timeout:
                    return f"host pathname Unix socket denied with network={mode}"
                else:
                    conn.close()
                    raise AssertionError("host Unix listener accepted forbidden connection")
        finally:
            shutil.rmtree(directory)

    def socketpair(self):
        code = "import socket; a,b=socket.socketpair(); a.sendall(b'anonymous'); assert b.recv(20)==b'anonymous'"
        self.success(self.run(code))
        return "anonymous Unix socketpair still carries bytes"

    def datagram_socketpair_host(self):
        directory = Path(tempfile.mkdtemp(prefix="srt-dgram-", dir="/tmp"))
        endpoint = directory / "s"
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as server:
                server.bind(str(endpoint)); server.settimeout(.3)
                for mode in ("deny", "host"):
                    code = f"import socket\ntry:\n a,b=socket.socketpair(socket.AF_UNIX,socket.SOCK_DGRAM); a.sendto(b'escape',{str(endpoint)!r})\nexcept OSError:\n raise SystemExit(21)"
                    result = self.run(code, policy=self.policy(network=mode))
                    assert result.returncode == 21, (mode, result.returncode, result.stderr)
                    try:
                        received = server.recv(100)
                    except socket.timeout:
                        continue
                    raise AssertionError(f"{mode}: named host datagram endpoint received {received!r}")
                return "socketpair datagram sendto cannot reach named host Unix endpoint in either network mode"
        finally:
            shutil.rmtree(directory)

    def unapproved_fd(self):
        with open(self.outside / "fd-secret", "w+") as file:
            file.write("secret"); file.flush(); file.seek(0)
            fd = file.fileno()
            high_fd = fcntl.fcntl(fd, fcntl.F_DUPFD, 192)
            stat = os.fstat(fd)
            code = f"import os,json\nremaining=[]; candidates=set(range(3,256)); candidates.add({high_fd})\ntry:\n candidates.update(int(x) for x in os.listdir('/dev/fd') if int(x)>=3)\nexcept OSError:\n pass\nfor fd in sorted(candidates):\n try:\n  s=os.fstat(fd)\n except OSError:\n  continue\n assert (s.st_dev,s.st_ino) != {(stat.st_dev, stat.st_ino)!r}, 'unapproved file identity leaked'\n remaining.append(fd)\nprint(json.dumps(remaining))"
            try:
                result = self.run(code, pass_fds=(fd, high_fd))
                self.success(result)
                remaining = json.loads(result.stdout)
                assert not remaining, f"unexpected payload descriptors remain: {remaining}"
            finally:
                os.close(high_fd)
        return "unapproved low/high file descriptors absent by inode; no open private descriptors found"

    def approved_fd(self):
        parent, child = socket.socketpair()
        try:
            source, target = child.fileno(), 7
            if source == target:
                target = 8
            code = f"import os,socket,sys\ns=socket.socket(fileno={target}); s.sendall(b'payload:')\npid=os.fork()\nif pid==0:\n os.execv(sys.executable,[sys.executable,'-c',\"import os; os.write({target}, b'descendant')\"])\nelse:\n _,status=os.waitpid(pid,0); assert status==0"
            result = self.run(code, flags=("--grant-fd", f"{source}:{target}"), pass_fds=(source,))
            self.success(result)
            child.close(); parent.settimeout(1)
            received = b""
            while True:
                fragment = parent.recv(100)
                if not fragment:
                    break
                received += fragment
            assert received == b"payload:descendant", received
            return "explicit application channel survives backend and descendant exec"
        finally:
            parent.close(); child.close()

    def fd_number_collisions(self):
        first_parent, first_child = socket.socketpair()
        second_parent, second_child = socket.socketpair()
        def receive(sock, size):
            data = b""
            while len(data) < size:
                fragment = sock.recv(size-len(data))
                assert fragment, "approved channel closed before expected bytes"
                data += fragment
            return data
        try:
            same = first_child.fileno()
            assert 3 <= same <= 64
            result = self.run(f"import os; os.write({same},b'same-number')",
                              flags=("--grant-fd", f"{same}:{same}"), pass_fds=(same,))
            self.success(result)
            first_parent.settimeout(1)
            assert receive(first_parent, len(b"same-number")) == b"same-number"
            first, second = first_child.fileno(), second_child.fileno()
            code = "import os,sys; os.write(3,b'A'); os.write(7,b'B'); pid=os.fork()\nif pid==0:\n os.execv(sys.executable,[sys.executable,'-c',\"import os; os.write(3,b'a'); os.write(7,b'b')\"])\nelse:\n _,status=os.waitpid(pid,0); assert status==0"
            result = self.run(code, flags=("--grant-fd", f"{first}:3", "--grant-fd", f"{second}:7"),
                              pass_fds=(first, second))
            self.success(result)
            second_parent.settimeout(1)
            assert receive(first_parent, 2) == b"Aa"
            assert receive(second_parent, 2) == b"Bb"
            high = fcntl.fcntl(first, fcntl.F_DUPFD, 192)
            try:
                result = self.run("import os; os.write(7,b'high')",
                                  flags=("--grant-fd", f"{high}:7"), pass_fds=(high,))
                self.success(result)
                assert receive(first_parent, 4) == b"high"
            finally:
                os.close(high)
            result = self.run("import os; os.write(64,b'upper64')",
                              flags=("--grant-fd", f"{first}:64"), pass_fds=(first,))
            self.success(result)
            assert receive(first_parent, 7) == b"upper64"
            result = self.run(f"import os; os.write({second},b'swap-A'); os.write({first},b'swap-B')",
                              flags=("--grant-fd", f"{first}:{second}", "--grant-fd", f"{second}:{first}"),
                              pass_fds=(first, second))
            self.success(result)
            assert receive(first_parent, 6) == b"swap-A"
            assert receive(second_parent, 6) == b"swap-B"
            return "same-number, multiple low targets, high source, target64 and swapped mappings preserve actual bytes; descendants retain authorized channels"
        finally:
            first_parent.close(); first_child.close(); second_parent.close(); second_child.close()

    def fd_conflicts(self):
        sender, receiver = socket.socketpair()
        try:
            fd = sender.fileno()
            for mapping in (f"{fd}:1", f"{fd}:65"):
                marker = self.workspace / "fd-invalid-marker"
                result = self.run(f"open({str(marker)!r},'w').write('bad')",
                                  flags=("--grant-fd", mapping), pass_fds=(fd,))
                assert result.returncode != 0 and not marker.exists()
            marker = self.workspace / "fd-duplicate-marker"
            result = self.run(f"open({str(marker)!r},'w').write('bad')",
                              flags=("--grant-fd", f"{fd}:7", "--grant-fd", f"{fd}:7"), pass_fds=(fd,))
            assert result.returncode != 0 and not marker.exists()
        finally:
            sender.close(); receiver.close()
        with open(self.outside / "fd-file", "w+") as file:
            fd = file.fileno()
            marker = self.workspace / "fd-file-marker"
            result = self.run(f"open({str(marker)!r},'w').write('bad')",
                              flags=("--grant-fd", f"{fd}:7"), pass_fds=(fd,))
            assert result.returncode != 0 and not marker.exists()
        return "standard-stream, out-of-range, duplicate targets and file capabilities rejected"

    def expired_before_spawn(self):
        marker = self.workspace / "preexpired-marker"
        result = self.run(f"open({str(marker)!r},'w').write('executed')", flags=("--timeout", "1ns"))
        assert result.returncode != 0 and not marker.exists(), result
        return "already-expired execution deadline blocks payload effects"

    def parent_death(self):
        metadata = self.workspace / "parent-death-ready"
        heartbeat = self.workspace / "parent-death-heartbeat"
        code = f"import os,time,json\nopen({str(metadata)!r},'w').write(json.dumps([os.getpid(),os.environ['TMPDIR']]))\nwhile True:\n with open({str(heartbeat)!r},'a') as f: f.write('x')\n time.sleep(.03)"
        launcher = ("import subprocess,pathlib,time,json,os,sys\n"
                    f"p=subprocess.Popen({self.argv(code)!r},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,cwd={str(self.workspace)!r})\n"
                    f"ready=pathlib.Path({str(metadata)!r})\n"
                    "deadline=time.monotonic()+5\n"
                    "while not ready.exists() and p.poll() is None and time.monotonic()<deadline: time.sleep(.02)\n"
                    "if not ready.exists():\n p.kill(); p.wait(); raise SystemExit('payload never ready')\n"
                    "print(p.pid,flush=True)\nos._exit(0)")
        launch = subprocess.run([self.python, "-c", launcher], capture_output=True, timeout=7)
        self.success(launch)
        runner_pid = int(launch.stdout)
        payload_pid, directory = json.loads(metadata.read_text())
        try:
            deadline = time.monotonic() + 5
            while Path(directory).exists() and time.monotonic() < deadline:
                time.sleep(.03)
            assert not Path(directory).exists(), "orphan runner did not stop and clean"
            size = heartbeat.stat().st_size
            time.sleep(.2)
            assert heartbeat.stat().st_size == size, "payload still running after parent death"
            if sys.platform == "darwin":
                assert self.gone(payload_pid), "payload survived runner parent death"
            return "caller death stops managed execution and cleans private temp"
        finally:
            # Only the PID created by this test; clean a broken implementation.
            if Path(directory).exists():
                try: os.kill(runner_pid, signal.SIGTERM)
                except ProcessLookupError: pass

    def concurrent_cancel(self):
        processes, directories = [], []
        try:
            for index in range(2):
                marker = self.workspace / f"parallel-ready-{index}"
                code = f"import os,time,pathlib; pathlib.Path({str(marker)!r}).write_text(os.environ['TMPDIR']); time.sleep(20)"
                process = subprocess.Popen(self.argv(code), stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=self.workspace)
                processes.append(process)
                deadline = time.monotonic() + 5
                while not marker.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(.02)
                assert marker.exists(), "parallel payload never ready"
                directories.append(Path(marker.read_text()))
            processes[0].send_signal(signal.SIGTERM)
            processes[0].communicate(timeout=5)
            assert not directories[0].exists()
            assert processes[1].poll() is None and directories[1].exists(), "one cleanup affected another execution"
            processes[1].send_signal(signal.SIGTERM)
            processes[1].communicate(timeout=5)
            assert not directories[1].exists()
            return "cancelling one execution preserves the other process and private directory"
        finally:
            for process in processes:
                if process.poll() is None:
                    process.send_signal(signal.SIGTERM)
                    try: process.communicate(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.communicate()

    def leader_exit_cleanup(self):
        metadata = self.workspace / "leader-exit-metadata"
        heartbeat = self.workspace / "leader-exit-heartbeat"
        code = f"import os,time,json,pathlib\npid=os.fork()\nif pid==0:\n while True:\n  with open({str(heartbeat)!r},'a') as f: f.write('x')\n  time.sleep(.03)\nelse:\n while not pathlib.Path({str(heartbeat)!r}).exists(): time.sleep(.01)\n open({str(metadata)!r},'w').write(json.dumps([pid,os.environ['TMPDIR']]))\n os._exit(23)"
        result = self.run(code)
        assert result.returncode == 23, (result.returncode, result.stderr)
        child, directory = json.loads(metadata.read_text())
        size = heartbeat.stat().st_size
        time.sleep(.2)
        assert heartbeat.stat().st_size == size, "descendant continues after leader exit"
        assert not Path(directory).exists()
        if sys.platform == "darwin":
            assert self.gone(child), "managed group member survives leader exit"
        return "leader exit 23 retained; remaining process-group member stops; temp removed"

    @staticmethod
    def gone(pid, wait=2):
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
            time.sleep(0.03)
        return False

    def timeout(self):
        metadata = self.workspace / "timeout-metadata"
        code = f"import os,signal,time,json\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\npid=os.fork()\nif pid==0:\n while True: time.sleep(1)\nelse:\n open({str(metadata)!r},'w').write(json.dumps([os.getpid(),pid,os.environ['TMPDIR']]))\n while True: time.sleep(1)"
        start = time.monotonic()
        result = self.run(code, flags=("--timeout", "700ms", "--grace", "200ms"), timeout=6)
        elapsed = time.monotonic() - start
        assert result.returncode != 0 and elapsed < 5, (result.returncode, elapsed)
        pids = json.loads(metadata.read_text())
        if sys.platform == "darwin":
            assert all(self.gone(pid) for pid in pids[:2]), f"surviving managed processes: {pids}"
        # Linux payload PIDs live in a new namespace, so host kill(0) would inspect
        # unrelated host processes. The Linux namespace probe verifies reaping.
        assert not Path(pids[2]).exists(), f"timed-out temp remains: {pids[2]}"
        return {"elapsed_seconds": round(elapsed, 3), "exit": result.returncode,
                "private_temp_removed": True, "host_pid_check": sys.platform == "darwin"}

    def signal_forwarding(self):
        ready = self.workspace / "signal-ready"
        code = f"import signal,time,pathlib,sys\nsignal.signal(signal.SIGTERM,lambda *args:sys.exit(23))\npathlib.Path({str(ready)!r}).write_text('ready')\nwhile True: time.sleep(1)"
        process = subprocess.Popen(self.argv(code), stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=self.workspace)
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            assert ready.exists(), "payload did not become ready"
            process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=5)
            assert process.returncode == 23, (process.returncode, stdout, stderr)
            return "SIGTERM reaches payload handler; handler exit 23 preserved"
        finally:
            if process.poll() is None:
                process.kill(); process.communicate()

    def concurrency(self):
        def one(index):
            result = self.run(f"import os,time,json; p=os.environ['TMPDIR']; open(p+'/marker','w').write('{index}'); time.sleep(.25); print(json.dumps(p))")
            self.success(result)
            return json.loads(result.stdout)
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            directories = list(pool.map(one, range(5)))
        assert len(set(directories)) == 5, directories
        assert all(not Path(path).exists() for path in directories), directories
        return "five overlapping executions used unique directories and each cleaned its own"

    def spoofed_error(self):
        marker = self.workspace / "spoofed-error-side-effect"
        code = f"import sys; open({str(marker)!r},'w').write('executed'); sys.stderr.write('SANDBOX_SETUP_FAILED: sandbox-runner failed; command did not execute\\n'); sys.exit(37)"
        result = self.run(code)
        assert marker.read_text() == "executed"
        assert result.returncode == 37, result.returncode
        assert b"SANDBOX_SETUP_FAILED" in result.stderr
        return "payload side effect and exit 37 retained despite forged runtime diagnostic"

    def redacted_diagnostics(self):
        secret_arg = "private-argument-" + secrets.token_hex(12)
        secret_env = "private-environment-" + secrets.token_hex(12)
        code = "import os,sys; assert sys.argv[1].startswith('private-argument-'); assert os.environ['TZ'].startswith('private-environment-'); sys.stdout.buffer.write(b'payload-output\\x00\\xff'); sys.exit(23)"
        result = self.run(command=[self.python, "-c", code, secret_arg], flags=("--diagnostics",),
                          env=dict(os.environ, TZ=secret_env))
        assert result.returncode == 23
        assert result.stdout == b"payload-output\x00\xff", result.stdout
        assert secret_arg.encode() not in result.stderr and secret_env.encode() not in result.stderr
        assert code.encode() not in result.stderr
        events = [json.loads(line) for line in result.stderr.splitlines()]
        assert events, "no optional lifecycle events emitted"
        allowed_fields = {"runId", "backend", "policyDigest", "phase", "exitCode", "errorCode", "cleanupFailed"}
        for event in events:
            assert set(event) <= allowed_fields, event
            assert event["backend"] == sys.platform
            assert len(event["policyDigest"]) == 64
        assert len({event["runId"] for event in events}) == 1
        assert any(event.get("exitCode") == 23 for event in events), events
        return {"phases": [event["phase"] for event in events],
                "argv_and_environment_secrets_absent": True, "payload_bytes_and_exit_preserved": True,
                "scope": "shared stderr diagnostics; not an authenticated execution-state protocol"}

    def cleanup_failure(self):
        outcomes = []
        for exit_code in (0, 23):
            token = secrets.token_hex(12)
            code = f"import os,sys,json\np=os.environ['TMPDIR']; d=p+'/noaccess'; os.mkdir(d); open(d+'/marker','w').write({token!r}); owner=json.load(open(os.path.dirname(p)+'/owner.json')); print(json.dumps([p,owner]),flush=True); os.chmod(d,0); sys.exit({exit_code})"
            result = self.run(code)
            raw_directory, owner = json.loads(result.stdout)
            directory = Path(raw_directory)
            root = directory.parent
            try:
                assert result.returncode == exit_code, (result.returncode, result.stderr)
                assert b"cleanup" in result.stderr.lower(), result.stderr
                assert root.is_dir(), "expected failed cleanup resource missing"
                assert root.name.startswith("sandbox-runtime-" + owner["runId"] + "-"), str(root)
                assert root.parent.resolve() == Path("/tmp").resolve(), str(root)
                assert root.stat().st_uid == os.geteuid()
                blocked = directory / "noaccess"
                os.chmod(blocked, 0o700)
                assert (blocked / "marker").read_text() == token
                shutil.rmtree(root)
                outcomes.append({"payload_exit": exit_code, "cleanup_diagnostic": True,
                                 "verified_owned_resource_removed_by_test": True})
            finally:
                # No broad scan or PID-only collection: only this exact output
                # path, with both ownership and unpredictable marker checked.
                if root.exists() and root.parent.resolve() == Path("/tmp").resolve():
                    try:
                        if root.name.startswith("sandbox-runtime-" + owner["runId"] + "-") and root.stat().st_uid == os.geteuid():
                            blocked = directory / "noaccess"
                            if blocked.exists():
                                os.chmod(blocked, 0o700)
                                if (blocked / "marker").read_text() == token:
                                    shutil.rmtree(root)
                    except (OSError, ValueError, KeyError):
                        pass
        return outcomes

    def sigkill_boundary(self):
        """Measure the documented uncatchable-kill boundary, not an acceptance pass."""
        token = secrets.token_hex(12)
        metadata = self.workspace / "kill-metadata"
        heartbeat = self.workspace / "kill-heartbeat"
        code = f"import os,time,json\np=os.environ['TMPDIR']; open(p+'/kill-marker','w').write({token!r}); owner=json.load(open(os.path.dirname(p)+'/owner.json')); open({str(metadata)!r},'w').write(json.dumps([p,owner]));\nwhile True:\n with open({str(heartbeat)!r},'a') as f: f.write('x')\n time.sleep(.02)"
        process = subprocess.Popen(self.argv(code), cwd=self.workspace,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        groups, root, directory, owner = [], None, None, None
        try:
            deadline = time.monotonic() + 5
            while not metadata.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(.02)
            assert metadata.exists(), "payload not ready for forced-kill boundary observation"
            raw_directory, owner = json.loads(metadata.read_text())
            directory = Path(raw_directory); root = directory.parent
            table = subprocess.check_output(["/bin/ps", "-axo", "pid=,ppid=,pgid="], text=True)
            for row in table.splitlines():
                pid, parent, group = map(int, row.split())
                if parent == process.pid:
                    assert group > 1 and group != os.getpgrp(), "unsafe test cleanup group"
                    groups.append(group)
            assert groups, "no owned host process group recorded before SIGKILL"
            process.kill(); process.wait(timeout=3)
            time.sleep(.15)
            size = heartbeat.stat().st_size
            time.sleep(.15)
            continues = heartbeat.stat().st_size != size
            leftover = directory.exists()
            return {"runner_exit": process.returncode,
                    "private_temp_left_after_SIGKILL": leftover,
                    "payload_heartbeat_continues_after_SIGKILL": continues,
                    "classification": "documented boundary observation, not unconditional cleanup acceptance",
                    "fixture_cleanup": "test terminates only pre-recorded owned host groups and verifies its exact run ID/UID/random marker before deletion"}
        finally:
            if process.poll() is None:
                process.kill(); process.wait(timeout=3)
            for group in groups:
                try: os.killpg(group, signal.SIGKILL)
                except ProcessLookupError: pass
            if root is not None and root.exists():
                assert root.parent.resolve() == Path("/tmp").resolve()
                assert root.name.startswith("sandbox-runtime-" + owner["runId"] + "-")
                assert root.stat().st_uid == os.geteuid()
                assert (directory / "kill-marker").read_text() == token
                time.sleep(.1)
                shutil.rmtree(root)

    def trusted_install(self):
        deployment = self.workspace / "copied-runtime"
        deployment.mkdir()
        (deployment / "bin").mkdir()
        copy = deployment / "bin" / Path(self.runner).name
        shutil.copy2(self.runner, copy)
        shutil.copy2(self.runtime_root / "package.json", deployment / "package.json")
        shutil.copytree(self.runtime_root / "dist", deployment / "dist")
        protected = [copy, deployment / "package.json", *sorted((deployment / "dist").rglob("*.js"))]
        assert deployment / "dist/src/cli.js" in protected
        assert deployment / "dist/src/runner.js" in protected
        before = {str(path): path.read_bytes() for path in protected}
        moved = deployment / "bin/moved-runner"
        moved_root = self.workspace / "moved-runtime"
        added = deployment / "dist/src/unauthorized-module.js"
        attempted = [str(path) for path in protected] + [str(added)]
        code = f"import os\nfor path in {attempted!r}:\n try:\n  open(path,'wb').write(b'corrupted')\n except OSError:\n  pass\n else:\n  raise SystemExit('runtime closure artifact overwritten or created: '+path)\nfor src,dst in {[(str(copy),str(moved)),(str(deployment),str(moved_root))]!r}:\n try:\n  os.rename(src,dst)\n except OSError:\n  pass\n else:\n  raise SystemExit('runtime closure renamed: '+src)"
        argv = self.argv(code)
        argv[0] = str(copy)
        result = subprocess.run(argv, cwd=self.workspace, capture_output=True, timeout=12)
        self.success(result)
        for path in protected:
            assert path.read_bytes() == before[str(path)]
        assert not moved.exists() and not moved_root.exists() and not added.exists()
        return "launcher, every deployed JS file, package metadata and deployment root resist modification/rename; new dist module creation denied"

    def native_probes(self):
        source = Path(__file__).with_name("syscall_probe.c")
        output = self.outside / "syscall-probe"
        compiler = shutil.which("cc")
        assert compiler, "required native syscall probes need a C compiler"
        build = subprocess.run([compiler, "-Wall", "-Wextra", "-O2", str(source), "-o", str(output)], capture_output=True)
        self.success(build)
        file = self.outside / "fcntl-protected"
        file.write_bytes(b"protected-original" * 4096)
        before = file.read_bytes()
        baseline = subprocess.run([str(output), str(file)], capture_output=True, timeout=3)
        self.success(baseline)
        baseline_report = json.loads(baseline.stdout)
        result = self.run(command=[str(output), str(file)])
        self.success(result)
        assert file.read_bytes() == before
        report = json.loads(result.stdout)
        for probe, outcome in report.items():
            assert outcome["result"] == -1 and outcome["errno"] in (errno.EPERM, errno.EACCES), (probe, outcome)
        return {"sandbox": report, "host_baseline": baseline_report,
                "note": "A host EPERM by itself does not prove this runtime's filter; inspect sandbox result with backend tests."}

    def linux_namespace(self):
        code = "import os,json; s=open('/proc/self/status').read(); lines=dict(x.split(':',1) for x in s.splitlines() if ':' in x); assert int(lines['CapEff'].strip(),16)==0; assert lines['NoNewPrivs'].strip()=='1'; assert os.getpid()<100; print(json.dumps({'pid':os.getpid(),'CapEff':lines['CapEff'].strip(),'NoNewPrivs':lines['NoNewPrivs'].strip()}))"
        result = self.run(code)
        self.success(result)
        return json.loads(result.stdout)

    def execute(self):
        tests = [("check-report", self.check), ("typescript-runtime-process", self.typescript_runtime),
                 ("node-startup-injection", self.node_startup_injection),
                 ("node-fd-bootstrap-absence", self.absent_fd_bootstrap),
                 ("argv-and-standard-streams", self.argv_streams),
                 ("exit-and-signal-status", self.exit_codes), ("file-allow-and-deny", self.file_effects),
                 ("host-read-and-deny-read", self.read_rules), ("deny-write-precedence", self.protected_tree),
                 ("read-only", self.read_only), ("descendant-policy", self.child_policy),
                 ("cwd-is-not-authorization", self.cwd_policy), ("symlink-outside-write", self.symlink),
                 ("symlink-protected-read", self.symlink_protection), ("protected-ancestor-rename", self.ancestor_rename),
                 ("authorization-root-rename", self.root_rename), ("nested-write-roots", self.nested_overlay),
                 ("identified-hardlink", self.hardlink), ("new-cross-boundary-hardlink", self.new_hardlink),
                 ("invalid-policy-fail-closed", self.invalid_requests),
                 ("environment-injection", self.unsafe_environment), ("private-temp-cleanup", self.private_temp)]
        for family, label in ((socket.AF_INET, "ipv4"), (socket.AF_INET6, "ipv6")):
            for mode in ("deny", "host"):
                tests.extend([(f"tcp-{label}-{mode}", lambda f=family, m=mode: self.tcp(f, m)),
                              (f"udp-{label}-{mode}", lambda f=family, m=mode: self.udp(f, m))])
        tests.extend([("host-unix-deny-network", lambda: self.unix_socket("deny")),
                      ("host-localhost-resolution", self.localhost_resolution),
                      ("host-unix-host-network", lambda: self.unix_socket("host")),
                      ("anonymous-socketpair", self.socketpair), ("socketpair-named-datagram-denial", self.datagram_socketpair_host),
                      ("unapproved-fd", self.unapproved_fd),
                      ("approved-fd-descendants", self.approved_fd), ("fd-conflicts", self.fd_conflicts),
                      ("node-fd-number-collisions", self.fd_number_collisions),
                      ("deadline-before-spawn", self.expired_before_spawn), ("execution-timeout", self.timeout),
                      ("signal-forwarding", self.signal_forwarding), ("caller-parent-death", self.parent_death),
                      ("leader-exit-process-group-cleanup", self.leader_exit_cleanup),
                      ("parallel-private-temp", self.concurrency), ("parallel-cancel-isolation", self.concurrent_cancel),
                      ("payload-diagnostic-spoof", self.spoofed_error),
                      ("optional-diagnostics-redaction", self.redacted_diagnostics),
                      ("trusted-install-boundary", self.trusted_install), ("native-syscall-denials", self.native_probes)])
        if os.geteuid() != 0:
            tests.append(("cleanup-failure-exit-preservation", self.cleanup_failure))
        if sys.platform == "darwin":
            tests.append(("case-insensitive-path-alias", self.casefold_alias))
        if sys.platform == "linux":
            tests.append(("linux-namespaces-and-capabilities", self.linux_namespace))
        selected = [item for item in tests if not self.args.only or self.args.only in item[0]]
        observe_kill = not self.args.only or self.args.only in "sigkill-boundary-observation"
        assert selected or observe_kill, "--only matched no tests"
        if not any(name == "typescript-runtime-process" for name, _ in selected):
            selected.insert(0, ("typescript-runtime-process", self.typescript_runtime))
        try:
            for name, fn in selected:
                self.test(name, fn)
            if observe_kill:
                self.test("sigkill-boundary-observation", self.sigkill_boundary, observation=True)
        finally:
            if not self.args.keep:
                shutil.rmtree(self.root)
        return {"platform": sys.platform, "runner": self.runner, "python": self.python,
                "os_version": platform.platform(), "python_version": platform.python_version(),
                "started_at_utc": self.started_at,
                "finished_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "runtime_identity": self.runtime_identity,
                "effective_uid": os.geteuid(),
                "test_root": str(self.root), "test_root_retained": self.args.keep,
                "passed": sum(x["status"] == "pass" for x in self.results),
                "failed": sum(x["status"] == "fail" for x in self.results),
                "observed_limitations": sum(x["status"] == "observed_limitation" for x in self.results),
                "results": self.results,
                "scope_notes": ["Local host TCP/UDP listeners; no public Internet dependency.",
                                "System resolver behavior is not equivalent to blocked packet egress; DNS-like UDP transport is covered.",
                                "Uncatchable runner SIGKILL cleanup and detached macOS descendants are documented limitations, not passing tests.",
                                "DSH Provider integration and actual Bash/PTC/PTY consumer acceptance require separate tests.",
                                "Permission-induced cleanup failure runs only for nonroot: root bypasses directory DAC; absence is not a passing result.",
                                "Linux-only probes do not establish Linux support when this report is from macOS, and conversely."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runner", required=True)
    parser.add_argument("--node", required=True, help="exact Node executable expected in the deployment launcher")
    parser.add_argument("--runtime-root", help="deployed package root; defaults to launcher.parent.parent")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--report", help="write complete JSON report")
    parser.add_argument("--only", help="run matching test names only (partial report)")
    parser.add_argument("--keep", action="store_true", help="retain fixture directory for investigation")
    args = parser.parse_args()
    report = Suite(args).execute()
    report["partial"] = bool(args.only)
    if args.report:
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(f"RESULT: {report['passed']} passed, {report['failed']} failed, {report['observed_limitations']} limitation observations; partial={report['partial']}")
    return 1 if report["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
