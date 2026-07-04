// Server-side app settings (API keys + model choices). Durable JSON on disk in
// the writable data dir, so config lives with the app and survives restarts -
// independent of any single browser/origin's localStorage. Mirrors db.ts.
import { promises as fs } from "fs";
import path from "path";
import { DATA_DIR } from "./db";
import { DEFAULT_CONFIG, mergeConfig, type FuseConfig } from "./types";

const FILE = path.join(DATA_DIR, "settings.json");

export function redactSettings(cfg: FuseConfig): FuseConfig {
  return {
    ...cfg,
    claudeOauthToken: undefined,
    claudeOauthTokenSet: !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!cfg.claudeOauthToken || !!cfg.claudeOauthTokenSet,
  };
}

export async function readSettings(): Promise<FuseConfig> {
  try {
    return mergeConfig(JSON.parse(await fs.readFile(FILE, "utf8")));
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function writeSettings(cfg: FuseConfig): Promise<FuseConfig> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const previous = await readSettings();
  const hasTokenField = Object.prototype.hasOwnProperty.call(cfg, "claudeOauthToken");
  const incomingToken =
    typeof cfg.claudeOauthToken === "string" && cfg.claudeOauthToken.trim()
      ? cfg.claudeOauthToken.trim()
      : undefined;
  const token = hasTokenField ? incomingToken : previous.claudeOauthToken;
  const merged = mergeConfig({ ...cfg, claudeOauthToken: token });
  if (!token) delete merged.claudeOauthToken;
  merged.claudeOauthTokenSet = !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!token;
  await fs.writeFile(FILE, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}
