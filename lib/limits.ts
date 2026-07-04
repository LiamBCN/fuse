// Server-only usage-limit fetchers. These sources are intentionally best-effort:
// Claude's OAuth usage endpoint and Codex rollout JSONL files are not public
// stability contracts, so callers get ProviderLimits.error instead of throws.
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { readSettings } from "./settings-store";
import type {
  LimitSnapshot,
  LimitWindow,
  ProviderLimitDelta,
  ProviderLimits,
  UsageLimitDeltas,
} from "./types";

const execFileAsync = promisify(execFile);
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CACHE_TTL_MS = 45_000;
const HTTP_TIMEOUT_MS = 5_000;
const TAIL_BYTES = 512 * 1024;
// Hard floor between real calls to Anthropic's usage endpoint. Even a forced
// refresh (chat/bench delta capture, the Nav widget) inside this window is
// served from cache instead of hitting the network - this is what stops the
// bursty traffic that was tripping the 429.
const MIN_REQUEST_INTERVAL_MS = 30_000;
// After a 429/529, wait at least this long before the next real call (unless
// the response's Retry-After asks for more), and keep serving the last snapshot.
const RATE_LIMIT_BACKOFF_MS = 120_000;

type CacheEntry = { value: ProviderLimits; expiresAt: number };

const g = globalThis as typeof globalThis & {
  __fuseLimitsCache?: {
    claude?: CacheEntry;
    codex?: CacheEntry;
  };
  __fuseClaudeTokenSource?: "env" | "settings" | "keychain" | null;
  // Throttle state for the Claude usage endpoint: one shared in-flight request
  // (so a burst of callers collapses to a single fetch) and the earliest time
  // we're allowed to hit the network again.
  __fuseClaudeGuard?: { inflight?: Promise<ProviderLimits> | null; nextAllowedAt?: number };
};
const cache = (g.__fuseLimitsCache ??= {});
const claudeGuard = (g.__fuseClaudeGuard ??= {});

function now() {
  return Date.now();
}

function errorLimits(provider: ProviderLimits["provider"], error: string): ProviderLimits {
  return {
    provider,
    session: null,
    weekly: null,
    fetchedAt: now(),
    error,
  };
}

function cached(entry: CacheEntry | undefined, force: boolean | undefined): ProviderLimits | null {
  if (!force && entry && entry.expiresAt > now()) return entry.value;
  return null;
}

function store(provider: ProviderLimits["provider"], value: ProviderLimits, cacheable: boolean): ProviderLimits {
  if (cacheable) cache[provider] = { value, expiresAt: now() + CACHE_TTL_MS };
  return value;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function percent(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n === null) return null;
  return Math.max(0, Math.min(100, n));
}

function epochMs(value: unknown): number | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const n = finiteNumber(value);
  if (n === null || n <= 0) return null;
  return n < 10_000_000_000 ? n * 1000 : n;
}

function claudeWindow(input: any, fallbackMinutes: number): LimitWindow | null {
  if (!input || typeof input !== "object") return null;
  const used = percent(input.utilization ?? input.percent ?? input.used_percent);
  if (used === null) return null;
  return {
    usedPercent: used,
    resetsAt: epochMs(input.resets_at),
    windowMinutes: finiteNumber(input.window_minutes) ?? fallbackMinutes,
  };
}

function codexWindow(input: any, fallbackMinutes: number): LimitWindow | null {
  if (!input || typeof input !== "object") return null;
  const used = percent(input.used_percent ?? input.percent ?? input.utilization);
  if (used === null) return null;
  return {
    usedPercent: used,
    resetsAt: epochMs(input.resets_at),
    windowMinutes: finiteNumber(input.window_minutes) ?? fallbackMinutes,
  };
}

