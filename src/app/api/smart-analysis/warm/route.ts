import { NextResponse } from "next/server";
import { koyebCacheConfigured } from "@/lib/koyebCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Legacy GET — eskiden burada 283 sezonu Node belleğine ısıtırdık.
 * Artık gerek yok: her /api/smart-analysis/match isteği, taramayı
 * Koyeb'e (archive_cache_server.py /smart-match/report) devrediyor.
 * Bu endpoint sadece frontend'in eski "warm status" polling'ini
 * kırmadan anında "ready" dönmesi için duruyor.
 */
export async function GET() {
  const configured = koyebCacheConfigured();
  return NextResponse.json({
    ok: configured,
    status: configured ? "ready" : "error",
    phase: "idle",
    files: 0,
    filesDone: 0,
    matches: 0,
    error: configured ? undefined : "KOYEB_CACHE_URL tanımlı değil",
  });
}
