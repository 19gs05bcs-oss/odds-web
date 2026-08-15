/**
 * searchOddsProfileSQL.ts'in kullandığı çok-kriterli CTE builder — `match_odds`
 * tablosuna karşı Postgres SQL üretir (bkz. marketQuotes.ts).
 *
 * ESKİSİ: duckdbQuotes.ts → buildFlatQuoteCandidateCte, DuckDB'nin
 * quotes_flat tablosuna karşı aynı mantıkla ama runAndReadAll üzerinden
 * çalışıyordu. SQL metni ($1, $2 placeholder'lı standart SQL) neredeyse
 * değişmeden Postgres'e (sql.unsafe) taşınabiliyor.
 *
 * SQL filtresi kasıtlı olarak biraz gevşek (side için prefix/OR eşleşmesi) —
 * sonuç seti (yüzlerce satır) üzerinde profile.ts'teki BİREBİR AYNI
 * `quoteMatchesCriterion` fonksiyonu ile kesin doğrulama yapılıyor.
 */
import { sql } from "@/lib/db";
import { MATCH_ODDS_EVENT_META_SELECT, MATCH_ODDS_TABLE } from "./marketQuotes";
import type { SqlParamPusher } from "./marketQuotes";

export function sideCandidates(want: string): { exact: string[]; prefixes: string[] } {
  const exact = new Set<string>([want]);
  const prefixes: string[] = [];

  if (want === "H" || want === "D" || want === "A" || want === "OVER" || want === "UNDER") {
    prefixes.push(want);
  } else if (want.startsWith("htft:")) {
    const code = want.slice(5);
    exact.add(code);
    exact.add(`htft:${code}`);
  } else if (want.startsWith("btts:")) {
    const yes = /YES$/i.test(want);
    if (yes) {
      exact.add("YES");
      exact.add("True");
    } else {
      exact.add("NO");
      exact.add("False");
    }
  }
  return { exact: [...exact], prefixes };
}

export type QuoteCandidateOpts = {
  marketType: string;
  marketScope: string;
  side: string;
  /** [lo, hi] — opening/closing/current oran aralığı (tolerans dahil edilmiş). */
  oddsRange: [number, number];
  price?: "opening" | "closing";
  bookmakerId?: string | null;
  seasonSlugs?: string[];
};

/**
 * Bir kriter için event_id/bookmaker_id/side/opening/current döndüren CTE —
 * match_odds'a karşı basit WHERE.
 */
export function buildQuoteCandidateCte(
  alias: string,
  opts: QuoteCandidateOpts,
  push: SqlParamPusher,
): string {
  const { exact, prefixes } = sideCandidates(opts.side);
  const sideExactPh = exact.map((v) => push(v));
  const sideConds = [`side IN (${sideExactPh.join(", ")})`];
  for (const p of prefixes) {
    const ph = push(p);
    const phPrefix = push(`${p}:%`);
    sideConds.push(`side = ${ph}`);
    sideConds.push(`side LIKE ${phPrefix}`);
  }
  const sideCond = `(${sideConds.join(" OR ")})`;

  const [lo, hi] = opts.oddsRange;
  const loPh = push(lo);
  const hiPh = push(hi);

  const typePh = push(opts.marketType);
  const scopePh = push(opts.marketScope || "FULL_TIME");

  // Nested (bookmaker_id dolu) satırlar bm filtresine tabi; bookmaker_id NULL
  // olan satırlar (bookmaker bilgisi gelmemiş) over-inclusive kalır — JS'te
  // quoteMatchesCriterion zaten bookmakerId null ise BM filtresini atlıyor.
  const bmCond = opts.bookmakerId
    ? `AND (bookmaker_id IS NULL OR bookmaker_id = ${push(String(opts.bookmakerId))})`
    : "";

  const seasons = (opts.seasonSlugs ?? []).filter(Boolean);
  let seasonCond = "";
  if (seasons.length) {
    const phs = seasons.map((s) => push(s));
    seasonCond = `AND season_slug IN (${phs.join(", ")})`;
  }

  const oddsCond =
    opts.price === "opening"
      ? `opening BETWEEN ${loPh} AND ${hiPh}`
      : opts.price === "closing"
        ? `closing BETWEEN ${loPh} AND ${hiPh}`
        : `(closing BETWEEN ${loPh} AND ${hiPh} OR opening BETWEEN ${loPh} AND ${hiPh})`;

  return `
    ${alias} AS (
      SELECT event_id, bookmaker_id, side, opening, closing AS current
      FROM ${MATCH_ODDS_TABLE}
      WHERE market_type = ${typePh}
        AND market_scope = ${scopePh}
        AND ${sideCond}
        AND ${oddsCond}
        ${bmCond}
        ${seasonCond}
    )`;
}

export { MATCH_ODDS_EVENT_META_SELECT };

/** Ham metni + parametreleri Postgres'e (sql.unsafe) gönderen küçük yardımcı. */
export async function runCriteriaQuery<T = Record<string, unknown>>(
  text: string,
  params: unknown[],
): Promise<T[]> {
  const rows = await sql.unsafe(text, params as never[]);
  return rows as unknown as T[];
}
