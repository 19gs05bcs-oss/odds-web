import { NextRequest, NextResponse } from "next/server";
import { similar, fetchFixtureHOdds, CompactOddsRow } from "@/lib/handball";

async function runSimilar(params: {
  id: string | null;
  k?: number;
  odds?: CompactOddsRow[] | null;
  bookmakerId?: number | null;
  bookmakerName?: string;
}) {
  const { id, k = 10, odds, bookmakerId, bookmakerName } = params;
  if (!id) {
    return NextResponse.json({ error: "missing_id", message: "match_id / id gerekli." }, { status: 400 });
  }

  const resolvedOdds = odds?.length ? odds : await fetchFixtureHOdds(id);
  const result = await similar(id, Math.min(Math.max(Number(k) || 10, 1), 50), {
    oddsOverride: resolvedOdds,
    bookmakerId: bookmakerId != null && Number.isFinite(Number(bookmakerId)) ? Number(bookmakerId) : null,
    bookmakerName: bookmakerName ?? "",
  });

  if (!Array.isArray(result) && "error" in result) {
    return NextResponse.json(result, { status: 400 });
  }

  return NextResponse.json(result);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") || searchParams.get("match_id");
  const k = Number(searchParams.get("k") || 10);
  const bmIdRaw = searchParams.get("bookmakerId") ?? searchParams.get("bmId");
  const bookmakerId = bmIdRaw != null && bmIdRaw !== "" ? Number(bmIdRaw) : null;
  const bookmakerName = searchParams.get("bm") || searchParams.get("bookmaker") || "";

  return runSimilar({ id, k, bookmakerId, bookmakerName });
}

export async function POST(req: NextRequest) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const id = body.id || body.match_id || null;
  const k = Number(body.k || 10);
  const odds = Array.isArray(body.odds) ? (body.odds as CompactOddsRow[]) : null;
  const bmIdRaw = body.bookmakerId ?? body.bmId;
  const bookmakerId = bmIdRaw != null && bmIdRaw !== "" ? Number(bmIdRaw) : null;
  const bookmakerName = body.bm || body.bookmaker || "";

  return runSimilar({ id, k, odds, bookmakerId, bookmakerName });
}
