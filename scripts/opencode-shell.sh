#!/bin/sh
# OpenCode passes the ORIGINAL command as one argument. It never becomes shell
# source outside the OS boundary. The installer binds the canonical runner path.
if [ "$#" -ne 2 ] || [ "$1" != '-c' ] || [ -z "$SANDBOX_RUNTIME_POLICY" ]; then
  printf '%s\n' 'sandbox-runtime: invalid OpenCode Bash invocation' >&2
  exit 125
fi
sandbox_policy=$SANDBOX_RUNTIME_POLICY
unset SANDBOX_RUNTIME_POLICY NODE_OPTIONS NODE_PATH BASH_ENV ENV
exec __RUNNER__ run --policy-json "$sandbox_policy" -- /bin/bash -c "$2"
