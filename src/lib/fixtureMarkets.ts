import type { CompactOddsRow, FixtureRow } from "@/lib/archiveCache";
import { marketTypeLabel } from "@/lib/analysis/labels";
import type { Market, MarketSelection, MarketsBlob } from "@/lib/types";

const LINE_TYPES = new Set(["OVER_UNDER", "ASIAN_HANDICAP", "EUROPEAN_HANDICAP"]);

const SCOPE_SUFFIX: Record<string, string> = {
  FIRST_HALF: "1st Half",
  SECOND_HALF: "2nd Half",
};

const SIDE_NAMES: Record<string, string> = {
  H: "Home",
  D: "Draw",
  A: "Away",
};

function splitSide(type: string, sideRaw: string): { key: string; line: string | null } {
  const side = String(sideRaw ?? "");
  if (LINE_TYPES.has(type)) {
    const idx = side.lastIndexOf(":");
    if (idx > -1) return { key: side.slice(0, idx), line: side.slice(idx + 1) };
  }
  return { key: side, line: null };
}

function marketName(type: string, scope: string, line: string | null): string {
  const base = marketTypeLabel(type);
  const lineLabel = line ? ` ${line}` : "";
  const scopeLabel = SCOPE_SUFFIX[scope] ? ` — ${SCOPE_SUFFIX[scope]}` : "";
  return `${base}${lineLabel}${scopeLabel}`;
}

const MARKET_ORDER = [
  "HOME_DRAW_AWAY",
  "DOUBLE_CHANCE",
  "DRAW_NO_BET",
  "OVER_UNDER",
  "ASIAN_HANDICAP",
  "EUROPEAN_HANDICAP",
  "BOTH_TEAMS_TO_SCORE",
  "HALF_FULL_TIME",
  "ODD_OR_EVEN",
  "CORRECT_SCORE",
];

/**
 * `fixture.odds` (CompactOddsRow[]) + `fixture.bookmakers` (id → name) tuple
 * verisini, mevcut MarketBoard bileşeninin beklediği MarketsBlob şekline
 * çevirir. Her seçenek için en iyi (en yüksek) güncel oranı gösteren
 * bookmaker öne çıkarılır — odds karşılaştırma sitesi mantığına uygun.
 */
export function compactOddsToMarketsBlob(
  odds: CompactOddsRow[] | null | undefined,
  bookmakerNames: Record<string, string> | null | undefined,
): MarketsBlob {
  const blob: MarketsBlob = { markets: [] };
  if (!odds || !odds.length) return blob;

  type Bucket = {
    type: string;
    scope: string;
    line: string | null;
    selections: Map<string, MarketSelection & { _bookmakerCount: number }>;
  };
  const buckets = new Map<string, Bucket>();

  for (const row of odds) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const [bmId, type, scope, sideRaw, opening, current, active] = row;
    if (current == null && opening == null) continue;
    const { key: sideKey, line } = splitSide(type, sideRaw);
    const marketKey = `${type}|${scope}|${line ?? ""}`;
    let bucket = buckets.get(marketKey);
    if (!bucket) {
      bucket = { type, scope, line, selections: new Map() };
      buckets.set(marketKey, bucket);
    }
    let sel = bucket.selections.get(sideKey);
    if (!sel) {
      sel = {
        key: sideKey,
        name: SIDE_NAMES[sideKey] || sideKey,
        odds: null,
        opening: null,
        suspended: true,
        bookmaker_id: null,
        bookmaker_name: null,
        _bookmakerCount: 0,
      };
      bucket.selections.set(sideKey, sel);
    }
    sel._bookmakerCount += 1;
    if (current != null && (sel.odds == null || current > sel.odds)) {
      sel.odds = current;
      sel.opening = opening;
      sel.bookmaker_id = String(bmId);
      sel.bookmaker_name = bookmakerNames?.[String(bmId)] || `#${bmId}`;
      sel.suspended = !active;
    }
  }

  const markets: Market[] = [];
  for (const bucket of buckets.values()) {
    markets.push({
      key: `${bucket.type}_${bucket.scope}_${bucket.line ?? ""}`,
      name: marketName(bucket.type, bucket.scope, bucket.line),
      type: bucket.type,
      scope: bucket.scope,
      line: bucket.line,
      selections: [...bucket.selections.values()],
    });
  }

  markets.sort((a, b) => {
    const ai = MARKET_ORDER.indexOf(a.type || "");
    const bi = MARKET_ORDER.indexOf(b.type || "");
    const oa = ai === -1 ? 99 : ai;
    const ob = bi === -1 ? 99 : bi;
    if (oa !== ob) return oa - ob;
    return (a.line ? Number(a.line) : 0) - (b.line ? Number(b.line) : 0);
  });

  blob.markets = markets;
  return blob;
}

export function fixtureBookmakerCount(fixture: Pick<FixtureRow, "bookmakers" | "odds">): number {
  if (fixture.bookmakers) return Object.keys(fixture.bookmakers).length;
  const ids = new Set<number>();
  for (const row of fixture.odds || []) {
    if (Array.isArray(row)) ids.add(row[0]);
  }
  return ids.size;
}
