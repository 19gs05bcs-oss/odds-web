import "server-only";
import { sql } from "@/lib/db";

export type FreeTip = {
  id: number;
  slug: string;
  match_id: string | null;
  league: string | null;
  home_name: string;
  away_name: string;
  kickoff_at: string;
  market: string;
  pick: string;
  odds: number | null;
  confidence: number | null;
  analysis: string;
  similar_count: number | null;
  similar_hit: number | null;
  result: "pending" | "won" | "lost" | "void";
  home_score: number | null;
  away_score: number | null;
  published_at: string;
};

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error("[freeTips]", e instanceof Error ? e.message : e);
    return fallback;
  }
}

export function listUpcomingTips(limit = 40) {
  return safe(
    async () => Array.from(await sql<FreeTip[]>`
      select id, slug, match_id, league, home_name, away_name, kickoff_at, market, pick,
             odds::float8 as odds, confidence, analysis, similar_count, similar_hit, result,
             home_score, away_score, published_at
      from free_tips
      where status = 'published' and kickoff_at > now() - interval '3 hours'
      order by kickoff_at asc limit ${limit}`),
    [] as FreeTip[],
  );
}

export function listPastTips(limit = 30) {
  return safe(
    async () => Array.from(await sql<FreeTip[]>`
      select id, slug, match_id, league, home_name, away_name, kickoff_at, market, pick,
             odds::float8 as odds, confidence, analysis, similar_count, similar_hit, result,
             home_score, away_score, published_at
      from free_tips
      where status = 'published' and kickoff_at <= now() - interval '3 hours'
      order by kickoff_at desc limit ${limit}`),
    [] as FreeTip[],
  );
}

export function getTipBySlug(slug: string) {
  return safe(async () => {
    const rows = await sql<FreeTip[]>`
      select id, slug, match_id, league, home_name, away_name, kickoff_at, market, pick,
             odds::float8 as odds, confidence, analysis, similar_count, similar_hit, result,
             home_score, away_score, published_at
      from free_tips where slug = ${slug} and status = 'published' limit 1`;
    return rows[0] ?? null;
  }, null as FreeTip | null);
}

export function listTipSlugs(limit = 5000) {
  return safe(
    async () => Array.from(await sql<{ slug: string; updated_at: string }[]>`
      select slug, updated_at from free_tips
      where status = 'published' order by kickoff_at desc limit ${limit}`),
    [] as { slug: string; updated_at: string }[],
  );
}

export function getRecord(days = 30) {
  return safe(async () => {
    const rows = await sql<{ settled: number; won: number }[]>`
      select count(*)::int as settled,
             count(*) filter (where result = 'won')::int as won
      from free_tips
      where status = 'published' and result in ('won','lost')
        and kickoff_at > now() - make_interval(days => ${days})`;
    return rows[0] ?? { settled: 0, won: 0 };
  }, { settled: 0, won: 0 });
}

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function buildSlug(home: string, away: string, kickoffIso: string): string {
  return `${slugify(home)}-vs-${slugify(away)}-prediction-${kickoffIso.slice(0, 10)}`;
}

export function fmtKickoff(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    timeZone: "UTC", timeZoneName: "short",
  }).format(d);
}