async function tokenFromSettings(): Promise<string | undefined> {
  try {
    return (await readSettings()).claudeOauthToken?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function tokenFromKeychain(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 3_000, maxBuffer: 64 * 1024 },
    );
    const raw = stdout.trim();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    const token = parsed?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function resolveClaudeToken(): Promise<string | undefined> {
  const preferred = g.__fuseClaudeTokenSource;
  const trySource = async (source: typeof preferred): Promise<string | undefined> => {
    if (source === "env") return process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || undefined;
    if (source === "settings") return tokenFromSettings();
    if (source === "keychain") return tokenFromKeychain();
    return undefined;
  };

  if (preferred) {
    const token = await trySource(preferred);
    if (token) return token;
  }

  const ordered: NonNullable<typeof preferred>[] = ["env", "settings", "keychain"];
  for (const source of ordered) {
    const token = await trySource(source);
    if (token) {
      g.__fuseClaudeTokenSource = source;
      return token;
    }
  }
  g.__fuseClaudeTokenSource = null;
  return undefined;
}

function scopedClaudeLimits(data: any): { label: string; usedPercent: number }[] | undefined {
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const scoped = limits
    .filter((item: any) => item?.kind === "weekly_scoped")
    .map((item: any) => {
      const used = percent(item.percent ?? item.utilization);
      const label =
        item?.scope?.model?.display_name ??
        item?.scope?.model?.name ??
        item?.scope?.model ??
        item?.scope?.name ??
        "Scoped weekly";
      return used === null ? null : { label: String(label), usedPercent: used };
    })
    .filter((item: { label: string; usedPercent: number } | null): item is { label: string; usedPercent: number } => !!item);
  return scoped.length ? scoped : undefined;
}

function normalizeClaude(data: any): ProviderLimits {
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  const sessionFallback = limits.find((item: any) => item?.kind === "session");
  const weeklyFallback = limits.find((item: any) => item?.kind === "weekly_all");
  return {
    provider: "claude",
    session: claudeWindow(data?.five_hour, 300) ?? claudeWindow(sessionFallback, 300),
    weekly: claudeWindow(data?.seven_day, 10080) ?? claudeWindow(weeklyFallback, 10080),
    scoped: scopedClaudeLimits(data),
    fetchedAt: now(),
  };
}

// Parse a Retry-After header (delta-seconds or an HTTP date) into milliseconds.
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now()) : null;
}

// The actual outbound request. Reserves the next slot up front so rapid callers
// are pushed past MIN_REQUEST_INTERVAL, and extends the cooldown on a 429/529.
async function requestClaudeLimits(): Promise<ProviderLimits> {
  claudeGuard.nextAllowedAt = now() + MIN_REQUEST_INTERVAL_MS;
  try {
    const token = await resolveClaudeToken();
    if (!token) return store("claude", errorLimits("claude", "Claude OAuth token unavailable."), true);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(CLAUDE_USAGE_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: ac.signal,
        cache: "no-store",
      });
      if (!res.ok) {
        if (res.status === 429 || res.status === 529) {
          const retryMs = parseRetryAfter(res.headers.get("retry-after"));
          claudeGuard.nextAllowedAt = now() + Math.max(retryMs ?? 0, RATE_LIMIT_BACKOFF_MS);
          // A 429 here is self-inflicted throttling, not a usage problem. If we
          // already have real numbers, keep showing them (re-cached) instead of
          // replacing the widget with an error.
          const prev = cache.claude?.value;
          if (prev && !prev.error) return store("claude", prev, true);
        }
        return store("claude", errorLimits("claude", `Claude usage unavailable (${res.status}).`), true);
      }
      return store("claude", normalizeClaude(await res.json()), true);
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    return store("claude", errorLimits("claude", aborted ? "Claude usage request timed out." : e?.message ?? String(e)), true);
  }
}

export async function fetchClaudeLimits(options: { force?: boolean } = {}): Promise<ProviderLimits> {
  // Fresh within the cache window: serve it (unless the caller forces a refresh).
  const hit = cached(cache.claude, options.force);
  if (hit) return hit;

  // Collapse a burst of concurrent callers onto a single in-flight request.
  if (claudeGuard.inflight) return claudeGuard.inflight;

  // Rate floor + post-429 backoff: don't touch the endpoint again yet, even for
  // a forced refresh. Serve the last known snapshot so the UI keeps showing
  // something and we stop generating requests.
  if (claudeGuard.nextAllowedAt && now() < claudeGuard.nextAllowedAt) {
    return cache.claude?.value ?? errorLimits("claude", "Claude usage temporarily throttled.");
  }

  const inflight = requestClaudeLimits().finally(() => {
    if (claudeGuard.inflight === inflight) claudeGuard.inflight = null;
  });
  claudeGuard.inflight = inflight;
  return inflight;
}

async function readDirNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

async function codexRolloutCandidates(threadId?: string): Promise<string[]> {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const out: string[] = [];
  let scannedDays = 0;
  for (const year of (await readDirNames(root)).filter((name) => /^\d{4}$/.test(name)).slice(0, 4)) {
    const yearDir = path.join(root, year);
    for (const month of (await readDirNames(yearDir)).filter((name) => /^\d{2}$/.test(name))) {
      const monthDir = path.join(yearDir, month);
      for (const day of (await readDirNames(monthDir)).filter((name) => /^\d{2}$/.test(name))) {
        scannedDays++;
        const dayDir = path.join(monthDir, day);
        let files: string[];
        try {
          files = await fs.readdir(dayDir);
        } catch {
          continue;
        }
        const rollouts = files
          .filter((name) => /^rollout-.*\.jsonl$/.test(name))
          .filter((name) => !threadId || name.endsWith(`-${threadId}.jsonl`) || name.includes(threadId))
          .sort((a, b) => b.localeCompare(a))
          .map((name) => path.join(dayDir, name));
        out.push(...rollouts);
        if (threadId && out.length) return out;
        if (!threadId && out.length >= 10) return out;
        if (scannedDays >= 45) return out;
      }
    }
  }
  return out;
}

