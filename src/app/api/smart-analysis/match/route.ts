import { NextResponse } from "next/server";
import { buildSmartMatchReport } from "@/lib/analysis/smartMatchReport";
import { ensureSeasonGzCache } from "@/lib/analysis/seasonGzCache";
import type { CompactOddsRow, FixtureRow } from "@/lib/archiveCache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

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
    return NextResponse.json({ ok: false, error: "fixture.match_id gerekli." }, { status: 400 });
  }
  if (!Array.isArray(fixture.odds) || !fixture.odds.length) {
    return NextResponse.json(
      { ok: false, error: "Seçili maç için odds yok — bülten odds yüklenene kadar bekleyin." },
      { status: 400 },
    );
  }

  const { matches, status } = await ensureSeasonGzCache(600_000);
  if (status.status === "error") {
    return NextResponse.json(
      {
        ok: false,
        error: status.error || "Season .json.gz arşivi yüklenemedi.",
        archiveStatus: status,
      },
      { status: 503 },
    );
  }
  if (!matches.length) {
    return NextResponse.json(
      {
        ok: false,
        error:
          status.status === "loading"
            ? `Arşiv yükleniyor (${status.filesDone}/${status.files} sezon) — birkaç dakika sonra tekrar deneyin.`
            : "Arşivde bitmiş maç bulunamadı.",
        archiveStatus: status,
      },
      { status: 503 },
    );
  }

  const tolRaw = Number(body.tolerancePct);
  const tolerancePct = Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : 0.03;

  const report = buildSmartMatchReport({
    fixture: {
      match_id: fixture.match_id,
      home_name: fixture.home_name ?? null,
      away_name: fixture.away_name ?? null,
      kickoff_at: fixture.kickoff_at ?? null,
      league: fixture.league ?? null,
      odds: fixture.odds as CompactOddsRow[],
      bookmakers: fixture.bookmakers ?? null,
      home_id: fixture.home_id,
      away_id: fixture.away_id,
    },
    archive: matches,
    archiveSource: status.dir,
    referenceBm: body.referenceBm,
    tolerancePct,
  });

  return NextResponse.json({
    ok: true,
    report,
    archiveStatus: status,
    archivePartial: status.status === "loading",
  });
}
