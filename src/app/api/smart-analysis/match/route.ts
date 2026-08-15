import { NextResponse } from "next/server";
import { fetchSmartMatchReportFromKoyeb, koyebCacheConfigured } from "@/lib/koyebCache";
import { fixtureToTableRow, PREFERRED_BM } from "@/lib/analysis/tableRows";
import type { CompactOddsRow, FixtureRow } from "@/lib/archiveCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 150;

type Body = {
  fixture?: Partial<FixtureRow> & { match_id: string };
  referenceBm?: number;
  tolerancePct?: number;
  /** boş bırakılırsa Koyeb tüm 283 sezonu tarar */
  seasons?: string[];
};

type KoyebSimilarSample = {
  id: string;
  season: string | null;
  home: string | null;
  away: string | null;
  kickoff: string | null;
  score: string;
  outcome: "H" | "D" | "A";
  oddsH: number;
  oddsD: number;
  oddsA: number;
  odds: CompactOddsRow[];
};

function sampleToFixtureLike(s: KoyebSimilarSample): FixtureRow {
  const [h, a] = s.score.split("-").map((x) => x.trim());
  return {
    match_id: s.id,
    bulletin_date: s.kickoff?.slice(0, 10) || "",
    day_offset: 0,
    league: null,
    league_country: null,
    kickoff_at: s.kickoff,
    kickoff_ts: s.kickoff ? Math.floor(new Date(s.kickoff).getTime() / 1000) : null,
    home_name: s.home,
    away_name: s.away,
    home_score: h ?? null,
    away_score: a ?? null,
    match_url: null,
    odds: s.odds,
    bookmakers: null,
    odds_count: s.odds?.length ?? 0,
  };
}

export async function POST(req: Request) {
  if (!koyebCacheConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "KOYEB_CACHE_URL tanımlı değil. Koyeb worker'daki archive_cache_server.py'nin " +
          "public adresini Railway env değişkenlerine ekleyin.",
      },
      { status: 503 },
    );
  }

  let body: Body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const fixture = body.fixture;
  if (!fixture?.match_id) {
    return NextResponse.json({ ok: false, error: "fixture.match_id gerekli." }, { status: 400 });
  }
  if (!Array.isArray(fixture.odds) || !fixture.odds.length) {
    return NextResponse.json(
      { ok: false, error: "Seçili maç için odds yok — bülten odds yüklenene kadar bekleyin." },
      { status: 400 },
    );
  }

  const tolRaw = Number(body.tolerancePct);
  const tolerancePct = Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : 0.03;
  const bm = body.referenceBm ?? PREFERRED_BM;

  let report: Record<string, unknown>;
  try {
    // Ağır iş (283 sezon taraması) Koyeb'de — Railway sadece küçük JSON alıyor.
    report = await fetchSmartMatchReportFromKoyeb({
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
      seasons: body.seasons,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  // selectedRow + similarTableRows: Koyeb bunları hesaplamıyor (UI'ya özgü,
  // tableRows.ts'e bağlı) — burada, Koyeb'in döndürdüğü KÜÇÜK (<=120 satır)
  // örnek listesinden ucuzca kuruluyor. 283 sezonun tamamına dokunulmuyor.
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

  const similar1x2 = report.similar1x2 as { samples?: KoyebSimilarSample[] } | undefined;
  const samples = similar1x2?.samples ?? [];
  const similarTableRows = samples
    .slice(0, 60)
    .map((s) => fixtureToTableRow(sampleToFixtureLike(s), bm));

  return NextResponse.json({
    ok: true,
    report: {
      ...report,
      selectedRow: fixtureToTableRow(fixtureRow, bm),
      similarTableRows,
    },
    archiveStatus: { status: "ready", dir: "koyeb:quotes-stream" },
    archivePartial: false,
  });
}
