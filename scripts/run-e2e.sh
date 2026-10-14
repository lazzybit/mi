#!/bin/bash
# Detached Playwright runner. Long jobs are started with `setsid --fork` so the
# remote container workflow can poll a log and an exit-status file instead of
# blocking a single command.
# Usage: run-e2e.sh <log-name> <playwright args...>
set -u
NAME="${1:?log name required}"
shift
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}"
cd "$ROOT"
rm -f "${LOG_DIR}/${NAME}.log" "${LOG_DIR}/${NAME}.done"
{
  npx playwright test "$@"
  echo $? > "${LOG_DIR}/${NAME}.done"
} > "${LOG_DIR}/${NAME}.log" 2>&1
