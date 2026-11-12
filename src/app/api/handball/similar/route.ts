import { NextRequest, NextResponse } from "next/server";
import { similar, fetchFixtureHOdds, extract1x2Columns } from "@/lib/handball";
import { sql } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") || searchParams.get("match_id");
  const k = Math.min(Number(searchParams.get("k") || 10), 50);
  const bmName = searchParams.get("bm") || "";
  const bmIdParam = searchParams.get("bmId");
  const bmId = bmIdParam ? Number(bmIdParam) : null;

  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const odds = await fetchFixtureHOdds(id);
  const result = await similar(id, k, {
    oddsOverride: odds,
    bookmakerId: bmId,
    bookmakerName: bmName,
  });

  if ("error" in result) {
    return NextResponse.json(result, { status: 400 });
  }

  // Üstteki 1 satırlık fikstür tablosu için seçili maçın bilgilerini ve o BM'nin 1X2 oranlarını hazırla
  let fixtureRow = null;
  try {
    const fixRows = await sql.unsafe<any[]>(
      `SELECT match_id, league, home_team, away_team, match_time FROM fixtureh WHERE match_id = $1 LIMIT 1`,
      [id],
    );
    const fx = fixRows[0];
    if (fx && odds) {
      const cols1x2 = extract1x2Columns(odds, bmId);
      const dt = fx.match_time ? new Date(fx.match_time) : null;
      fixtureRow = {
        id: fx.match_id,
        src: "fixture",
        date: dt ? dt.toISOString().slice(0, 10) : "-",
        time: dt ? dt.toISOString().slice(11, 16) : "-",
        season: fx.league ?? "-",
        home: fx.home_team,
        away: fx.away_team,
        ft: "-",
        ftRes: "-",
        o1: cols1x2.o1,
        c1: cols1x2.c1,
        ox: cols1x2.ox,
        cx: cols1x2.cx,
        o2: cols1x2.o2,
        c2: cols1x2.c2,
      };
    }
  } catch (e) {
    console.error("fixtureh meta okunamadı:", e);
  }

  return NextResponse.json({ fixtureRow, matches: result });
}
