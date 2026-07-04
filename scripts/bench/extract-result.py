#!/usr/bin/env python3
"""Extract the final result from a bench SSE capture.

Usage: extract-result.py <base>   (reads <base>.sse; writes <base>.plan.md and
<base>.stages.json, prints a per-stage summary table)
"""
import json
import sys


def main() -> int:
    base = sys.argv[1]
    result = None
    last_progress = None
    for line in open(base + ".sse"):
        line = line.strip()
        if not line.startswith("data: "):
            continue
        try:
            ev = json.loads(line[len("data: "):])
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "result":
            result = ev
        elif ev.get("type") == "progress":
            last_progress = ev
        elif ev.get("type") == "error":
            print(f"ERROR event: {ev.get('error')}")
    if not result:
        print(f"no result event (last progress: {last_progress and last_progress.get('label')})")
        return 1

    with open(base + ".plan.md", "w") as f:
        f.write(result.get("final", ""))
    stages = [
        {
            "model": p.get("model"),
            "provider": p.get("provider"),
            "error": p.get("error"),
            "chars": len(p.get("content") or ""),
            "usage": p.get("usage"),
        }
        for p in result.get("proposals", [])
    ]
    with open(base + ".stages.json", "w") as f:
        json.dump(
            {k: result.get(k) for k in ("usage", "planPath", "files", "needsClarification", "questions")}
            | {"stages": stages},
            f,
            indent=2,
        )

    u = result.get("usage") or {}
    print(f"plan: {len(result.get('final', ''))} chars -> {base}.plan.md")
    print(f"usage: {u.get('total_tokens', 0):,} total ({u.get('prompt_tokens', 0):,} in / {u.get('completion_tokens', 0):,} out)")
    print(f"planPath: {result.get('planPath')}")
    for s in stages:
        err = "ERROR " if s["error"] else ""
        tok = s["usage"] or {}
        print(f"  {err}{s['provider']}/{s['model']}: {s['chars']:,} chars, {tok.get('total_tokens', 0):,} tok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
