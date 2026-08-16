import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Legacy GET — eskiden Node içi arşiv ısınma durumunu dönerdi. Artık ısınacak
 * bir şey yok: tarama her /match isteğinde doğrudan Supabase'e (match_odds/
 * events SQL) atılıyor, Koyeb'e hiç dokunulmuyor. Frontend'in eski "warm
 * status" polling'ini kırmadan anında "ready" dönmesi için duruyor.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    archiveStatus: {
      status: "ready",
      phase: "idle",
      files: 0,
      filesDone: 0,
      matches: 0,
    },
  });
}
