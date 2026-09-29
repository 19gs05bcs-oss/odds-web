import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { buildSlug } from "@/lib/freeTips";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function authorized(req: Request): boolean {
  const secret = process.env.FREE_TIPS_SECRET?.trim();
  const got = req.headers.get("x-publish-secret")?.trim() ?? "";
  if (!secret || !got) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

type TipIn = {
  slug?: string;
  match_id?: string;
  league?: string;
  home_name: string;
  away_name: string;
  kickoff_at: string;
  market: string;
  pick: string;
  odds?: number;
  confidence?: number;
  analysis: string;
  similar_count?: number;
  similar_hit?: number;
  status?: "draft" | "published";
};

function validate(t: Partial<TipIn>): string | null {
  for (const k of ["home_name", "away_name", "kickoff_at", "market", "pick", "analysis"] as const) {
    if (!t[k] || typeof t[k] !== "string") return `${k} required`;
  }
  if (Number.isNaN(new Date(t.kickoff_at!).getTime())) return "kickoff_at invalid";
  if (t.analysis!.trim().split(/\s+/).length < 40) {
    return "analysis too short (min 40 words — thin content won't get indexed)";
  }
  return null;
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const tips = (Array.isArray(body) ? body : [body]) as Partial<TipIn>[];

  const slugs: string[] = [];
  for (const t of tips) {
    const err = validate(t);
    if (err) return NextResponse.json({ ok: false, error: err }, { status: 400 });
    const kickoff = new Date(t.kickoff_at!).toISOString();
    const slug = t.slug || buildSlug(t.home_name!, t.away_name!, kickoff);
    await sql`
      insert into free_tips (slug, match_id, league, home_name, away_name, kickoff_at, market, pick,
                             odds, confidence, analysis, similar_count, similar_hit, status)
      values (${slug}, ${t.match_id ?? null}, ${t.league ?? null}, ${t.home_name!}, ${t.away_name!},
              ${kickoff}, ${t.market!}, ${t.pick!}, ${t.odds ?? null},
              ${t.confidence ?? null}, ${t.analysis!}, ${t.similar_count ?? null},
              ${t.similar_hit ?? null}, ${t.status ?? "published"})
      on conflict (slug) do update set
        league = excluded.league, market = excluded.market, pick = excluded.pick,
        odds = excluded.odds, confidence = excluded.confidence, analysis = excluded.analysis,
        similar_count = excluded.similar_count, similar_hit = excluded.similar_hit,
        status = excluded.status, updated_at = now()`;
    slugs.push(slug);
    revalidatePath(`/free-tips/${slug}`);
  }
  revalidatePath("/free-tips");
  revalidatePath("/sitemap.xml");
  return NextResponse.json({ ok: true, slugs });
}

export async function PATCH(req: Request) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as {
    slug?: string;
    result?: string;
    home_score?: number;
    away_score?: number;
  } | null;
  if (!b?.slug || !["won", "lost", "void", "pending"].includes(b.result ?? "")) {
    return NextResponse.json({ ok: false, error: "slug + result required" }, { status: 400 });
  }
  await sql`update free_tips set result = ${b.result!}, home_score = ${b.home_score ?? null},
            away_score = ${b.away_score ?? null}, updated_at = now() where slug = ${b.slug}`;
  revalidatePath(`/free-tips/${b.slug}`);
  revalidatePath("/free-tips");
  return NextResponse.json({ ok: true });
}
