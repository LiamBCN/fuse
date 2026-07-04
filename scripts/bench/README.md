# Fuse benchmarking scripts

Implements the campaign tooling from [`PLAN-real-benchmark.md`](../../PLAN-real-benchmark.md).
Track A (in-house, execution-verified) runs entirely inside the app; Tracks B and
C wrap external, industry-standard harnesses and need one-time setup.

---

## Track A — in-house execution benchmark (ready now)

No setup. In the app: **Benchmarks → pick "Author Location Fields" → toggle
"Execute & verify"**. Each contender writes real code into a pinned snapshot and
is scored by the task's deterministic checks (`lib/bench-verifier.ts`), pass@1.

A campaign = one execution run per task. After running several, aggregate them:

```bash
# All execution runs, paired mode-vs-solo comparison + resolve rates:
node scripts/bench/report.mjs

# One task only, or specific runs, or write to a file:
node scripts/bench/report.mjs --task migma-author-location-fields
node scripts/bench/report.mjs <runId> <runId> --out BENCH-RESULTS.md
```

The report reads the same JSON the app writes (`$FUSE_DATA_DIR/bench/*.json`,
falling back to the packaged-app data dir, then `./data/bench`).

**What the verifier scores.** Structural, diff-based checks over the executor's
git diff — no dependencies, runs in milliseconds. Hard checks gate the binary
`resolved` verdict; soft checks are informational. This catches *coverage*
differences (did the change touch both stacks / both fields / structured data?)
which is exactly what the modes are meant to improve. It does **not** catch
subtle logic bugs — that is what Tracks B/C add.

To make a new task execution-scorable, add a `verifier` to it in
`lib/bench-tasks.ts` (see `migma-author-location-fields`). Step kinds:

- `diff`  — regex over the ADDED lines of a repo's git diff (`repo`, `pattern`, `want`, `soft`)
- `grep`  — regex over a file or directory tree (`path`, `pattern`, `want`, `soft`)
- `run`   — shell command, passes on exit 0 (`cmd`, `cwd`, `soft`) — needs deps installed

---

## Track B — Terminal-Bench 2.1 subset (external, Docker)

Terminal-Bench ships first-class **Claude Code** and **Codex CLI** adapters — the
same CLIs Fuse wraps — so solo baselines cost only subscription quota.

**Setup** (needs Docker Desktop running):

```bash
uv tool install terminal-bench            # provides the `tb` CLI
tb --version
```

**Fixed subset.** Pick ~12 tasks once, spanning categories, and never resample
(resampling is p-hacking). Record them in `tb-subset.txt` (one task-id per line).
List available tasks:

```bash
tb list --dataset terminal-bench-core==2.1
```

**Solo baselines** (free-ish — just quota):

```bash
while read -r id; do
  [ -z "$id" ] && continue
  tb run --dataset terminal-bench-core==2.1 --agent claude-code --task-id "$id"
  tb run --dataset terminal-bench-core==2.1 --agent codex        --task-id "$id"
done < scripts/bench/tb-subset.txt
```

**Fuse modes.** Two options (start with the fallback — far less glue):

1. *Plan-prepend fallback:* generate a mode plan via Fuse, prepend it to the task
   instruction, and run the stock `claude-code` adapter. Same measurement, no
   custom adapter.
2. *Custom Harbor adapter:* implement an agent adapter that calls a headless
   `runPlan` → executor. Only worth it if the fallback proves the signal.

`tb` writes per-task JSON results; ingest them into a Fuse-shaped record with a
small importer if you want them in the Benchmarks UI (not built yet — Track B is
scaffolding).

---

## Track C — SWE-bench Verified Mini (external, cloud eval)

50-task stratified subset (`MariusHobbhahn/swe-bench-verified-mini`, ~5 GB vs
130 GB) used by Princeton's HAL leaderboard. Evaluate patches in the cloud via
`sb-cli` to sidestep arm64 Docker entirely.

```bash
pip install sb-cli          # official remote evaluator
# 1. For each instance: clone repo@base_commit, run contender, capture `git diff`.
# 2. Assemble predictions.json { instance_id: { model_patch, model_name_or_path } }.
# 3. Score in the cloud (subset by ids):
sb-cli submit swe-bench_verified test \
  --predictions_path predictions.json \
  --instance_ids <id1> <id2> ... \
  --run_id fuse-modes-$(date +%Y%m%d)
```

Report the paired mode-vs-solo delta, not the absolute number: N≈25 → ±~13pp at
95% CI, so absolutes are only loosely comparable to lab-reported figures.

---

## Statistics note

With 15–50 tasks you can only resolve ~10–15pp deltas from raw scores. The
`report.mjs` paired sign-test is the tighter test: it compares mode+exec vs the
solo executor **on the same tasks**, which removes per-task difficulty variance.
See Anthropic, *Adding Error Bars to Evals* (arXiv:2411.00640).
