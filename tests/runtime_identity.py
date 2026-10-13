"""Inspect the actual Node executable and compiled entry used by a test run."""
import ctypes
import os
from pathlib import Path
import re
import subprocess
import sys


def capture_runtime_identity(runner, node, runtime_root=None):
    launcher = Path(runner).resolve(strict=True)
    return {"launcher": str(launcher), "node_executable": str(Path(node).resolve(strict=True)),
            "runtime_root": str(Path(runtime_root).resolve(strict=True) if runtime_root else launcher.parent.parent)}


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
    """Verify the actual running interpreter and entry file."""
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
        raise AssertionError(f"runner entry is not the expected {expected_entry}")
    version = subprocess.check_output([str(expected_node), "--version"], text=True,
                                      env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}).strip()
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", version)
    if not match or tuple(map(int, match.groups())) < (24, 19, 0):
        raise AssertionError(f"unsupported observed Node version: {version}")
    return {"observed_executable": str(actual), "node_version": version,
            "observed_entry": str(Path(entries[0]).resolve(strict=True)),
            "exact_deployed_entry_verified": True,
            "evidence": "host process executable and argument vector; independent of CLI self-description"}
