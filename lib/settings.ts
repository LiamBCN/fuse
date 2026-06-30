"use client";
// Client access to app config (model choices + working folder). Stored
// server-side (durable, in the app's data dir) via /api/settings.
import { DEFAULT_CONFIG, mergeConfig, type FuseConfig } from "./types";

export type { FuseConfig } from "./types";
export { DEFAULT_CONFIG } from "./types";

const STORAGE_KEY = "fuse.config.v1";

export async function loadConfig(): Promise<FuseConfig> {
  try {
    const res = await fetch("/api/settings", { cache: "no-store" });
    if (res.ok) return mergeConfig(await res.json());
  } catch {
    /* server unreachable - fall back to a local mirror / defaults */
  }
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) return mergeConfig(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }
  return DEFAULT_CONFIG;
}

export async function saveConfig(cfg: FuseConfig): Promise<void> {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    } catch {
      /* ignore quota */
    }
  }
  try {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cfg),
    });
  } catch {
    /* offline - local mirror still holds it */
  }
}
