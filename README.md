# 🔀 Fuse

An internal **Mixture-of-Agents** chat tool. Ask one question → several AI models
(Claude, GPT, Grok, Gemini, or anything via OpenRouter) answer in parallel → one
"aggregator" model fuses their answers into a single best response. Tracks token
usage locally with charts.

## Stack

- **Next.js 14** (App Router) - frontend **and** backend (API routes). One process.
- **React + Tailwind** UI, **Recharts** for stats.
- **Electron** wrapper → ships as a double-clickable `Fuse.app` (no terminal).
- Provider adapters for Anthropic, OpenAI, xAI, Google, and OpenRouter.
- Token usage **and full chat history** stored locally as JSON (see *Data* below).

## Install with your coding agent (easiest)

Already have **Claude Code** or **Codex CLI**? Paste this prompt into it and it
will set Fuse up and launch it for you - no manual steps:

```
Install and launch the Fuse desktop app on my Mac from its public repo. Do this:

1. Ensure git and Node.js 18+ are available. If Node is missing, install it with Homebrew: `brew install node`.
2. Clone https://github.com/LiamBCN/fuse.git into ~/fuse and cd in (git pull if it already exists).
3. Run `npm install`.
4. Build the native app: `npm run pack`. This produces Fuse.app under dist/ (e.g. dist/mac-arm64/Fuse.app).
5. Copy that Fuse.app into /Applications and open it with `open -a Fuse`. A native window should appear.
6. If the native build fails for any reason, fall back to `npm run dev` and open http://localhost:3030 instead.

Fuse routes answers through my local Claude and Codex CLIs, so once it's open, go to Settings to confirm the detected providers and pick proposer + aggregator models. Tell me when it's running.
```

Fuse detects your installed CLIs on first launch and walks you through the rest.

## Run as a Mac app (recommended)

```bash
npm install
npm run dist        # builds dist/Fuse-<version>-arm64.dmg
```

Open the `.dmg`, drag **Fuse** to Applications, launch it. It starts its own
server internally and opens a native window - nothing to run in a terminal.
(The app is ad-hoc signed, not notarized, so the first launch may need
right-click → **Open** to get past Gatekeeper.)

## Run in the browser (dev)

```bash
npm install
npm run dev            # http://localhost:3030
# or: npm run electron:dev   - dev server + Electron window with live reload
```

1. Go to **Settings** → paste the API keys for whichever providers you want.
2. Pick your **proposer** models (they all answer) and one **aggregator** (it fuses).
3. Chat. Expand "show proposals" or hit **Debug ↗** on any answer to see what each model said.
4. **History** tab lists every conversation; open one to debug each agent's answer. **Resume** reopens it as the live chat.
5. **Stats** tab shows tokens/day, tokens by model, and estimated cost.

## How it works

```
your question
   ├─► Claude  ─┐
   ├─► GPT     ─┤   (proposers, in parallel)
   ├─► Grok    ─┤
   └─► Gemini  ─┘
                 └─► Aggregator model ──► final fused answer
```

This is the Mixture-of-Agents recipe (Together AI, ICLR 2025): models write
better answers when they can see other models' answers first.

## Data

Config (API keys + model choices), conversations, and token usage are stored as
JSON on disk:

- **Packaged app:** `~/Library/Application Support/fuse/data/` - `settings.json`,
  `conversations.json`, `usage.json`, plus `port.json` (the app reuses one
  stable local port so its origin/localStorage stay consistent across launches).
- **Dev (`npm run dev`):** `./data/` in the repo.
- Override the location with the `FUSE_DATA_DIR` env var.

Everything is durable across restarts and refreshes. A legacy config in browser
localStorage is auto-migrated into `settings.json` on first load.

## Notes

- API keys are stored **locally on this machine** in `settings.json` and sent
  per-request to the local server. They are never sent anywhere except the model
  providers you configured.
- Pricing in `lib/models.ts` is best-effort and editable; unknown models still
  track tokens, just with a $0 cost estimate.
- Add new models by typing any model id in Settings (free text + suggestions).
