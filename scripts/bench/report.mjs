#!/usr/bin/env node
// Campaign report for execution benchmarks (Track A of PLAN-real-benchmark.md).
//
// Each Fuse benchmark run scores ONE task. A "campaign" is several execution
// runs (one per task) with the same contenders. This script reads those run
// JSONs and produces:
//   1. A per-contender aggregate: resolve rate (± Wilson 95% CI), checks %,
//      time, tokens — summed across every task.
//   2. A PAIRED comparison of each mode+exec contender against the solo
//      baseline that uses the executor model, task by task, with a two-sided
//      sign-test p-value. Paired-per-task is the only way ~15-20 tasks can
//      resolve deltas under ~10-15pp (see the plan's stats note).
//
// No dependencies — reads the same JSON files the app writes.
//
//   node scripts/bench/report.mjs                 # all execution runs
//   node scripts/bench/report.mjs --task migma-author-location-fields
//   node scripts/bench/report.mjs <runId> <runId> # explicit runs
//   node scripts/bench/report.mjs --out BENCH-RESULTS.md
//
// Point it at a data dir with FUSE_DATA_DIR, or it will try the packaged-app
// location and then ./data.

import { promises as fs } from "fs";
import path from "path";
import os from "os";

function benchDirCandidates() {
  const out = [];
  if (process.env.FUSE_DATA_DIR) out.push(path.join(process.env.FUSE_DATA_DIR, "bench"));
  out.push(path.join(os.homedir(), "Library", "Application Support", "fuse", "bench"));
  out.push(path.join(process.cwd(), "data", "bench"));
  return out;
}

async function firstExistingDir(dirs) {
  for (const dir of dirs) {
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) return dir;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function contenderLabel(spec) {
  if (!spec) return "?";
  if (spec.kind === "solo") return `${spec.model.provider}/${spec.model.model} · solo`;
  return `${spec.mode} · ${spec.proposers.map((p) => p.model).join(" + ")} → ${spec.aggregator.model}`;
}

function isSolo(spec) {
  return spec?.kind === "solo";
}

// The paired baseline is the solo contender whose model is the run's executor;
// falls back to the first solo contender in the run.
function baselineLabel(run) {
  const solos = run.results.filter((r) => isSolo(r.spec));
  if (!solos.length) return null;
  const ex = run.config.executor;
  const match = ex && solos.find((r) => r.spec.model.provider === ex.provider && r.spec.model.model === ex.model);
  return contenderLabel((match ?? solos[0]).spec);
}

// Wilson score interval half-width-ish bounds for a binomial proportion.
function wilson(passed, total) {
  if (!total) return { lo: 0, hi: 0, p: 0 };
  const z = 1.96;
  const phat = passed / total;
  const denom = 1 + (z * z) / total;
  const center = (phat + (z * z) / (2 * total)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat)) / total + (z * z) / (4 * total * total))) / denom;
  return { lo: Math.max(0, center - margin) * 100, hi: Math.min(1, center + margin) * 100, p: phat * 100 };
}

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c;
}

// Two-sided exact sign test on wins vs losses (ties dropped).
function signTestP(wins, losses) {
  const n = wins + losses;
  if (n === 0) return 1;
  const kMax = Math.min(wins, losses);
  let tail = 0;
  for (let k = 0; k <= kMax; k++) tail += choose(n, k) * Math.pow(0.5, n);
  return Math.min(1, 2 * tail);
}

const fmtPct = (n) => (n === undefined || Number.isNaN(n) ? "—" : `${n.toFixed(1)}%`);
const fmtMs = (ms) => {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
};
const fmtNum = (n) => (n === undefined ? "—" : Math.round(n).toLocaleString());

