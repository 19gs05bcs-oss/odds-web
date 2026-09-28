import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import {
  extractH2hForm,
  knnTwins,
  type BankRow,
  type H2hForm,
  type TwinFeatures,
  type TwinResult,
} from "@/lib/analysis/m6Twins";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Market Detect zenginleştirmesi (super_radar_v23 ile aynı iki dış girdi):
 *   1) fixture.h2h  -> zaman ağırlıklı son 5 maç gol formu (λ_F, γ)
 *   2) match_feature_codes 888 M6 bankası -> KNN(k=5) ikiz teyidi (sim%, 3.5Ü/5.5Ü/2.5A)
 * Banka bellekte 6 saat cache'lenir (bitmiş maçlar, sık değişmez).
 */

const BANK_TTL_MS = 6 * 60 * 60 * 1000;
let bankCache: { at: number; rows: BankRow[] } | null = null;

type BankSqlRow = {
  ft_h: string | number | null;
  ft_a: string | number | null;
  u25: string | number | null;
  o25: string | number | null;
  o35: string | number | null;
  o45: string | number | null;
  ht_o15: string | number | null;
  total_goals: string | number | null;
  home_score: string | number | null;
  away_score: string | number | null;
};

async function loadBank(): Promise<BankRow[]> {
  if (bankCache && Date.now() - bankCache.at < BANK_TTL_MS) return bankCache.rows;
  const data = await sql.unsafe<BankSqlRow[]>(
    `SELECT ft_h, ft_a, u25, o25, o35, o45, ht_o15, total_goals, home_score, away_score
       FROM public.match_feature_codes
      WHERE is_finished = true AND total_goals IS NOT NULL
        AND ((o45 IS NOT NULL AND o45 <= 2.30) OR (o35 IS NOT NULL AND o35 <= 1.95 AND ht_o15 <= 2.40))
        AND (u25 - o25) >= 0.70`,
  );
  const rows: BankRow[] = [];
  for (const r of data) {
    const h = Number(r.ft_h);
    const a = Number(r.ft_a);
    const u25 = Number(r.u25);
    const o25 = Number(r.o25);
    const tot = Number(r.total_goals);
    if (![h, a, u25, o25, tot].every(Number.isFinite)) continue;
    rows.push({
      fav: Math.min(h, a),
      dog: Math.max(h, a),
      dna: u25 - o25,
      o25,
      o35: r.o35 != null && Number(r.o35) > 0 ? Number(r.o35) : o25 * 1.55,
      o45: r.o45 != null && Number(r.o45) > 0 ? Number(r.o45) : 2.5,
      htO15: r.ht_o15 != null && Number(r.ht_o15) > 0 ? Number(r.ht_o15) : 2.4,
      tot,
      score: `${r.home_score}-${r.away_score}`,
    });
  }
  bankCache = { at: Date.now(), rows };
  return rows;
}

type Body = { matchId?: string; kickoffTs?: number | null; features?: TwinFeatures | null };

function validFeatures(f: unknown): f is TwinFeatures {
  if (!f || typeof f !== "object") return false;
  const o = f as Record<string, unknown>;
  return ["fav", "dog", "dna", "o25", "o35", "o45", "htO15"].every((k) => Number.isFinite(Number(o[k])));
}

export async function POST(req: Request) {
  let body: Body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const matchId = body.matchId;
  if (!matchId) return NextResponse.json({ ok: false, error: "matchId is required." }, { status: 400 });

  let form: H2hForm | null = null;
  let formError: string | null = null;
  try {
    const rows = await sql.unsafe<{ h2h: unknown; kickoff_ts: string | number | null }[]>(
      `SELECT h2h, kickoff_ts FROM public.fixture WHERE match_id = $1 ORDER BY bulletin_date DESC LIMIT 1`,
      [matchId],
    );
    const row = rows[0];
    if (row) {
      const ts = row.kickoff_ts != null ? Number(row.kickoff_ts) : (body.kickoffTs ?? null);
      form = extractH2hForm(row.h2h, Number.isFinite(ts as number) ? (ts as number) : null);
    }
  } catch (e) {
    formError = e instanceof Error ? e.message : String(e);
  }

  let twins: TwinResult | null = null;
  let twinError: string | null = null;
  if (validFeatures(body.features)) {
    try {
      const bank = await loadBank();
      const f = body.features;
      twins = knnTwins(
        { fav: +f.fav, dog: +f.dog, dna: +f.dna, o25: +f.o25, o35: +f.o35, o45: +f.o45, htO15: +f.htO15 },
        bank,
        5,
      );
    } catch (e) {
      twinError = e instanceof Error ? e.message : String(e);
    }
  }

  return NextResponse.json({ ok: true, form, twins, formError, twinError });
}
