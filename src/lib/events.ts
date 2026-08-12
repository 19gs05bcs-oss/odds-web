import { getSupabase, hasSupabaseEnv } from "@/lib/supabase";
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

export async function listOpenEvents(limit = 80): Promise<FetchResult<OddsEvent[]>> {
  if (!hasSupabaseEnv()) {
    return {
      ok: false,
      error: "Supabase ortam değişkenleri eksik.",
      missingEnv: true,
    };
  }
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: "Supabase istemcisi oluşturulamadı.", missingEnv: true };
  }

  const { data, error } = await sb
    .from("events")
    .select(
      "id,source,source_event_id,sport,competition,home_team,away_team,kickoff_at,status,is_closed,markets_json,markets_hash,odds_updated_at,opening_captured_at,closing_captured_at,created_at,updated_at",
    )
    .or("is_closed.eq.0,is_closed.is.null")
    .order("kickoff_at", { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, data: (data ?? []) as OddsEvent[] };
}

export async function getEventById(id: string): Promise<FetchResult<OddsEvent | null>> {
  if (!hasSupabaseEnv()) {
    return {
      ok: false,
      error: "Supabase ortam değişkenleri eksik.",
      missingEnv: true,
    };
  }
  const sb = getSupabase();
  if (!sb) {
    return { ok: false, error: "Supabase istemcisi oluşturulamadı.", missingEnv: true };
  }

  const { data, error } = await sb
    .from("events")
    .select(
      "id,source,source_event_id,sport,competition,home_team,away_team,kickoff_at,status,is_closed,markets_json,markets_hash,odds_updated_at,opening_captured_at,closing_captured_at,created_at,updated_at,round,home_score,away_score,home_ht_score,away_ht_score,season_slug,home_team_id,away_team_id",
    )
    .eq("id", id)
    .maybeSingle();

  if (error && /home_ht_score|away_ht_score/i.test(error.message)) {
    const retry = await sb
      .from("events")
      .select(
        "id,source,source_event_id,sport,competition,home_team,away_team,kickoff_at,status,is_closed,markets_json,markets_hash,odds_updated_at,opening_captured_at,closing_captured_at,created_at,updated_at,round,home_score,away_score,season_slug,home_team_id,away_team_id",
      )
      .eq("id", id)
      .maybeSingle();
    if (retry.error) return { ok: false, error: retry.error.message };
    return { ok: true, data: (retry.data as OddsEvent | null) ?? null };
  }

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, data: (data as OddsEvent | null) ?? null };
}