async function main() {
  const args = process.argv.slice(2);
  let outFile = null;
  let taskFilter = null;
  const explicitIds = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") outFile = args[++i];
    else if (args[i] === "--task") taskFilter = args[++i];
    else explicitIds.push(args[i].replace(/\.json$/, ""));
  }

  const dir = await firstExistingDir(benchDirCandidates());
  if (!dir) {
    console.error("No bench data dir found. Set FUSE_DATA_DIR or run a benchmark first.");
    process.exit(1);
  }

  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const runs = [];
  for (const f of files) {
    try {
      const run = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
      if (!run?.config?.execute) continue; // execution runs only
      if (taskFilter && run.config.taskId !== taskFilter) continue;
      if (explicitIds.length && !explicitIds.includes(run.id)) continue;
      runs.push(run);
    } catch {
      /* skip unreadable/legacy files */
    }
  }

  if (!runs.length) {
    console.error("No execution benchmark runs matched. Run one with Execute & verify enabled.");
    process.exit(1);
  }
  runs.sort((a, b) => a.createdAt - b.createdAt);

  // ---- Per-contender aggregate across all matched runs/tasks -------------
  const agg = new Map(); // label -> { resolved, attempts, checksSum, timeSum, tokenSum, isSolo }
  for (const run of runs) {
    for (const r of run.results) {
      if (!r.verifier) continue;
      const label = contenderLabel(r.spec);
      const a = agg.get(label) ?? { resolved: 0, attempts: 0, checksSum: 0, timeSum: 0, tokenSum: 0, isSolo: isSolo(r.spec) };
      a.attempts++;
      if (r.verifier.resolved) a.resolved++;
      a.checksSum += r.verifier.totalSteps ? (r.verifier.passedSteps / r.verifier.totalSteps) * 100 : 0;
      a.timeSum += r.elapsedMs ?? 0;
      a.tokenSum += r.usage?.total_tokens ?? 0;
      agg.set(label, a);
    }
  }

  // ---- Paired: each mode contender vs the per-run solo executor baseline --
  // Aggregate over reps within a run to a single resolved-per-task signal
  // (a task counts as resolved for a contender if any rep resolved it).
  const resolvedByRunLabel = new Map(); // `${runId}::${label}` -> boolean
  for (const run of runs) {
    for (const r of run.results) {
      if (!r.verifier) continue;
      const key = `${run.id}::${contenderLabel(r.spec)}`;
      resolvedByRunLabel.set(key, (resolvedByRunLabel.get(key) ?? false) || !!r.verifier.resolved);
    }
  }
  const modeLabels = [...agg.keys()].filter((l) => !agg.get(l).isSolo);
  const paired = [];
  for (const label of modeLabels) {
    let wins = 0, losses = 0, ties = 0, tasksCompared = 0;
    for (const run of runs) {
      const base = baselineLabel(run);
      if (!base) continue;
      const modeKey = `${run.id}::${label}`;
      const baseKey = `${run.id}::${base}`;
      if (!resolvedByRunLabel.has(modeKey) || !resolvedByRunLabel.has(baseKey)) continue;
      tasksCompared++;
      const m = resolvedByRunLabel.get(modeKey);
      const b = resolvedByRunLabel.get(baseKey);
      if (m && !b) wins++;
      else if (!m && b) losses++;
      else ties++;
    }
    paired.push({ label, wins, losses, ties, tasksCompared, p: signTestP(wins, losses) });
  }

  // ---- Render -------------------------------------------------------------
  const L = [];
  L.push(`# Fuse execution benchmark — campaign report`);
  L.push("");
  L.push(`- Runs: ${runs.length} · Tasks: ${new Set(runs.map((r) => r.config.taskId)).size}`);
  L.push(`- Generated from \`${dir}\``);
  L.push("");

  L.push(`## Resolve rate by contender`);
  L.push("");
  L.push(`| Contender | Resolved | Rate (95% CI) | Checks % | Avg time | Avg tokens |`);
  L.push(`|---|---|---|---|---|---|`);
  const rows = [...agg.entries()].sort((a, b) => b[1].resolved / b[1].attempts - a[1].resolved / a[1].attempts);
  for (const [label, a] of rows) {
    const w = wilson(a.resolved, a.attempts);
    L.push(
      `| ${label} | ${a.resolved}/${a.attempts} | ${fmtPct(w.p)} (${fmtPct(w.lo)}–${fmtPct(w.hi)}) | ${fmtPct(a.checksSum / a.attempts)} | ${fmtMs(a.timeSum / a.attempts)} | ${fmtNum(a.tokenSum / a.attempts)} |`,
    );
  }
  L.push("");

  L.push(`## Paired: mode+exec vs solo executor baseline`);
  L.push("");
  if (!paired.length) {
    L.push(`_No mode contenders found to pair._`);
  } else {
    L.push(`Per task: does the mode+exec pipeline resolve a task the solo executor did not? Ties (both pass or both fail) carry no signal.`);
    L.push("");
    L.push(`| Mode contender | Tasks | Wins | Losses | Ties | Sign-test p |`);
    L.push(`|---|---|---|---|---|---|`);
    for (const r of paired) {
      L.push(`| ${r.label} | ${r.tasksCompared} | ${r.wins} | ${r.losses} | ${r.ties} | ${r.p.toFixed(3)} |`);
    }
    L.push("");
    L.push(`> Reading: a mode "beats solo" when Wins > Losses and p < 0.1. With few tasks, p rarely clears 0.05 — that is the honest floor, not a failure of the mode. Widen the task set to tighten it.`);
  }
  L.push("");

  L.push(`## Per-task detail`);
  L.push("");
  for (const run of runs) {
    L.push(`### ${run.config.taskTitle || run.config.taskId || run.id}`);
    L.push(`Run \`${run.id}\` · executor ${run.config.executor ? `${run.config.executor.provider}/${run.config.executor.model}` : "—"} · reps ${run.config.reps}`);
    L.push("");
    L.push(`| Contender | Resolved | Hard | Checks % | Time |`);
    L.push(`|---|---|---|---|---|`);
    for (const r of run.results) {
      if (!r.verifier) continue;
      const v = r.verifier;
      L.push(
        `| ${contenderLabel(r.spec)}${r.rep > 1 ? ` · rep ${r.rep}` : ""} | ${v.resolved ? "✓" : "✗"} | ${v.hardPassed}/${v.hardTotal} | ${fmtPct(v.totalSteps ? (v.passedSteps / v.totalSteps) * 100 : 0)} | ${fmtMs(r.elapsedMs)} |`,
      );
    }
    L.push("");
  }

  const md = L.join("\n");
  if (outFile) {
    await fs.writeFile(outFile, md, "utf8");
    console.error(`Wrote ${outFile}`);
  } else {
    process.stdout.write(md + "\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
