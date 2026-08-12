export type MarketSelection = {
  key: string;
  name: string;
  odds: number | null;
  opening?: number | null;
  suspended: boolean;
  bookmaker_id?: string | null;
  bookmaker_name?: string | null;
  /** All bookmaker quotes; top-level odds/bookmaker_id is only the best price. */
  bookmakers?: Record<
    string,
    { opening?: number | null; current?: number | null; active?: boolean }
  >;
};

export type Market = {
  key: string;
  name: string;
  type?: string;
  scope?: string;
  line?: string | null;
  selections: MarketSelection[];
};

export type MarketsBlob = {
  markets: Market[];
  bookmakers?: Record<string, string>;
};

export type OddsEvent = {
  id: string;
  source: string;
  source_event_id: string;
  sport: string | null;
  competition: string | null;
  home_team: string | null;
  away_team: string | null;
  kickoff_at: string | null;
  status: string | null;
  is_closed: number | boolean | null;
  markets_json: MarketsBlob | string | null;
  markets_hash: string | null;
  odds_updated_at: string | null;
  opening_captured_at: string | null;
  closing_captured_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  round?: string | null;
  home_score?: number | null;
  away_score?: number | null;
  home_ht_score?: number | null;
  away_ht_score?: number | null;
  season_slug?: string | null;
  home_team_id?: string | null;
  away_team_id?: string | null;
};

export type SeasonRow = {
  id: string;
  source: string;
  competition: string | null;
  season_label: string | null;
  template_id: string | null;
  season_code: string | null;
  match_count: number;
  bookmaker_count: number;
  updated_at: string | null;
};

export type BookmakerOption = { id: string; name: string };
