#!/usr/bin/env bash
set -euo pipefail

task_id="${1:-}"
base_url="${2:-${FUSE_BENCH_URL:-http://127.0.0.1:3030}}"

if [[ -z "$task_id" ]]; then
  echo "Usage: scripts/bench-snapshot.sh <taskId> [baseUrl]" >&2
  exit 2
fi

curl -fsS -X POST "${base_url%/}/api/bench/tasks/${task_id}/snapshot"
echo
