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
  const hasLine = opts.line != null && String(opts.line) !== "";
  const isOverUnder = opts.marketType === "OVER_UNDER";
  const isOneXTwo = opts.marketType === "HOME_DRAW_AWAY";

  // PERFORMANS: `selection LIKE 'p:%'` ve `market LIKE '...:%'` gibi OR'lu
  // kalıplar Postgres'in satır tahminini 1'e düşürüp event_id indeksiyle
  // "nested loop" kurmasına (ölçüm: ~24 sn) yol açıyordu. Veri biçimi bilinen
  // marketlerde (O/U ve 1X2) kesin değerleri yazıyoruz (ölçüm: ~3 sn, aynı sonuç):
  //  - O/U + line: selection "OVER" veya "OVER:2.5"
  //  - 1X2: selection "H" / "D" / "A" (line yok)
  // Diğer marketlerde eski (gevşek) davranış AYNEN korunur.
  const exactSelections = new Set<string>(exact);
  const sideConds: string[] = [];
  const looseExtra: string[] = [];
  for (const p of prefixes) {
    if (isOverUnder && hasLine) {
      exactSelections.add(p);
      exactSelections.add(`${p}:${opts.line}`);
    } else if (isOneXTwo && !hasLine) {
      exactSelections.add(p);
    } else {
      looseExtra.push(`selection = ${push(p)}`);
      looseExtra.push(`selection LIKE ${push(`${p}:%`)}`);
    }
  }
  const sideExactPh = [...exactSelections].map((v) => push(v));
  sideConds.push(`selection IN (${sideExactPh.join(", ")})`);
  sideConds.push(...looseExtra);
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
  // match_odds'ta O/U dışındaki tüm marketler 2 parçalı ("TYPE:SCOPE") saklanıyor
  // (pg_stats: AH/EH dahil). Bu tipler için LIKE'lı OR yerine tam eşitlik.
  const LINELESS_MARKET_TYPES = new Set([
    "HOME_DRAW_AWAY",
    "DOUBLE_CHANCE",
    "BOTH_TEAMS_TO_SCORE",
    "DRAW_NO_BET",
    "HALF_FULL_TIME",
    "CORRECT_SCORE",
    "ODD_OR_EVEN",
  ]);
  const isHandicap =
    opts.marketType === "ASIAN_HANDICAP" || opts.marketType === "EUROPEAN_HANDICAP";
  const marketCond = hasLine
    ? isHandicap
      ? // AH/EH: pg_stats'ta market 2 parçalı ("ASIAN_HANDICAP:FULL_TIME"), line ayrı
        // kolonda — iki biçimi de kabul et; line yine aşağıda line kolonuna karşı doğrulanır.
        `market IN (${push(`${marketBase}:${opts.line}`)}, ${push(marketBase)})`
      : `market = ${push(`${marketBase}:${opts.line}`)}`
    : LINELESS_MARKET_TYPES.has(opts.marketType)
      ? `market = ${push(marketBase)}`
      : `(market = ${push(marketBase)} OR market LIKE ${push(`${marketBase}:%`)})`;

  // line zorunlu marketlerde (O/U, AH, EH) match_odds.line kolonuna karşı da
  // ayrıca doğrula — market string'i zaten line içeriyor ama bu ek kontrol
  // veri tutarsızlığına karşı bir güvenlik supabı.
  let lineCond = "";
  if (hasLine) {
    const linePh = push(String(opts.line));
    lineCond = `AND line::text = ${linePh}`;
  }

  // match_odds.bookmaker'da NULL yok (pg_stats null_frac=0); `bookmaker IS NULL OR`
  // eşitliği indeks kullanımını bozuyordu. JS'te quoteMatchesCriterion ayrıca doğrular.
  const bmCond = opts.bookmakerId
    ? `AND bookmaker = ${push(String(opts.bookmakerId))}`
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

  // MATERIALIZED: her kriter kendi indeksiyle bağımsız okunur, sonra hash join (ölçüm: 10.9sn → 6.4sn soğuk,
  // plan kararlı). Planner'ın yanlış "1 satır" tahminiyle nested-loop kurmasını önler.
  return `
    ${alias} AS MATERIALIZED (
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
