import { NextResponse } from "next/server";
import {
  decodeCriterion,
  type OddsCriterion,
  type ProfileQuery,
} from "@/lib/analysis/profile";
import { searchProfile } from "@/lib/fixtures";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function queryFromSearchParams(sp: URLSearchParams): ProfileQuery {
  const criteria = sp
    .getAll("c")
    .map(decodeCriterion)
    .filter((x): x is OddsCriterion => x != null);
  const tol = Number(sp.get("tol") || "");
  return {
    criteria,
    bookmakerId: sp.get("bookmaker") || null,
    seasonSlugs: [sp.get("seasonSlug"), ...sp.getAll("season")].filter(
      (x): x is string => Boolean(x),
    ),
    tolerance: Number.isFinite(tol) ? tol : 0,
    limit: Number(sp.get("limit") || 200) || 200,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = queryFromSearchParams(url.searchParams);
  if (!query.criteria.length) {
    return NextResponse.json(
      { ok: false, error: "En az bir oran kriteri (c=...) gerekli." },
      { status: 400 },
    );
  }
  const result = await searchProfile(query);
  if (!result.ok) {
    return NextResponse.json(result, { status: result.missingEnv ? 503 : 500 });
  }
  return NextResponse.json({ ok: true, ...result.data });
}

export async function POST(req: Request) {
  let body: {
    criteria?: OddsCriterion[];
    bookmakerId?: string | null;
    seasonSlugs?: string[];
    tolerance?: number;
    limit?: number;
  } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const query: ProfileQuery = {
    criteria: body.criteria || [],
    bookmakerId: body.bookmakerId || null,
    seasonSlugs: body.seasonSlugs || [],
    tolerance: body.tolerance ?? 0,
    limit: body.limit ?? 200,
  };
  if (!query.criteria.length) {
    return NextResponse.json(
      { ok: false, error: "criteria[] gerekli." },
      { status: 400 },
    );
  }
  const result = await searchProfile(query);
  if (!result.ok) {
    return NextResponse.json(result, { status: result.missingEnv ? 503 : 500 });
  }
  return NextResponse.json({ ok: true, ...result.data });
}
