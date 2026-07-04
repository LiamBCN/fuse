// Dead-simple local persistence for token usage. One JSON file on disk under
// ./data/usage.json. No external DB - "store locally" taken literally.
import { promises as fs } from "fs";
import path from "path";
import type { UsageLimitDeltas } from "./types";

// Writable data location. The packaged Electron app sets FUSE_DATA_DIR to a
// per-user folder (the app bundle itself is read-only); in dev it falls back
// to ./data next to the source.
export const DATA_DIR = process.env.FUSE_DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "usage.json");

export interface UsageItem {
  provider: string;
  model: string;
  role: "proposer" | "aggregator";
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  sessionId?: string;
}

export interface UsageRecord {
  ts: number; // epoch ms
  conversationId: string;
  items: UsageItem[];
  limits?: UsageLimitDeltas;
}

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(FILE);
  } catch {
    await fs.writeFile(FILE, "[]", "utf8");
  }
}

export async function readUsage(): Promise<UsageRecord[]> {
  await ensure();
  const raw = await fs.readFile(FILE, "utf8");
  try {
    return JSON.parse(raw) as UsageRecord[];
  } catch {
    return [];
  }
}

export async function appendUsage(record: UsageRecord): Promise<void> {
  const all = await readUsage();
  all.push(record);
  await fs.writeFile(FILE, JSON.stringify(all, null, 2), "utf8");
}
