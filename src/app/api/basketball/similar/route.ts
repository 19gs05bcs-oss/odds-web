import { NextRequest, NextResponse } from "next/server";
import { similar, fetchFixtureBOdds, type CompactOddsRow } from "@/lib/basketball";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = {
  id: string | null;
  k?: number;
  odds?: CompactOddsRow[] | null;
  bookmakerId?: number | null;
  bookmakerName?: string;
};

const STATUS: Record<string, number> = {
  not_in_archive_no_odds: 404,
  no_matches_for_bookmaker: 404,
  no_bm_odds: 404,
  odds_features_empty: 422,
};

async function run({ id, k = 10, odds, bookmakerId, bookmakerName }: Params) {
  if (!id) {
    return NextResponse.json({ error: "missing_id", message: "match_id / id is required." }, { status: 400 });
  }
  const resolvedOdds = odds?.length ? odds : await fetchFixtureBOdds(id);
  const result = await similar(id, Math.min(Math.max(Number(k) || 10, 1), 50), {
    oddsOverride: resolvedOdds,
    bookmakerId: bookmakerId != null && Number.isFinite(Number(bookmakerId)) ? Number(bookmakerId) : null,
    bookmakerName: bookmakerName ?? "",
  });
  if (!Array.isArray(result) && "error" in result) {
    return NextResponse.json(result, { status: STATUS[result.error] ?? 400 });
  }
  return NextResponse.json(result);
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[api/basketball/similar] failed", message);
  return NextResponse.json({ error: "basketball_similar_failed", message }, { status: 500 });
}

const bmFrom = (v: unknown) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    return await run({
      id: sp.get("id") || sp.get("match_id"),
      k: Number(sp.get("k") || 10),
      bookmakerId: bmFrom(sp.get("bookmakerId") ?? sp.get("bmId")),
      bookmakerName: sp.get("bm") || sp.get("bookmaker") || "",
    });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "invalid_json", message: "Request body is not valid JSON." }, { status: 400 });
    }
    return await run({
      id: body.id || body.match_id || null,
      k: Number(body.k || 10),
      odds: Array.isArray(body.odds) ? (body.odds as CompactOddsRow[]) : null,
      bookmakerId: bmFrom(body.bookmakerId ?? body.bmId),
      bookmakerName: body.bm || body.bookmaker || "",
    });
  } catch (e) {
    return fail(e);
  }
}
