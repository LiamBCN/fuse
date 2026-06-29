import { NextRequest, NextResponse } from "next/server";
import { getConversation, deleteConversation } from "@/lib/conversation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/conversations/:id — fetch one full conversation (with proposals).
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const conv = await getConversation(params.id);
    if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(conv);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

// DELETE /api/conversations/:id — remove one conversation.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await deleteConversation(params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
