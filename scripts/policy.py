#!/usr/bin/env python3
"""Print a complete rules-only policy without loading workspace configuration."""
import argparse
import json
from pathlib import Path


def existing(value):
    try:
        path = Path(value).expanduser().resolve(strict=True)
    except OSError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc
    if not (path.is_dir() or path.is_file()):
        raise argparse.ArgumentTypeError("only existing files/directories are supported")
    return {"path": str(path), "scope": "tree" if path.is_dir() else "file"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=existing, required=True)
    parser.add_argument("--mode", choices=["read-only", "workspace-write"], default="workspace-write")
    parser.add_argument("--network", choices=["deny", "host"], default="deny")
    parser.add_argument("--protect", type=existing, action="append", default=[])
    parser.add_argument("--deny-read", type=existing, action="append", default=[])
    args = parser.parse_args()
    if args.workspace["scope"] != "tree":
        parser.error("workspace must be a directory")
    writable = args.mode == "workspace-write"
    print(json.dumps({"version": 1,
                      "filesystem": {"read": "host", "denyRead": args.deny_read,
                                     "allowWrite": [args.workspace] if writable else [],
                                     "denyWrite": args.protect, "temp": "private" if writable else "none"},
                      "network": {"mode": args.network},
                      "ipc": {"hostUnixSockets": "deny"},
                      "environment": {"inherit": ["PATH", "HOME", "LANG", "LC_ALL", "TZ"]}},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
