import { NextResponse } from "next/server";
import { getSeasonGzStatus, startSeasonGzWarm } from "@/lib/analysis/seasonGzCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/** Smart Analysis — arşivi bir kez belleğe alır; GET sadece durum döner. */
export async function GET() {
  startSeasonGzWarm();
  return NextResponse.json({ ok: true, ...getSeasonGzStatus() });
}
