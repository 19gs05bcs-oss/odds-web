/**
 * analyzeSeason'ın match_odds'tan (bkz. marketQuotes.ts) beslenen versiyonu.
 * market/scope/bookmaker/odds aralığıyla önceden daraltılmış satırları
 * Postgres'ten çeker — DuckDB/Koyeb'e hiç dokunmaz, markets_json'ı hiç
 * görmez. Dönen Quote[] üzerinde analyze.ts'teki analyzeQuotes (de-vig,
 * drift, edge) DEĞİŞMEDEN çalışır — o da zaten quoteMatchesFilters ile
 * kesin filtreyi tekrar uygular.
 *
 * NOT: match_odds, market_key/market_name/side_name_raw gibi kolonları
 * (bunlar markets_json'daki serbest metin isimlerdi) taşımıyor —
 * marketKey/marketName/line/sideName burada marketType+marketScope+side'dan
 * (labels.ts/normalize.ts'teki AYNI fonksiyonlarla) türetiliyor.
 */
import { fetchSeasonQuoteRows, HARD_ROW_CAP, type MatchOddsRow, type SeasonQuotesFilters } from "./marketQuotes";
import { loadBookmakerNames } from "./bookmakerNames";
import { prettySideName } from "./labels";
import { resolveLine } from "./normalize";
import type { FilterState, Quote } from "./types";

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

export async function loadSeasonQuotesSQL(filters: FilterState): Promise<Quote[]> {
  if (!filters.seasonSlug) return [];

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

  const rows: MatchOddsRow[] = await fetchSeasonQuoteRows(seasonFilters, HARD_ROW_CAP);

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

    // market_line yok (match_odds tablosunda serbest metin market bilgisi
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
