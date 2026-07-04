#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${FUSE_URL:-http://127.0.0.1:${PORT:-3030}}"

curl -fsS "$BASE_URL/api/limits?force=1" | node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const fmt = (provider) => {
  const item = data[provider];
  if (!item) return `${provider}: missing`;
  if (item.error) return `${provider}: unavailable (${item.error})`;
  const win = (w) => w ? `${w.usedPercent}% reset=${w.resetsAt ? new Date(w.resetsAt).toISOString() : "unknown"}` : "missing";
  const extra = provider === "codex" && item.planType ? ` plan=${item.planType}` : "";
  return `${provider}: 5h ${win(item.session)} · weekly ${win(item.weekly)}${extra}`;
};
console.log(fmt("claude"));
console.log(fmt("codex"));
'
