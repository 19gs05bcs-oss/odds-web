import { NextResponse } from "next/server";
import { buildSmartMatchReportSQL } from "@/lib/analysis/smartMatchReportSQL";
import { fetchQuoteRowsByEventIds } from "@/lib/analysis/marketQuotes";
import {
  fixtureToTableRow,
  eventsMetaAndQuotesToTableRows,
  PREFERRED_BM,
  PREFERRED_BM_NAME,
} from "@/lib/analysis/tableRows";
import type { CompactOddsRow, FixtureRow } from "@/lib/archiveCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 150;

type Body = {
  fixture?: Partial<FixtureRow> & { match_id: string };
  referenceBm?: number;
  tolerancePct?: number;
};

export async function POST(req: Request) {
  let body: Body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const fixture = body.fixture;
  if (!fixture?.match_id) {
    return NextResponse.json({ ok: false, error: "fixture.match_id is required." }, { status: 400 });
  }
  if (!Array.isArray(fixture.odds) || !fixture.odds.length) {
    return NextResponse.json(
      { ok: false, error: "No odds for the selected match — wait for bulletin odds to load." },
      { status: 400 },
    );
  }

  const tolRaw = Number(body.tolerancePct);
  const tolerancePct = Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : 0.03;
  const bm = body.referenceBm ?? PREFERRED_BM;
  const bmName = fixture.bookmakers?.[String(bm)] || PREFERRED_BM_NAME;

  let report: Awaited<ReturnType<typeof buildSmartMatchReportSQL>>;
  try {
    // Ağır tarama artık doğrudan Supabase'de (match_odds/events SQL) —
    // analyze sayfasıyla aynı desen. Koyeb'e ve markets_json'a dokunulmuyor.
    report = await buildSmartMatchReportSQL({
      fixture: {
        match_id: fixture.match_id,
        home_name: fixture.home_name ?? null,
        away_name: fixture.away_name ?? null,
        kickoff_at: fixture.kickoff_at ?? null,
        league: fixture.league ?? null,
        odds: fixture.odds,
        bookmakers: fixture.bookmakers ?? null,
        home_id: fixture.home_id,
        away_id: fixture.away_id,
      },
      referenceBm: bm,
      tolerancePct,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  const fixtureRow: FixtureRow = {
    match_id: fixture.match_id,
    bulletin_date: fixture.kickoff_at?.slice(0, 10) || "",
    day_offset: 0,
    league: fixture.league ?? null,
    league_country: null,
    kickoff_at: fixture.kickoff_at ?? null,
    kickoff_ts: null,
    home_name: fixture.home_name ?? null,
    away_name: fixture.away_name ?? null,
    home_id: fixture.home_id,
    away_id: fixture.away_id,
    home_score: null,
    away_score: null,
    match_url: null,
    odds: fixture.odds as CompactOddsRow[],
    bookmakers: fixture.bookmakers ?? null,
    odds_count: fixture.odds.length,
  };

  // Benzer maçların TAM bookmaker grid'i — match_odds'tan flat satırlar,
  // markets_json'a hiç dokunulmadan (bkz. fixtures.ts:searchProfile ile aynı desen).
  const sampleIds = report.similar1x2.samples.slice(0, 60).map((s) => s.id);
  let similarTableRows: ReturnType<typeof fixtureToTableRow>[] = [];
  if (sampleIds.length) {
    const quoteRows = await fetchQuoteRowsByEventIds(sampleIds);
    const rowsById = eventsMetaAndQuotesToTableRows(quoteRows, bmName);
    similarTableRows = sampleIds
      .map((id) => rowsById.get(id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r));
  }

  return NextResponse.json({
    ok: true,
    report: {
      ...report,
      selectedRow: fixtureToTableRow(fixtureRow, bm),
      similarTableRows,
    },
    archiveStatus: { status: "ready", dir: "supabase:match_odds" },
    archivePartial: false,
  });
}
