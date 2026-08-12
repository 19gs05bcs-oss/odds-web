/** Framework-agnostic odds analysis types. */

export type MarketType =
  | "HOME_DRAW_AWAY"
  | "DOUBLE_CHANCE"
  | "DRAW_NO_BET"
  | "BOTH_TEAMS_TO_SCORE"
  | "OVER_UNDER"
  | "ASIAN_HANDICAP"
  | "EUROPEAN_HANDICAP"
  | "CORRECT_SCORE"
  | "HALF_FULL_TIME"
  | "ODD_OR_EVEN"
  | string;

export type MarketScope = "FULL_TIME" | "FIRST_HALF" | "SECOND_HALF" | string;

export type Quote = {
  eventId: string;
  sourceEventId: string;
  competition: string | null;
  seasonSlug: string | null;
  round: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  kickoffAt: string | null;
  homeScore: number | null;
  awayScore: number | null;
  homeHtScore?: number | null;
  awayHtScore?: number | null;
  marketType: MarketType;
  marketScope: MarketScope;
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
};

export type SortKey = "edge" | "drift" | "kickoff" | "odds" | "absDrift";

export type FilterState = {
  seasonSlug?: string | null;
  competition?: string | null;
  round?: string | null;
  marketType?: string | null;
  marketScope?: string | null;
  bookmakerId?: string | null;
  side?: string | null;
  minOdds?: number | null;
  maxOdds?: number | null;
  /** Excel-like: find odds near this value. */
  targetOdds?: number | null;
  /** Absolute tolerance around targetOdds (default 0.05). */
  oddsTolerance?: number | null;
  /** Absolute opening→closing drift in % (secondary metric filter). */
  minAbsDriftPct?: number | null;
  minEdgePct?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  sort?: SortKey;
  sortDir?: "asc" | "desc";
  limit?: number;
};

export type AnalysisRow = {
  eventId: string;
  sourceEventId: string;
  competition: string | null;
  seasonSlug: string | null;
  round: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  kickoffAt: string | null;
  score: string | null;
  marketType: string;
  marketScope: string;
  marketName: string;
  line: string | null;
  side: string;
  sideName: string;
  opening: number | null;
  closing: number | null;
  driftOddsPct: number | null;
  driftProbPct: number | null;
  impliedOpen: number | null;
  impliedClose: number | null;
  fairProb: number | null;
  edgePct: number | null;
  bookmakerId: string | null;
  bookmakerName: string | null;
};

export type AnalyzeResult = {
  rows: AnalysisRow[];
  totalMatched: number;
  truncated: boolean;
  tookMs: number;
};
