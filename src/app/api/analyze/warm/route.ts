import { NextResponse } from "next/server";
import { getWarmStatus, startArchiveWarm } from "@/lib/archiveCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** Analyze sayfası mount olunca çağrılır — arka planda markets_json deparse. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const max = Number(url.searchParams.get("maxSeasons") || 24);
  const maxSeasons = Number.isFinite(max) && max > 0 ? Math.min(max, 80) : 24;
  startArchiveWarm(maxSeasons);
  return NextResponse.json({ ok: true, ...getWarmStatus() });
}

export async function POST(req: Request) {
  return GET(req);
}
