// Server-side conversation persistence. Durable JSON on disk (one file under
// the writable data dir), so chat history survives restarts and isn't tied to
// a single browser's localStorage. Mirrors the simple file store in db.ts.
import { promises as fs } from "fs";
import path from "path";
import { DATA_DIR } from "./db";
import type { Turn } from "./types";

const FILE = path.join(DATA_DIR, "conversations.json");

export interface StoredConversation {
  id: string;
  title: string;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
  turns: Turn[];
}

async function ensure() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(FILE);
  } catch {
    await fs.writeFile(FILE, "[]", "utf8");
  }
}

async function readAll(): Promise<StoredConversation[]> {
  await ensure();
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as StoredConversation[];
  } catch {
    return [];
  }
}

async function writeAll(all: StoredConversation[]): Promise<void> {
  await ensure();
  await fs.writeFile(FILE, JSON.stringify(all, null, 2), "utf8");
}

// Derive a short, human-readable title from the first user message.
function deriveTitle(turns: Turn[]): string {
  const first = turns.find((t) => t.role === "user" && t.content.trim());
  if (first) {
    const oneLine = first.content.trim().replace(/\s+/g, " ");
    return oneLine.length > 60 ? oneLine.slice(0, 60) + "…" : oneLine;
  }
  const withAtt = turns.find((t) => t.role === "user" && (t.files?.length || t.images?.length));
  return withAtt ? "Attachment-only message" : "New conversation";
}

// fileText is the inlined contents of attached files — large and only ever sent
// to the models, never displayed. Drop it before persisting.
const strip = (turns: Turn[]): Turn[] => turns.map(({ fileText, ...rest }) => rest);

export async function listConversations(): Promise<StoredConversation[]> {
  const all = await readAll();
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(id: string): Promise<StoredConversation | null> {
  const all = await readAll();
  return all.find((c) => c.id === id) ?? null;
}

// Insert or update a conversation, refreshing its title and updatedAt.
export async function upsertConversation(input: { id: string; turns: Turn[] }): Promise<StoredConversation> {
  const all = await readAll();
  const existing = all.find((c) => c.id === input.id);
  const now = Date.now();
  const record: StoredConversation = {
    id: input.id,
    title: deriveTitle(input.turns),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    turns: strip(input.turns),
  };
  await writeAll([record, ...all.filter((c) => c.id !== input.id)]);
  return record;
}

export async function deleteConversation(id: string): Promise<void> {
  const all = await readAll();
  await writeAll(all.filter((c) => c.id !== id));
}
