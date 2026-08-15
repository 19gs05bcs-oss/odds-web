import { NextResponse } from "next/server";
import { koyebCacheConfigured } from "@/lib/koyebCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Legacy GET — eskiden Node içi arşiv ısınma durumunu dönerdi.
 * Artık ısınacak bir şey yok: tarama Koyeb'de, her /match isteğinde
 * stream ediliyor. Burası sadece Koyeb bağlantısının yapılandırılıp
 * yapılandırılmadığını raporlar (frontend'in polling'i anında durur).
 */
export async function GET() {
  const configured = koyebCacheConfigured();
  return NextResponse.json({
    ok: true,
    archiveStatus: {
      status: configured ? "ready" : "error",
      phase: "idle",
      files: 0,
      filesDone: 0,
      matches: 0,
      error: configured ? undefined : "KOYEB_CACHE_URL tanımlı değil",
    },
  });
}
