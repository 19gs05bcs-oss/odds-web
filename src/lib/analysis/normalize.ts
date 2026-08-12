import type { MarketsBlob, OddsEvent } from "@/lib/types";
import { prettySideName } from "./labels";
import type { Quote } from "./types";

type BmQuote = {
  opening?: number | null;
  current?: number | null;
  active?: boolean;
};

type Sel = {
  key?: string;
  name?: string;
  odds?: number | null;
  opening?: number | null;
  suspended?: boolean;
  bookmaker_id?: string | null;
  bookmaker_name?: string | null;
  /** Per-bookmaker quotes (import stores all; top-level is only "best"). */
  bookmakers?: Record<string, BmQuote>;
};

type Mkt = {
  key?: string;
  name?: string;
  type?: string;
  scope?: string;
  line?: string | null;
  selections?: Sel[];
};

function asBlob(raw: OddsEvent["markets_json"]): MarketsBlob & { bookmakers?: Record<string, string> } {
  if (!raw) return { markets: [] };
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as MarketsBlob;
    } catch {
      return { markets: [] };
    }
  }
  return raw as MarketsBlob & { bookmakers?: Record<string, string> };
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function lineFromSideToken(side: string): string | null {
  const m = /^[HDA]:(.+)$/i.exec(side) || /^(?:OVER|UNDER):(.+)$/i.exec(side);
  return m ? m[1] : null;
}

function resolveLine(
  marketType: string,
  marketLine: string | null | undefined,
  side: string,
): string | null {
  if (marketLine != null && marketLine !== "") return String(marketLine);
  if (
    marketType === "ASIAN_HANDICAP" ||
    marketType === "EUROPEAN_HANDICAP" ||
    marketType === "OVER_UNDER"
  ) {
    return lineFromSideToken(side);
  }
  return marketLine ?? null;
}

function pushQuote(
  out: Quote[],
  event: OddsEvent & {
    season_slug?: string | null;
    round?: string | null;
    home_score?: number | null;
    away_score?: number | null;
    home_ht_score?: number | null;
    away_ht_score?: number | null;
  },
  opts: {
    marketType: string;
    marketScope: string;
    marketKey: string;
    marketName: string;
    line: string | null;
    side: string;
    sideName: string;
    opening: number | null;
    closing: number | null;
    bookmakerId: string | null;
    bookmakerName: string | null;
    suspended: boolean;
  },
): void {
  if (opts.closing == null && opts.opening == null) return;
  out.push({
    eventId: event.id,
    sourceEventId: event.source_event_id,
    competition: event.competition,
    seasonSlug: event.season_slug ?? null,
    round: event.round ?? null,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    kickoffAt: event.kickoff_at,
    homeScore: event.home_score ?? null,
    awayScore: event.away_score ?? null,
    homeHtScore: event.home_ht_score ?? null,
    awayHtScore: event.away_ht_score ?? null,
    marketType: opts.marketType,
    marketScope: opts.marketScope,
    marketKey: opts.marketKey,
    marketName: opts.marketName,
    line: opts.line,
    side: opts.side,
    sideName: opts.sideName,
    opening: opts.opening,
    closing: opts.closing,
    bookmakerId: opts.bookmakerId,
    bookmakerName: opts.bookmakerName,
    suspended: opts.suspended,
  });
}

/** Flatten event markets_json into analysis Quote rows (one per selection × bookmaker). */
export function normalizeEventQuotes(event: OddsEvent & {
  season_slug?: string | null;
  round?: string | null;
  home_score?: number | null;
  away_score?: number | null;
  home_ht_score?: number | null;
  away_ht_score?: number | null;
}): Quote[] {
  const blob = asBlob(event.markets_json);
  const markets = (blob.markets ?? []) as Mkt[];
  const bmNames = blob.bookmakers ?? {};
  const out: Quote[] = [];

  for (const m of markets) {
    const marketType = m.type || "UNKNOWN";
    const marketScope = m.scope || "FULL_TIME";
    const marketKey = m.key || `${marketType}:${marketScope}`;
    const marketName = m.name || marketType;

    for (const s of m.selections ?? []) {
      const side = s.key || "?";
      const line = resolveLine(marketType, m.line, side);
      const sideName = prettySideName(side, s.name, marketType);
      const nested = s.bookmakers;

      if (nested && typeof nested === "object" && Object.keys(nested).length > 0) {
        for (const [bid, q] of Object.entries(nested)) {
          if (!bid) continue;
          const closing = num(q?.current);
          const opening = num(q?.opening);
          // inactive rows still useful for opening history; skip only if no prices
          if (closing == null && opening == null) continue;
          pushQuote(out, event, {
            marketType,
            marketScope,
            marketKey,
            marketName,
            line,
            side,
            sideName,
            opening,
            closing,
            bookmakerId: String(bid),
            bookmakerName: bmNames[String(bid)] ?? null,
            suspended: q?.active === false,
          });
        }
        continue;
      }

      // Legacy / slim blob: tek bookmaker (genelde en yüksek oran) — BM filtresini atla
      pushQuote(out, event, {
        marketType,
        marketScope,
        marketKey,
        marketName,
        line,
        side,
        sideName,
        opening: num(s.opening),
        closing: num(s.odds),
        bookmakerId: null,
        bookmakerName: s.bookmaker_name ?? null,
        suspended: Boolean(s.suspended),
      });
    }
  }
  return out;
}

export function normalizeMany(events: Array<OddsEvent & {
  season_slug?: string | null;
  round?: string | null;
  home_score?: number | null;
  away_score?: number | null;
  home_ht_score?: number | null;
  away_ht_score?: number | null;
}>): Quote[] {
  const all: Quote[] = [];
  for (const e of events) {
    const rows = normalizeEventQuotes(e);
    for (const r of rows) all.push(r);
  }
  return all;
}
