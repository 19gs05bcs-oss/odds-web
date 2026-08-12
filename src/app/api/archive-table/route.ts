import { NextResponse } from "next/server";
import { loadSeasonEvents } from "@/lib/archive";
import { eventsToTableRows, PREFERRED_BM } from "@/lib/analysis/tableRows";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Load one season of events.markets_json as analyze table rows. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const season = (url.searchParams.get("season") || "").trim();
  const bm = Number(url.searchParams.get("bm") || PREFERRED_BM);
  if (!season) {
    return NextResponse.json(
      { ok: false, error: "season query param required", rows: [] },
      { status: 400 },
    );
  }
  try {
    const events = await loadSeasonEvents(season);
    const rows = eventsToTableRows(events, Number.isFinite(bm) ? bm : PREFERRED_BM);
    return NextResponse.json({ ok: true, rows, count: rows.length });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        rows: [],
      },
      { status: 500 },
    );
  }
}
