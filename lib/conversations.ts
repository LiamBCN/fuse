"use client";
// Client access to conversation history. Conversations themselves live on the
// server (durable JSON via /api/conversations) so history survives across
// browsers and restarts. Only the "which chat am I on" pointer stays in
// localStorage, since it's a per-window UI preference.
import type { Turn } from "./types";

export type { Turn } from "./types";

export interface StoredConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: Turn[];
}

const ACTIVE_KEY = "fuse.activeConversation.v1";
const hasWindow = () => typeof window !== "undefined";

export async function listConversations(): Promise<StoredConversation[]> {
  const res = await fetch("/api/conversations", { cache: "no-store" });
  if (!res.ok) return [];
  return (await res.json()) as StoredConversation[];
}

export async function loadConversation(id: string): Promise<StoredConversation | null> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as StoredConversation;
}

export async function saveConversation(conv: { id: string; turns: Turn[] }): Promise<StoredConversation | null> {
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(conv),
  });
  if (!res.ok) return null;
  return (await res.json()) as StoredConversation;
}

export async function deleteConversation(id: string): Promise<void> {
  await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// The conversation the chat page should restore on load - a local UI pointer.
export function loadActiveId(): string | null {
  if (!hasWindow()) return null;
  try {
    return window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveId(id: string): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* ignore */
  }
}

export function clearActiveId(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}
