import { sql } from "@/lib/db";
import type { MarketsBlob, OddsEvent } from "@/lib/types";

export type FetchResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; missingEnv?: boolean };

function parseMarkets(raw: OddsEvent["markets_json"]): MarketsBlob {
  if (!raw) return { markets: [] };
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as MarketsBlob;
    } catch {
      return { markets: [] };
    }
  }
  return {
    markets: Array.isArray(raw.markets) ? raw.markets : [],
  };
}

export function marketsFromEvent(event: OddsEvent): MarketsBlob {
  return parseMarkets(event.markets_json);
}

function isMissingHtColumn(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /home_ht_score|away_ht_score|42703/i.test(message);
}

export async function listOpenEvents(limit = 80): Promise<FetchResult<OddsEvent[]>> {
  try {
    const query = `
      SELECT id,source,source_event_id,sport,competition,home_team,away_team,kickoff_at,status,is_closed,markets_json,markets_hash,odds_updated_at,opening_captured_at,closing_captured_at,created_at,updated_at 
      FROM events 
      WHERE (is_closed = 0 OR is_closed IS NULL) 
      ORDER BY kickoff_at ASC 
      LIMIT $1
    `;
    const data = await sql.unsafe<OddsEvent[]>(query, [limit]);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// archive.ts icindeki getEventById'i BUNUNLA degistir:

export async function getEventById(id: string): Promise<FetchResult<OddsEvent | null>> {
  try {
    const { fetchKoyebEvent } = await import("@/lib/koyebCache");
    const event = await fetchKoyebEvent(id);
    return { ok: true, data: (event as unknown as OddsEvent) ?? null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
