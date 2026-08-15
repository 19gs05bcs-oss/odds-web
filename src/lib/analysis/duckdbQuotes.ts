/**
 * quotes_flat (bkz. duckdbMaterialize.ts — Koyeb'den NDJSON stream edilip
 * DuckDB'ye toplu yüklenmiş düz tablo) üzerinde çalışan SQL builder'lar.
 *
 * ESKİSİ burada `pg.events.markets_json`'ı json_extract/json_keys/UNNEST
 * ile canlı açıyordu (searchOddsProfileSQL + analyzeSeasonSQL için). Artık
 * quotes_flat zaten düz olduğu için burada hiç JSON fonksiyonu YOK —
 * sadece basit WHERE filtreleri.
 */

export type SqlParamPusher = (v: unknown) => string;

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
 * quotes_flat'e karşı basit WHERE. Kasıtlı olarak biraz gevşek (side için
 * prefix/OR eşleşmesi) — sonuç seti üzerinde profile.ts'teki BİREBİR AYNI
 * `quoteMatchesCriterion` fonksiyonu ile kesin doğrulama Node'da yapılıyor.
 */
export function buildFlatQuoteCandidateCte(
  alias: string,
  opts: QuoteCandidateOpts,
  push: SqlParamPusher,
  tableName: string,
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
      FROM ${tableName}
      WHERE market_type = ${typePh}
        AND market_scope = ${scopePh}
        AND ${sideCond}
        AND ${oddsCond}
        ${bmCond}
        ${seasonCond}
    )`;
}

/** searchOddsProfileSQL.ts'in eşleşen event_id'ler için event meta çekerken kullandığı kolon listesi. */
export const FLAT_EVENT_META_SELECT = `
  event_id, source_event_id, competition, season_slug, round,
  home_team, away_team, kickoff_at, home_score, away_score,
  home_ht_score, away_ht_score`;

export type SeasonQuotesFilters = {
  seasonSlug: string;
  marketType?: string | null;
  marketScope?: string | null;
  bookmakerId?: string | null;
  minOdds?: number | null;
  maxOdds?: number | null;
  targetOdds?: number | null;
  oddsTolerance?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
};

/**
 * Bir sezonun ham quote adaylarını quotes_flat'ten çeken SQL —
 * analyzeSeasonSQL.ts'in kaynağı. Kesin filtre (side substring, competition
 * substring, round, date range post-check) hâlâ mevcut
 * quoteMatchesFilters/analyzeQuotes içinde, değişmeden çalışır — burada
 * sadece satır hacmini erken daraltıyoruz.
 */
export function buildFlatSeasonQuotesSql(
  f: SeasonQuotesFilters,
  push: SqlParamPusher,
  tableName: string,
): string {
  const conds = [`season_slug = ${push(f.seasonSlug)}`];
  if (f.marketType) conds.push(`market_type = ${push(f.marketType)}`);
  if (f.marketScope) conds.push(`market_scope = ${push(f.marketScope)}`);
  if (f.bookmakerId) conds.push(`(bookmaker_id IS NULL OR bookmaker_id = ${push(String(f.bookmakerId))})`);
  if (f.dateFrom) conds.push(`kickoff_at >= ${push(f.dateFrom)}`);
  if (f.dateTo) conds.push(`kickoff_at <= ${push(f.dateTo)}`);

  // odds = closing ?? opening (analyze.ts/filters.ts semantiği) — SQL'de OR ile
  // over-inclusive tutuyoruz, kesin seçim JS'te quoteMatchesFilters'ta yapılıyor.
  if (f.minOdds != null) {
    const ph = push(f.minOdds);
    conds.push(`(closing >= ${ph} OR opening >= ${ph})`);
  }
  if (f.maxOdds != null) {
    const ph = push(f.maxOdds);
    conds.push(`(closing <= ${ph} OR opening <= ${ph})`);
  }
  if (f.targetOdds != null) {
    const tol = f.oddsTolerance != null && f.oddsTolerance >= 0 ? f.oddsTolerance : 0.05;
    const lo = push(f.targetOdds - tol);
    const hi = push(f.targetOdds + tol);
    conds.push(`((closing BETWEEN ${lo} AND ${hi}) OR (opening BETWEEN ${lo} AND ${hi}))`);
  }

  return `
    SELECT
      event_id, source_event_id, competition, season_slug, round,
      home_team, away_team, kickoff_at, home_score, away_score,
      home_ht_score, away_ht_score,
      market_type, market_scope, side, opening, closing, bookmaker_id, active
    FROM ${tableName}
    WHERE ${conds.join(" AND ")}`;
}
