import { NextRequest, NextResponse } from "next/server";
import { listConversations, upsertConversation } from "@/lib/conversation-store";
import type { Turn } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/conversations - list all conversations (newest first).
export async function GET() {
  try {
    return NextResponse.json(await listConversations());
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

// POST /api/conversations - create or update one conversation.
export async function POST(req: NextRequest) {
  let body: { id?: string; turns?: Turn[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.id || !Array.isArray(body.turns)) {
    return NextResponse.json({ error: "id and turns are required" }, { status: 400 });
  }
  try {
    const saved = await upsertConversation({ id: body.id, turns: body.turns });
    return NextResponse.json(saved);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