async function readTail(file: string): Promise<string> {
  const stat = await fs.stat(file);
  const size = Math.min(stat.size, TAIL_BYTES);
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, stat.size - size);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

function findRateLimits(value: any, depth = 0): any {
  if (!value || typeof value !== "object" || depth > 5) return null;
  if (value.rate_limits && typeof value.rate_limits === "object") return value.rate_limits;
  for (const child of Object.values(value)) {
    const found = findRateLimits(child, depth + 1);
    if (found) return found;
  }
  return null;
}

async function parseCodexRollout(file: string): Promise<ProviderLimits | null> {
  const text = await readTail(file);
  const lines = text.split("\n").reverse();
  for (const line of lines) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const parsed = JSON.parse(line);
      const rateLimits = findRateLimits(parsed);
      if (!rateLimits) continue;
      return {
        provider: "codex",
        session: codexWindow(rateLimits.primary, 300),
        weekly: codexWindow(rateLimits.secondary, 10080),
        planType: typeof rateLimits.plan_type === "string" ? rateLimits.plan_type : undefined,
        fetchedAt: now(),
      };
    } catch {
      /* keep scanning older lines */
    }
  }
  return null;
}

export async function fetchCodexLimits(options: { force?: boolean; threadId?: string } = {}): Promise<ProviderLimits> {
  const cacheable = !options.threadId;
  const hit = cacheable ? cached(cache.codex, options.force) : null;
  if (hit) return hit;

  try {
    const files = await codexRolloutCandidates(options.threadId);
    if (!files.length) {
      return store("codex", errorLimits("codex", "No Codex rollout files found."), cacheable);
    }
    for (const file of files) {
      const parsed = await parseCodexRollout(file).catch(() => null);
      if (parsed?.session || parsed?.weekly) return store("codex", parsed, cacheable);
    }
    return store("codex", errorLimits("codex", "No rate-limit events found in Codex rollouts."), cacheable);
  } catch (e: any) {
    return store("codex", errorLimits("codex", e?.message ?? String(e)), cacheable);
  }
}

export async function fetchAllLimits(options: { force?: boolean; codexThreadId?: string } = {}): Promise<LimitSnapshot> {
  const [claude, codex] = await Promise.all([
    fetchClaudeLimits({ force: options.force }),
    fetchCodexLimits({ force: options.force, threadId: options.codexThreadId }),
  ]);
  return { claude, codex };
}

function roundDelta(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function windowDelta(before: LimitWindow | null | undefined, after: LimitWindow | null | undefined): { value?: number; approx: boolean } {
  if (!after) return { approx: false };
  if (!before) return { approx: false };
  const resetChanged = !!before.resetsAt && !!after.resetsAt && before.resetsAt !== after.resetsAt;
  if (resetChanged) return { value: roundDelta(after.usedPercent), approx: true };
  return { value: roundDelta(after.usedPercent - before.usedPercent), approx: false };
}

function providerDelta(before: ProviderLimits | undefined, after: ProviderLimits | undefined): { delta?: ProviderLimitDelta; approx: boolean } {
  if (!before || !after || before.error || after.error) return { approx: false };
  const session = windowDelta(before.session, after.session);
  const weekly = windowDelta(before.weekly, after.weekly);
  if (session.value === undefined && weekly.value === undefined) return { approx: session.approx || weekly.approx };
  return {
    delta: {
      sessionDeltaPct: session.value ?? 0,
      weeklyDeltaPct: weekly.value ?? 0,
    },
    approx: session.approx || weekly.approx,
  };
}

export function diffLimitSnapshots(before: LimitSnapshot | null | undefined, after: LimitSnapshot | null | undefined): UsageLimitDeltas | undefined {
  if (!before || !after) return undefined;
  const claude = providerDelta(before.claude, after.claude);
  const codex = providerDelta(before.codex, after.codex);
  if (!claude.delta && !codex.delta) return undefined;
  return {
    claude: claude.delta,
    codex: codex.delta,
    approx: claude.approx || codex.approx || undefined,
  };
}
