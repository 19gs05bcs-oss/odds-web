/**
 * events.markets_json (nested JSON) → quote satırları, DuckDB JSON
 * fonksiyonları ile (json_extract / json_keys / UNNEST), Node'a hiç
 * markets_json çekmeden. normalize.ts'teki normalizeEventQuotes'un
 * SQL eşdeğeri — iki dal aynı: (1) selection.bookmakers{id:{opening,current}}
 * nested map'i, (2) legacy slim blob (tek satır, opening/odds top-level).
 *
 * Kasıtlı olarak biraz gevşek: side/line eşleşmesinin tam biçimsel
 * doğrulaması (sideEquals/lineEquals, profile.ts) Node tarafında,
 * SQL sonuçları üzerinde ayrıca yapılır. Burada amaç Postgres→DuckDB'ye
 * inen satır sayısını mümkün olduğunca erken (market_type/scope/side/odds
 * aralığı ile) daraltmak.
 */

export type SqlParamPusher = (v: unknown) => string;

function sideCandidates(want: string): { exact: string[]; prefixes: string[] } {
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

export { sideCandidates };

/** JSON path'te tek tırnak/özel karakter güvenliği için side/market string'lerini escape'ler. */
function jsonKeyExpr(bmIdExpr: string, field: "opening" | "current"): string {
  // '$.bookmakers.' || bm_id || '.opening' — bm_id UNNEST(json_keys(...))'dan geliyor,
  // yani her zaman gerçek bir JSON key'i (kullanıcı input'u değil).
  return `json_extract_string(s, '$.bookmakers.' || ${bmIdExpr} || '.${field}')`;
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
 * Bir kriter için event_id/bookmaker_id/side/opening/current döndüren CTE.
 * `alias`: CTE adı (q0, q1, ...). `push`: parametreyi $N'e çevirip ekleyen fonksiyon.
 */
export function buildQuoteCandidateCte(
  alias: string,
  opts: QuoteCandidateOpts,
  push: SqlParamPusher,
): string {
  const { exact, prefixes } = sideCandidates(opts.side);
  const sideExactPh = exact.map((v) => push(v));
  const sideConds = [`json_extract_string(s, '$.key') IN (${sideExactPh.join(", ")})`];
  for (const p of prefixes) {
    const ph = push(p);
    const phPrefix = push(`${p}:%`);
    sideConds.push(`json_extract_string(s, '$.key') = ${ph}`);
    sideConds.push(`json_extract_string(s, '$.key') LIKE ${phPrefix}`);
  }
  const sideCond = `(${sideConds.join(" OR ")})`;

  const [lo, hi] = opts.oddsRange;
  const loPh = push(lo);
  const hiPh = push(hi);

  const typePh = push(opts.marketType);
  const scopePh = push(opts.marketScope || "FULL_TIME");

  const bmCondNested = opts.bookmakerId ? `AND bm_id = ${push(String(opts.bookmakerId))}` : "";
  // Legacy/slim daldaki satırların bookmaker_id'si NULL — bir bookmaker filtresi
  // verilmişse bu satırlar zaten profile.ts'in quoteMatchesCriterion'ında
  // (bookmakerId null ise BM filtresi atlanır) elenmiyor, o yüzden burada
  // slim dalı bookmaker filtresiyle KISITLAMIYORUZ (over-inclusive kalsın).

  const seasons = (opts.seasonSlugs ?? []).filter(Boolean);
  let seasonCond = "";
  if (seasons.length) {
    const phs = seasons.map((s) => push(s));
    seasonCond = `AND e.season_slug IN (${phs.join(", ")})`;
  }

  const nestedOpening = jsonKeyExpr("bm_id", "opening");
  const nestedCurrent = jsonKeyExpr("bm_id", "current");

  let nestedOddsCond: string;
  let slimOddsCond: string;
  if (opts.price === "opening") {
    nestedOddsCond = `TRY_CAST(${nestedOpening} AS DOUBLE) BETWEEN ${loPh} AND ${hiPh}`;
    slimOddsCond = `TRY_CAST(json_extract_string(s, '$.opening') AS DOUBLE) BETWEEN ${loPh} AND ${hiPh}`;
  } else if (opts.price === "closing") {
    nestedOddsCond = `TRY_CAST(${nestedCurrent} AS DOUBLE) BETWEEN ${loPh} AND ${hiPh}`;
    slimOddsCond = `TRY_CAST(json_extract_string(s, '$.odds') AS DOUBLE) BETWEEN ${loPh} AND ${hiPh}`;
  } else {
    nestedOddsCond = `(TRY_CAST(${nestedCurrent} AS DOUBLE) BETWEEN ${loPh} AND ${hiPh} OR TRY_CAST(${nestedOpening} AS DOUBLE) BETWEEN ${loPh} AND ${hiPh})`;
    slimOddsCond = `(TRY_CAST(json_extract_string(s, '$.odds') AS DOUBLE) BETWEEN ${loPh} AND ${hiPh} OR TRY_CAST(json_extract_string(s, '$.opening') AS DOUBLE) BETWEEN ${loPh} AND ${hiPh})`;
  }

  return `
    ${alias} AS (
      SELECT e.id AS event_id, bm_id AS bookmaker_id,
        json_extract_string(s, '$.key') AS side,
        TRY_CAST(${nestedOpening} AS DOUBLE) AS opening,
        TRY_CAST(${nestedCurrent} AS DOUBLE) AS current
      FROM pg.events e,
           UNNEST(CAST(json_extract(e.markets_json, '$.markets') AS JSON[])) AS tm(m),
           UNNEST(CAST(json_extract(m, '$.selections') AS JSON[])) AS ts(s),
           UNNEST(json_keys(json_extract(s, '$.bookmakers'))) AS tb(bm_id)
      WHERE e.source = 'flashscore'
        AND json_extract_string(m, '$.type') = ${typePh}
        AND COALESCE(json_extract_string(m, '$.scope'), 'FULL_TIME') = ${scopePh}
        AND ${sideCond}
        AND ${nestedOddsCond}
        ${bmCondNested}
        ${seasonCond}

      UNION ALL

      SELECT e.id AS event_id, NULL AS bookmaker_id,
        json_extract_string(s, '$.key') AS side,
        TRY_CAST(json_extract_string(s, '$.opening') AS DOUBLE) AS opening,
        TRY_CAST(json_extract_string(s, '$.odds') AS DOUBLE) AS current
      FROM pg.events e,
           UNNEST(CAST(json_extract(e.markets_json, '$.markets') AS JSON[])) AS tm(m),
           UNNEST(CAST(json_extract(m, '$.selections') AS JSON[])) AS ts(s)
      WHERE e.source = 'flashscore'
        AND COALESCE(len(json_keys(json_extract(s, '$.bookmakers'))), 0) = 0
        AND json_extract_string(m, '$.type') = ${typePh}
        AND COALESCE(json_extract_string(m, '$.scope'), 'FULL_TIME') = ${scopePh}
        AND ${sideCond}
        AND ${slimOddsCond}
        ${seasonCond}
    )`;
}

/** Event meta kolonları — her sorguda aynı, tek yerden yönetelim. */
export const EVENT_META_SELECT = `
  e.id AS event_id, e.source_event_id, e.competition, e.season_slug, e.round,
  e.home_team, e.away_team, e.kickoff_at, e.home_score, e.away_score,
  e.home_ht_score, e.away_ht_score`;

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
 * Bir sezonun ham quote adaylarını (event meta + market/side/odds/bookmaker)
 * döndüren SQL — analyzeSeason'ın eski "tüm sezonu markets_json'dan
 * normalizeMany ile Node'a çek" adımının yerini alır. Kasıtlı olarak
 * gevşek: kesin filtre (side substring, competition substring, round,
 * date range post-check) hâlâ mevcut quoteMatchesFilters/analyzeQuotes
 * içinde, değişmeden çalışır — burada sadece Postgres→DuckDB→Node'a
 * inen satır hacmini erken daraltıyoruz (marketType/scope/bookmaker/odds
 * aralığı ile).
 */
export function buildSeasonQuotesSql(f: SeasonQuotesFilters, push: SqlParamPusher): string {
  const eventConds = [`e.source = 'flashscore'`, `e.season_slug = ${push(f.seasonSlug)}`];
  if (f.dateFrom) eventConds.push(`e.kickoff_at >= ${push(f.dateFrom)}`);
  if (f.dateTo) eventConds.push(`e.kickoff_at <= ${push(f.dateTo)}`);
  const eventCond = eventConds.join(" AND ");

  const marketConds: string[] = [];
  if (f.marketType) marketConds.push(`json_extract_string(m, '$.type') = ${push(f.marketType)}`);
  if (f.marketScope) {
    marketConds.push(
      `COALESCE(json_extract_string(m, '$.scope'), 'FULL_TIME') = ${push(f.marketScope)}`,
    );
  }
  const marketCond = marketConds.length ? `AND ${marketConds.join(" AND ")}` : "";

  // odds = closing ?? opening (analyze.ts/filters.ts semantiği) — SQL'de OR ile
  // over-inclusive tutuyoruz, kesin seçim JS'te quoteMatchesFilters'ta yapılıyor.
  function oddsRangeCond(closingExpr: string, openingExpr: string): string {
    const parts: string[] = [];
    if (f.minOdds != null) {
      const ph = push(f.minOdds);
      parts.push(`(${closingExpr} >= ${ph} OR ${openingExpr} >= ${ph})`);
    }
    if (f.maxOdds != null) {
      const ph = push(f.maxOdds);
      parts.push(`(${closingExpr} <= ${ph} OR ${openingExpr} <= ${ph})`);
    }
    if (f.targetOdds != null) {
      const tol = f.oddsTolerance != null && f.oddsTolerance >= 0 ? f.oddsTolerance : 0.05;
      const lo = push(f.targetOdds - tol);
      const hi = push(f.targetOdds + tol);
      parts.push(
        `((${closingExpr} BETWEEN ${lo} AND ${hi}) OR (${openingExpr} BETWEEN ${lo} AND ${hi}))`,
      );
    }
    return parts.length ? `AND ${parts.join(" AND ")}` : "";
  }

  const nestedOpening = jsonKeyExpr("bm_id", "opening");
  const nestedCurrent = jsonKeyExpr("bm_id", "current");
  const nestedOddsCond = oddsRangeCond(
    `TRY_CAST(${nestedCurrent} AS DOUBLE)`,
    `TRY_CAST(${nestedOpening} AS DOUBLE)`,
  );
  const nestedBmCond = f.bookmakerId ? `AND bm_id = ${push(String(f.bookmakerId))}` : "";

  const nestedBranch = `
    SELECT ${EVENT_META_SELECT},
      json_extract_string(m, '$.type') AS market_type,
      COALESCE(json_extract_string(m, '$.scope'), 'FULL_TIME') AS market_scope,
      json_extract_string(m, '$.key') AS market_key,
      json_extract_string(m, '$.name') AS market_name,
      json_extract_string(m, '$.line') AS market_line,
      json_extract_string(s, '$.key') AS side,
      json_extract_string(s, '$.name') AS side_name_raw,
      TRY_CAST(${nestedOpening} AS DOUBLE) AS opening,
      TRY_CAST(${nestedCurrent} AS DOUBLE) AS closing,
      bm_id AS bookmaker_id,
      json_extract_string(e.markets_json, '$.bookmakers.' || bm_id) AS bookmaker_name,
      (json_extract_string(s, '$.bookmakers.' || bm_id || '.active') = 'false') AS suspended
    FROM pg.events e,
         UNNEST(CAST(json_extract(e.markets_json, '$.markets') AS JSON[])) AS tm(m),
         UNNEST(CAST(json_extract(m, '$.selections') AS JSON[])) AS ts(s),
         UNNEST(json_keys(json_extract(s, '$.bookmakers'))) AS tb(bm_id)
    WHERE ${eventCond}
      ${marketCond}
      ${nestedBmCond}
      ${nestedOddsCond}`;

  // bookmakerId filtresi verilmişse slim dal (bookmaker_id her zaman NULL) zaten
  // quoteMatchesFilters'ta elenecek — sorguya hiç dahil etmeyelim.
  if (f.bookmakerId) {
    return nestedBranch;
  }

  const slimOddsCond = oddsRangeCond(
    `TRY_CAST(json_extract_string(s, '$.odds') AS DOUBLE)`,
    `TRY_CAST(json_extract_string(s, '$.opening') AS DOUBLE)`,
  );

  const slimBranch = `
    SELECT ${EVENT_META_SELECT},
      json_extract_string(m, '$.type') AS market_type,
      COALESCE(json_extract_string(m, '$.scope'), 'FULL_TIME') AS market_scope,
      json_extract_string(m, '$.key') AS market_key,
      json_extract_string(m, '$.name') AS market_name,
      json_extract_string(m, '$.line') AS market_line,
      json_extract_string(s, '$.key') AS side,
      json_extract_string(s, '$.name') AS side_name_raw,
      TRY_CAST(json_extract_string(s, '$.opening') AS DOUBLE) AS opening,
      TRY_CAST(json_extract_string(s, '$.odds') AS DOUBLE) AS closing,
      NULL AS bookmaker_id,
      json_extract_string(s, '$.bookmaker_name') AS bookmaker_name,
      COALESCE(TRY_CAST(json_extract_string(s, '$.suspended') AS BOOLEAN), false) AS suspended
    FROM pg.events e,
         UNNEST(CAST(json_extract(e.markets_json, '$.markets') AS JSON[])) AS tm(m),
         UNNEST(CAST(json_extract(m, '$.selections') AS JSON[])) AS ts(s)
    WHERE ${eventCond}
      AND COALESCE(len(json_keys(json_extract(s, '$.bookmakers'))), 0) = 0
      ${marketCond}
      ${slimOddsCond}`;

  return `${nestedBranch}\n    UNION ALL\n${slimBranch}`;
}
