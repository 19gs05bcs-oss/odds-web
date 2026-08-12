import { NextResponse } from "next/server";
import { getSeasonGzStatus, startSeasonGzWarm } from "@/lib/analysis/seasonGzCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Legacy GET — archive warm status. Match analysis: POST /api/smart-analysis/match */
export async function GET() {
  startSeasonGzWarm();
  const status = getSeasonGzStatus();
  return NextResponse.json({ ok: true, archiveStatus: status });
}
