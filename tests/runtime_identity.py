"""Content identity for the deployed interpreted Runtime, independent of its CLI.

A launcher-only hash is insufficient: changing Node or a loaded JS file changes
what executes. Metadata paths are reported, while the aggregate content hash uses
stable logical artifact names so equal deployed bytes can be compared directly.
"""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


def capture_runtime_identity(runner, node, runtime_root=None):
    launcher = Path(runner).resolve(strict=True)
    executable = Path(node).resolve(strict=True)
    root = Path(runtime_root).resolve(strict=True) if runtime_root else launcher.parent.parent
    if root != launcher.parent.parent or launcher.parent.name != "bin":
        raise ValueError("runtime root must be the package containing the bin/ launcher")
    dist = root / "dist"
    package = root / "package.json"
    if not dist.is_dir() or not package.is_file():
        raise ValueError("TypeScript deployment requires dist/ and package.json; old native-binary evidence is not reusable")
    if dist.is_symlink():
        raise ValueError("deployed dist directory must be a real directory for closure inventory")
    try:
        relative_launcher = launcher.relative_to(root)
    except ValueError as exc:
        raise ValueError("launcher must be inside the declared runtime root") from exc
    files = []

    def add(role, logical, path):
        if path.is_symlink():
            raise ValueError(f"runtime artifact symlink requires explicit closure handling: {path}")
        metadata = path.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"not a regular runtime artifact: {path}")
        files.append({"role": role, "artifact": logical, "path": str(path),
                      "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                      "size": metadata.st_size, "mode": oct(stat.S_IMODE(metadata.st_mode))})

    add("launcher", str(relative_launcher), launcher)
    add("node", "node-executable", executable)
    add("metadata", "package.json", package)
    deployed = sorted(dist.rglob("*"))
    for path in deployed:
        if path.is_symlink():
            raise ValueError(f"symlink in deployed closure: {path}")
        if path.is_file():
            add("deployed", str(path.relative_to(root)), path)
    if not any(item["artifact"].endswith(".js") for item in files if item["role"] == "deployed"):
        raise ValueError("deployment contains no compiled JavaScript")
    files.sort(key=lambda item: (item["role"], item["artifact"]))
    content_manifest = [{key: value for key, value in item.items() if key != "path"} for item in files]
    canonical = json.dumps(content_manifest, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()
    return {"kind": "typescript-node-deployment-v1", "runtime_root": str(root),
            "launcher": str(launcher), "node_executable": str(executable),
            "closure_sha256": hashlib.sha256(canonical).hexdigest(), "artifacts": files,
            "hash_scope": "launcher, canonical Node executable, package.json and every regular file under dist; includes test/build metadata if deployed"}


def assert_runtime_unchanged(before, runner, node, runtime_root=None):
    after = capture_runtime_identity(runner, node, runtime_root)
    if before["closure_sha256"] != after["closure_sha256"]:
        raise AssertionError("interpreted runtime closure changed during execution; rerun against a stable deployment")
    return after


def _darwin_argv(pid):
    # KERN_PROCARGS2 returns argc, the executable path, padding, then the actual
    # NUL-delimited argument vector. Unlike ps text this preserves path spaces.
    libc = ctypes.CDLL(None, use_errno=True)
    libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint,
                           ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
                           ctypes.c_void_p, ctypes.c_size_t]
    libc.sysctl.restype = ctypes.c_int
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2, owned PID.
    length = ctypes.c_size_t()
    if libc.sysctl(mib, 3, None, ctypes.byref(length), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "cannot size owned process argument vector")
    buffer = ctypes.create_string_buffer(length.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(length), None, 0) != 0:
        raise OSError(ctypes.get_errno(), "cannot read owned process argument vector")
    data = buffer.raw[:length.value]
    argc = int.from_bytes(data[:4], byteorder=sys.byteorder, signed=True)
    if argc < 1 or argc > 65536:
        raise ValueError("invalid process argument count")
    cursor = data.index(b"\0", 4) + 1
    while cursor < len(data) and data[cursor] == 0:
        cursor += 1
    arguments = []
    for _ in range(argc):
        end = data.index(b"\0", cursor)
        arguments.append(os.fsdecode(data[cursor:end]))
        cursor = end + 1
    return arguments


def observe_runtime_process(pid, identity):
    """Bind content identity to the actual running interpreter and entry file."""
    expected_node = Path(identity["node_executable"])
    expected_entry = Path(identity["runtime_root"]) / "dist/src/cli.js"
    if sys.platform == "linux":
        actual = Path(os.readlink(f"/proc/{pid}/exe")).resolve(strict=True)
        arguments = [os.fsdecode(value) for value in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if value]
    elif sys.platform == "darwin":
        library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        library.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        library.proc_pidpath.restype = ctypes.c_int
        buffer = ctypes.create_string_buffer(4096)
        if library.proc_pidpath(pid, buffer, len(buffer)) <= 0:
            raise OSError(ctypes.get_errno(), "cannot inspect owned runtime process")
        actual = Path(os.fsdecode(buffer.value)).resolve(strict=True)
        arguments = _darwin_argv(pid)
    else:
        raise ValueError("process identity requires a supported macOS or Linux host")
    if not os.path.samefile(actual, expected_node):
        raise AssertionError(f"runner executes {actual}, expected {expected_node}")
    # The generated bootstrap supports only flag-form Node options before its
    # script. An option requiring an independent value would fail this check,
    # rather than accidentally treating a later payload argument as the entry.
    entries = [value for value in arguments[1:] if not value.startswith("-")]
    if not entries or not os.path.samefile(entries[0], expected_entry):
        raise AssertionError(f"runner entry is not the fingerprinted {expected_entry}")
    version = subprocess.check_output([str(expected_node), "--version"], text=True,
                                      env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}).strip()
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", version)
    if not match or tuple(map(int, match.groups())) < (24, 19, 0):
        raise AssertionError(f"unsupported observed Node version: {version}")
    return {"observed_executable": str(actual), "node_version": version,
            "observed_entry": str(Path(entries[0]).resolve(strict=True)),
            "exact_deployed_entry_verified": True,
            "evidence": "host process executable and argument vector; independent of CLI self-description"}
