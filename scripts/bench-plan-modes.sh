#!/bin/zsh
# Headless plan-mode benchmark: run one mode through a live Fuse server's
# /api/chat (the REAL pipeline, exactly as the UI drives it) and capture the
# SSE stream + timing. Pair with scripts/bench/extract-result.py to pull the
# final plan, per-stage sizes, and token usage out of the stream.
#
#   scripts/bench-plan-modes.sh <fast|deep> [options]
#     --url URL          Fuse server (default http://127.0.0.1:3030)
#     --prompt FILE      request text (default scripts/bench/prompt-migma.txt)
#     --workdir DIR      target repo the agents read (default /Users/liam/migma-both)
#     --out DIR          output dir (default scripts/bench/out)
#
# Quality gate (see PLAN-two-mode-consolidation.md): after a pipeline change,
# run both modes on the same prompt and judge the plans blind against a
# ground-truth rubric before shipping.
# For judged comparisons with solo-model baselines, use the Benchmarks page or
# POST /api/bench instead; this script intentionally exercises /api/chat.
set -u
MODE="${1:?usage: bench-plan-modes.sh <fast|deep> [--url ..] [--prompt ..] [--workdir ..] [--out ..]}"
shift
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="http://127.0.0.1:3030"
PROMPT_FILE="$ROOT/scripts/bench/prompt-migma.txt"
WORKDIR="/Users/liam/migma-both"
OUT_DIR="$ROOT/scripts/bench/out"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --prompt) PROMPT_FILE="$2"; shift 2 ;;
    --workdir) WORKDIR="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
BASE="$OUT_DIR/$MODE-$STAMP"

python3 - "$MODE" "$PROMPT_FILE" "$WORKDIR" > "$BASE.payload.json" <<'PY'
import json, sys
mode, prompt_file, workdir = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
  "messages": [{"role": "user", "content": open(prompt_file).read()}],
  "proposers": [
    {"provider": "claude-cli", "model": "sonnet"},
    {"provider": "codex-cli", "model": "default"},
  ],
  "aggregator": {"provider": "claude-cli", "model": "opus"},
  "conversationId": f"bench-{mode}",
  "workdir": workdir,
  "mode": mode,
}))
PY

START=$(date +%s)
curl -sN --max-time 5400 -H "content-type: application/json" \
  --data-binary "@$BASE.payload.json" "$URL/api/chat" > "$BASE.sse"
RC=$?
END=$(date +%s)
{
  echo "mode=$MODE"
  echo "url=$URL"
  echo "rc=$RC"
  echo "elapsed_s=$((END - START))"
} > "$BASE.meta"
echo "[$MODE] rc=$RC elapsed=$((END - START))s -> $BASE.sse"
python3 "$ROOT/scripts/bench/extract-result.py" "$BASE"
