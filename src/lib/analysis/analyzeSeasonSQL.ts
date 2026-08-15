import { getDuckDbConnection } from "@/lib/duckdb";
import { buildFlatSeasonQuotesSql, type SeasonQuotesFilters } from "./duckdbQuotes";
import { ensureQuotesTable, QUOTES_FLAT_TABLE } from "./duckdbMaterialize";
import { loadBookmakerNames } from "./bookmakerNames";
import { prettySideName } from "./labels";
import { resolveLine } from "./normalize";
import type { FilterState, Quote } from "./types";

type DuckRow = Record<string, unknown>;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

/** Aşırı geniş/filtresiz istekte bile Node'a inen satır sayısını sınırlayan güvenlik supabı. */
const HARD_ROW_CAP = 20_000;

/**
 * analyzeSeason'ın DuckDB'den beslenen versiyonu. quotes_flat (bkz.
 * duckdbMaterialize.ts — Koyeb'in flat /quotes/season + hafif
 * /events/season endpoint'lerinden NDJSON stream edilip DuckDB'ye toplu
 * yüklenmiş tablo) üzerinden market/scope/bookmaker/odds aralığıyla önceden
 * daraltılmış satırları çeker — Postgres'e hiç dokunmaz, markets_json'ı
 * hiç görmez. Dönen Quote[] üzerinde analyze.ts'teki analyzeQuotes (de-vig,
 * drift, edge) DEĞİŞMEDEN çalışır — o da zaten quoteMatchesFilters ile
 * kesin filtreyi tekrar uygular.
 *
 * NOT: quotes_flat, market_key/market_name/side_name_raw gibi kolonları
 * (bunlar markets_json'daki serbest metin isimlerdi, flat `quotes`
 * tablosunda yok) taşımıyor — marketKey/marketName/line/sideName burada
 * marketType+marketScope+side'dan (labels.ts/normalize.ts'teki AYNI
 * fonksiyonlarla) türetiliyor.
 */
export async function loadSeasonQuotesSQL(filters: FilterState): Promise<Quote[]> {
  if (!filters.seasonSlug) return [];

  const materializeStatus = await ensureQuotesTable();
  if (materializeStatus.status !== "ready") {
    throw new Error(
      `quotes_flat tablosu hazır değil (status=${materializeStatus.status}${
        materializeStatus.error ? `, error=${materializeStatus.error}` : ""
      }).`,
    );
  }

  const conn = await getDuckDbConnection();
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  const seasonFilters: SeasonQuotesFilters = {
    seasonSlug: filters.seasonSlug,
    marketType: filters.marketType,
    marketScope: filters.marketScope,
    bookmakerId: filters.bookmakerId,
    minOdds: filters.minOdds,
    maxOdds: filters.maxOdds,
    targetOdds: filters.targetOdds,
    oddsTolerance: filters.oddsTolerance,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
  };

  const body = buildFlatSeasonQuotesSql(seasonFilters, push, QUOTES_FLAT_TABLE);
  const limitPh = push(HARD_ROW_CAP);
  const text = `${body}\n    LIMIT ${limitPh}`;

  const reader = await conn.runAndReadAll(text, params as never[]);
  const rows = reader.getRowObjectsJS() as DuckRow[];

  if (rows.length >= HARD_ROW_CAP) {
    console.warn(
      `[analyzeSeasonSQL] ${filters.seasonSlug}: satır limiti (${HARD_ROW_CAP}) aşıldı — daha spesifik bir filtre (market/bookmaker) önerin.`,
    );
  }

  const bmNames = await loadBookmakerNames();

  const out: Quote[] = [];
  for (const row of rows) {
    const marketType = str(row.market_type) ?? "UNKNOWN";
    const marketScope = str(row.market_scope) ?? "FULL_TIME";
    const side = str(row.side);
    if (!side) continue;
    const opening = num(row.opening);
    const closing = num(row.closing);
    if (opening == null && closing == null) continue;

    // market_line yok (flat quotes tablosunda serbest metin market bilgisi
    // taşınmıyor) — line, side token'ından türetiliyor (örn. "OVER:2.5").
    const line = resolveLine(marketType, null, side);
    const sideName = prettySideName(side, null, marketType);
    const bookmakerId = str(row.bookmaker_id);

    out.push({
      eventId: String(row.event_id),
      sourceEventId: str(row.source_event_id) ?? "",
      competition: str(row.competition),
      seasonSlug: str(row.season_slug),
      round: str(row.round),
      homeTeam: str(row.home_team),
      awayTeam: str(row.away_team),
      kickoffAt: str(row.kickoff_at),
      homeScore: num(row.home_score),
      awayScore: num(row.away_score),
      homeHtScore: num(row.home_ht_score),
      awayHtScore: num(row.away_ht_score),
      marketType,
      marketScope,
      marketKey: `${marketType}:${marketScope}`,
      marketName: marketType,
      line,
      side,
      sideName,
      opening,
      closing,
      bookmakerId,
      bookmakerName: bookmakerId ? bmNames.get(bookmakerId) ?? null : null,
      suspended: row.active === false || row.active === "false",
    });
  }

  return out;
}
