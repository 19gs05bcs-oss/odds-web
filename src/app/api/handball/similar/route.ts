import { NextRequest, NextResponse } from "next/server";
import {
  similar,
  fetchFixtureHOdds,
  type CompactOddsRow,
} from "@/lib/handball";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SimilarParams = {
  id: string | null;
  k?: number;
  odds?: CompactOddsRow[] | null;
  bookmakerId?: number | null;
  bookmakerName?: string;
};

async function runSimilar(params: SimilarParams) {
  const { id, k = 10, odds, bookmakerId, bookmakerName } = params;

  if (!id) {
    return NextResponse.json(
      { error: "missing_id", message: "match_id / id gerekli." },
      { status: 400 },
    );
  }

  const resolvedOdds = odds?.length ? odds : await fetchFixtureHOdds(id);
  const result = await similar(id, Math.min(Math.max(Number(k) || 10, 1), 50), {
    oddsOverride: resolvedOdds,
    bookmakerId:
      bookmakerId != null && Number.isFinite(Number(bookmakerId))
        ? Number(bookmakerId)
        : null,
    bookmakerName: bookmakerName ?? "",
  });

  if (!Array.isArray(result) && "error" in result) {
    return NextResponse.json(result, { status: 400 });
  }

  return NextResponse.json(result);
}

function errorResponse(error: unknown) {
  const details =
    error instanceof Error
      ? { name: error.name, message: error.message }
      : { message: String(error) };

  // İstek gövdesi veya R2 kimlik bilgileri loglanmaz.
  console.error("[api/handball/similar] request failed", details);

  return NextResponse.json(
    {
      error: "handball_similar_failed",
      message: "Benzer maçlar hesaplanamadı. Sunucu loglarını kontrol edin.",
    },
    { status: 500 },
  );
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const rawBookmakerId =
      searchParams.get("bookmakerId") ?? searchParams.get("bmId");

    return await runSimilar({
      id: searchParams.get("id") || searchParams.get("match_id"),
      k: Number(searchParams.get("k") || 10),
      bookmakerId:
        rawBookmakerId != null && rawBookmakerId !== ""
          ? Number(rawBookmakerId)
          : null,
      bookmakerName:
        searchParams.get("bm") || searchParams.get("bookmaker") || "",
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "invalid_json", message: "İstek gövdesi geçerli JSON değil." },
        { status: 400 },
      );
    }

    const rawBookmakerId = body.bookmakerId ?? body.bmId;

    return await runSimilar({
      id: body.id || body.match_id || null,
      k: Number(body.k || 10),
      odds: Array.isArray(body.odds) ? (body.odds as CompactOddsRow[]) : null,
      bookmakerId:
        rawBookmakerId != null && rawBookmakerId !== ""
          ? Number(rawBookmakerId)
          : null,
      bookmakerName: body.bm || body.bookmaker || "",
    });
  } catch (error) {
    return errorResponse(error);
  }
}
