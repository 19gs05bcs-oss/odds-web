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
 *
 * NOT: match_odds gerçek şeması — market (birleşik "TYPE:SCOPE"), selection
 * (side), bookmaker (metin isim), odds (güncel/kapanış). market_type +
 * market_scope ayrı kolon DEĞİL — tek eşitlik olarak birleştirilip
 * filtreleniyor.
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
  /** O/U, AH, EH gibi line zorunlu marketler için — match_odds.line kolonuna karşı filtrelenir. */
  line?: string | number | null;
  /** [lo, hi] — opening/closing/current oran aralığı (tolerans dahil edilmiş). */
  oddsRange: [number, number];
  price?: "opening" | "closing";
  bookmakerId?: string | null;
  seasonSlugs?: string[];
};

/**
 * Bir kriter için event_id/bookmaker/side/opening/current döndüren CTE —
 * match_odds'a karşı basit WHERE.
 */
export function buildQuoteCandidateCte(
  alias: string,
  opts: QuoteCandidateOpts,
  push: SqlParamPusher,
): string {
  const { exact, prefixes } = sideCandidates(opts.side);
  const sideExactPh = exact.map((v) => push(v));
  const sideConds = [`selection IN (${sideExactPh.join(", ")})`];
  for (const p of prefixes) {
    const ph = push(p);
    const phPrefix = push(`${p}:%`);
    sideConds.push(`selection = ${ph}`);
    sideConds.push(`selection LIKE ${phPrefix}`);
  }
  const sideCond = `(${sideConds.join(" OR ")})`;

  const [lo, hi] = opts.oddsRange;
  const loPh = push(lo);
  const hiPh = push(hi);

  // match_odds.market line'lı marketlerde 3 parçalı gelir ("OVER_UNDER:
  // FIRST_HALF:3.5"), line'sız marketlerde 2 parçalı ("HOME_DRAW_AWAY:
  // FULL_TIME"). Line biliniyorsa tam değeri kurup TEK satıra daraltıyoruz;
  // bilinmiyorsa TYPE:SCOPE ile başlayan (line'lı VEYA line'sız) her satırı
  // kabul ediyoruz.
  const marketBase = `${opts.marketType}:${opts.marketScope || "FULL_TIME"}`;
  const hasLine = opts.line != null && String(opts.line) !== "";
  const marketCond = hasLine
    ? `market = ${push(`${marketBase}:${opts.line}`)}`
    : `(market = ${push(marketBase)} OR market LIKE ${push(`${marketBase}:%`)})`;

  // line zorunlu marketlerde (O/U, AH, EH) match_odds.line kolonuna karşı da
  // ayrıca doğrula — market string'i zaten line içeriyor ama bu ek kontrol
  // veri tutarsızlığına karşı bir güvenlik supabı.
  let lineCond = "";
  if (hasLine) {
    const linePh = push(String(opts.line));
    lineCond = `AND line::text = ${linePh}`;
  }

  // Nested (bookmaker dolu) satırlar bm filtresine tabi; bookmaker NULL
  // olan satırlar (bookmaker bilgisi gelmemiş) over-inclusive kalır — JS'te
  // quoteMatchesCriterion zaten bookmakerId null ise BM filtresini atlıyor.
  const bmCond = opts.bookmakerId
    ? `AND (bookmaker IS NULL OR bookmaker = ${push(String(opts.bookmakerId))})`
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
        ? `odds BETWEEN ${loPh} AND ${hiPh}`
        : `(odds BETWEEN ${loPh} AND ${hiPh} OR opening BETWEEN ${loPh} AND ${hiPh})`;

  return `
    ${alias} AS (
      SELECT event_id, bookmaker AS bookmaker_id, selection AS side, line, opening, odds AS current
      FROM ${MATCH_ODDS_TABLE}
      WHERE ${marketCond}
        AND ${sideCond}
        AND ${oddsCond}
        ${lineCond}
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
