/** Build analyze table rows from fixtures / archive profile matches. */

import type { MarketColumnDef, MetaField, TableColumnDef } from "@/lib/analysis/tableColumns";
import { ALL_COLUMNS, criterionMatchesColumn } from "@/lib/analysis/tableColumns";
import type { OddsCriterion, ProfileMatch } from "@/lib/analysis/profile";
import type { MatchOddsWithMetaRow } from "@/lib/analysis/marketQuotes";
import { splitMarket } from "@/lib/analysis/marketFormat";
import type { CompactOddsRow, FixtureRow } from "@/lib/fixtures";
import type { MarketsBlob, OddsEvent } from "@/lib/types";

/** Canlı bülten (fixture.odds/markets_json) yolunda kullanılan Flashscore-numeric bookmaker id. */
export const PREFERRED_BM = 16;

/**
 * match_odds.bookmaker artık isim (ör. "bet365"), sayısal Flashscore id
 * DEĞİL. CompactOddsRow/oddsByColumn sayısal bm bekliyor — isimden basit,
 * kararlı bir pseudo-id türetiyoruz. Bu id gerçek Flashscore id'siyle
 * eşleşmek zorunda değil, sadece "aynı isim -> aynı sayı" tutarlılığı
 * (tercih/eşleştirme karşılaştırması için) yeterli.
 */
export function bookmakerNameToPseudoId(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return (h % 999983) + 1; // 0 hariç — bazı yerlerde "bm > 0" kontrolü var
}

/** match_odds yolunda tercih edilen referans bookmaker (isim bazlı). */
export const PREFERRED_BM_NAME = "bet365";

export type RowSource = "fixture" | "archive";

/** Opening + closing (current) for one market column. */
export type CellOdds = {
  opening: number | null;
  closing: number | null;
};

export type TableRow = {
  id: string;
  source: RowSource;
  meta: Record<MetaField, string>;
  /** column id → opening/closing pair */
  odds: Record<string, CellOdds | null>;
  /** column id → outcome hint for settled matches */
  outcome: Record<string, "hit" | "miss" | null>;
  homeScore: number | null;
  awayScore: number | null;
};

/** Prefer closing; fall back to opening. Used for filters / click-to-search. */
export function cellOddsValue(c: CellOdds | null | undefined): number | null {
  if (!c) return null;
  if (c.closing != null && Number.isFinite(c.closing) && c.closing >= 1.01) return c.closing;
  if (c.opening != null && Number.isFinite(c.opening) && c.opening >= 1.01) return c.opening;
  return null;
}

function parseOddsNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1.01 ? n : null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function splitLeague(league: string | null | undefined): { lig: string; altLig: string } {
  const raw = (league || "").trim();
  if (!raw) return { lig: "", altLig: "" };
  const idx = raw.indexOf(":");
  if (idx === -1) return { lig: raw, altLig: "" };
  return { lig: raw.slice(0, idx).trim(), altLig: raw.slice(idx + 1).trim() };
}

type KickoffMeta = Pick<
  Record<MetaField, string>,
  "tarih" | "yil" | "ay" | "gun" | "gunAdi" | "saat"
>;

export function kickoffParts(iso: string | null | undefined): KickoffMeta {
  const empty: KickoffMeta = {
    tarih: "",
    yil: "",
    ay: "",
    gun: "",
    gunAdi: "",
    saat: "",
  };
  if (!iso) return empty;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return empty;
  const yil = String(d.getFullYear());
  const ay = String(d.getMonth() + 1).padStart(2, "0");
  const gun = String(d.getDate()).padStart(2, "0");
  const saat = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return {
    // Short date so sticky/adjacent columns don't collide (YEAR is optional).
    tarih: `${gun}.${ay}.${yil.slice(-2)}`,
    yil,
    ay,
    gun,
    gunAdi: DAY_NAMES[d.getDay()] || "",
    saat,
  };
}

/** Fix broken scrape sides: p:<teamId> → H/A when ids known; p:id:line → H:line. */
export function normalizeSideToken(
  sideTok: string,
  homeId?: string | null,
  awayId?: string | null,
): string {
  const s = String(sideTok || "").trim();
  const m = /^p:([^:]+)(?::(.+))?$/.exec(s);
  if (!m) return s;
  const pid = m[1];
  const line = m[2];
  let base: string | null = null;
  if (homeId && pid === String(homeId)) base = "H";
  else if (awayId && pid === String(awayId)) base = "A";
  if (!base) return s;
  return line != null && line !== "" ? `${base}:${line}` : base;
}

function parseSideToken(side: string): { side: string; line: number | null; raw: string } {
  const s = String(side || "").trim();
  if (s.startsWith("OVER:")) {
    const line = Number(s.slice(5));
    return { side: "OVER", line: Number.isFinite(line) ? line : null, raw: s };
  }
  if (s.startsWith("UNDER:")) {
    const line = Number(s.slice(6));
    return { side: "UNDER", line: Number.isFinite(line) ? line : null, raw: s };
  }
  if (s.startsWith("H:") || s.startsWith("A:") || s.startsWith("D:")) {
    const line = Number(s.slice(2));
    return { side: s[0], line: Number.isFinite(line) ? line : null, raw: s };
  }
  return { side: s, line: null, raw: s };
}

function lineClose(a: number | null, b: string | null | undefined): boolean {
  if (b == null || b === "") return a == null;
  if (a == null) return false;
  return Math.abs(a - Number(b)) < 1e-9 || String(a) === String(b);
}

function oddsValue(opening: unknown, current: unknown): number | null {
  return parseOddsNum(current) ?? parseOddsNum(opening);
}

function pairFromCompact(opening: unknown, current: unknown): CellOdds | null {
  const op = parseOddsNum(opening);
  const cur = parseOddsNum(current);
  if (op == null && cur == null) return null;
  return { opening: op, closing: cur ?? op };
}

function isActiveFlag(active: unknown): boolean {
  if (active === false || active === 0 || active === "0" || active === "false" || active === "False")
    return false;
  return true;
}

function compactMatchesCol(
  mtype: string,
  scope: string,
  sideTok: string,
  col: MarketColumnDef,
): boolean {
  if (mtype !== col.marketType) return false;
  if (scope !== col.marketScope) return false;
  const parsed = parseSideToken(sideTok);

  if (col.marketType === "OVER_UNDER") {
    if (parsed.side !== col.side && !sideTok.startsWith(col.side + ":")) return false;
    return lineClose(parsed.line, col.line);
  }
  if (col.marketType === "ASIAN_HANDICAP" || col.marketType === "EUROPEAN_HANDICAP") {
    if (parsed.side !== col.side) return false;
    return lineClose(parsed.line, col.line);
  }
  if (col.marketType === "HALF_FULL_TIME") {
    return sideTok === col.side || sideTok === col.side.replace(/^htft:/, "");
  }
  if (col.marketType === "BOTH_TEAMS_TO_SCORE") {
    const wantYes = col.side.endsWith("YES");
    return wantYes
      ? /btts:(YES|True)$/i.test(sideTok) || sideTok === "YES" || sideTok === "True"
      : /btts:(NO|False)$/i.test(sideTok) || sideTok === "NO" || sideTok === "False";
  }
  if (col.marketType === "DOUBLE_CHANCE") {
    return sideTok === col.side || parsed.side === col.side;
  }
  if (col.marketType === "CORRECT_SCORE") {
    return sideTok === col.side || sideTok === `score:${col.side.replace(/^score:/, "")}`;
  }
  // 1X2 / DNB
  return parsed.side === col.side || sideTok === col.side;
}

type OddsOpts = {
  bookmakerId?: number;
  homeId?: string | null;
  awayId?: string | null;
};

/**
 * When scrape used wrong team ids, 1X2 sides are p:<id> not H/A.
 * Flashscore order is usually home, draw, away — map first/second p:* to H/A.
 */
function fillHdaFromParticipantOrder(
  rows: CompactOddsRow[],
  bookmakerId: number,
  out: Record<string, CellOdds | null>,
  score: Record<string, number>,
): void {
  const scopes: { scope: string; hCol: string; aCol: string }[] = [
    { scope: "FULL_TIME", hCol: "ms_1", aCol: "ms_2" },
    { scope: "FIRST_HALF", hCol: "ht_1", aCol: "ht_2" },
  ];

  for (const { scope, hCol, aCol } of scopes) {
    if (out[hCol] != null && out[aCol] != null) continue;

    type Cand = { bm: number; prefer: number; side: string; pair: CellOdds; idx: number };
    const cands: Cand[] = [];
    rows.forEach((row, idx) => {
      if (!Array.isArray(row) || row.length < 7) return;
      const [bmId, mtype, sc, sideTok, opening, current, active] = row;
      if (String(mtype) !== "HOME_DRAW_AWAY" || String(sc) !== scope) return;
      if (!isActiveFlag(active)) return;
      const side = String(sideTok);
      if (side === "D" || side.startsWith("D:")) return;
      if (!(side.startsWith("p:") || side === "H" || side === "A" || side.startsWith("H:") || side.startsWith("A:"))) {
        return;
      }
      const pair = pairFromCompact(opening, current);
      if (!pair) return;
      const prefer = Number(bmId) === bookmakerId ? 2 : 1;
      cands.push({ bm: Number(bmId), prefer, side, pair, idx });
    });
    if (!cands.length) continue;

    const maxPrefer = Math.max(...cands.map((c) => c.prefer));
    const best = cands.filter((c) => c.prefer === maxPrefer).sort((a, b) => a.idx - b.idx);

    const ordered: { key: string; pair: CellOdds }[] = [];
    const seen = new Set<string>();
    for (const c of best) {
      let key = c.side;
      if (key === "H" || key.startsWith("H:")) key = "H";
      else if (key === "A" || key.startsWith("A:")) key = "A";
      else if (key.startsWith("p:")) key = key.split(":").slice(0, 2).join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push({ key, pair: c.pair });
    }

    if (ordered.length >= 1 && out[hCol] == null && (score[hCol] ?? 0) <= maxPrefer) {
      const home = ordered.find((o) => o.key === "H") || ordered[0];
      out[hCol] = home.pair;
      score[hCol] = maxPrefer;
    }
    if (ordered.length >= 2 && out[aCol] == null && (score[aCol] ?? 0) <= maxPrefer) {
      const away = ordered.find((o) => o.key === "A") || ordered[ordered.length - 1];
      if (away.key !== (ordered.find((o) => o.key === "H") || ordered[0]).key) {
        out[aCol] = away.pair;
        score[aCol] = maxPrefer;
      }
    }
  }
}

export function oddsByColumn(
  odds: CompactOddsRow[] | null | undefined,
  bookmakerIdOrOpts: number | OddsOpts = PREFERRED_BM,
): Record<string, CellOdds | null> {
  const opts: OddsOpts =
    typeof bookmakerIdOrOpts === "number"
      ? { bookmakerId: bookmakerIdOrOpts }
      : bookmakerIdOrOpts;
  const bookmakerId = opts.bookmakerId ?? PREFERRED_BM;
  const homeId = opts.homeId ?? null;
  const awayId = opts.awayId ?? null;

  const marketCols = ALL_COLUMNS.filter((c): c is MarketColumnDef => c.kind === "market");
  const out: Record<string, CellOdds | null> = {};
  for (const c of marketCols) out[c.id] = null;

  const rows = Array.isArray(odds) ? odds : [];
  const score: Record<string, number> = {};

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const [bmId, mtype, scope, sideTok, opening, current, active] = row;
    if (!isActiveFlag(active)) continue;
    const pair = pairFromCompact(opening, current);
    if (!pair) continue;
    const prefer = Number(bmId) === bookmakerId ? 2 : 1;
    const side = normalizeSideToken(String(sideTok), homeId, awayId);

    for (const col of marketCols) {
      if (!compactMatchesCol(String(mtype), String(scope), side, col)) continue;
      const prev = score[col.id] ?? 0;
      if (prefer < prev) continue;
      if (prefer === prev && out[col.id] != null) continue;
      out[col.id] = pair;
      score[col.id] = prefer;
    }
  }

  fillHdaFromParticipantOrder(rows, bookmakerId, out, score);

  return out;
}

function parseScore(home: unknown, away: unknown): { h: number | null; a: number | null } {
  const h = home === null || home === undefined || home === "" ? null : Number(home);
  const a = away === null || away === undefined || away === "" ? null : Number(away);
  return {
    h: h != null && Number.isFinite(h) ? h : null,
    a: a != null && Number.isFinite(a) ? a : null,
  };
}

/** Prematch 0-0 / future kickoff → no outcome paint. */
export function isMatchSettled(
  kickoffAt: string | null | undefined,
  homeScore: number | null,
  awayScore: number | null,
): boolean {
  if (homeScore == null || awayScore == null) return false;
  if (!kickoffAt) return false;
  const t = new Date(kickoffAt).getTime();
  if (Number.isNaN(t)) return false;
  // Kickoff + 100 dk geçmeden boyama (0-0 prematch sahte isabet olmasın)
  return Date.now() > t + 100 * 60 * 1000;
}

/** Outcome coloring for settled 1X2 / OU / BTTS columns. */
export function outcomeForColumns(
  homeScore: number | null,
  awayScore: number | null,
  cols: TableColumnDef[],
  kickoffAt?: string | null,
  homeHtScore?: number | null,
  awayHtScore?: number | null,
): Record<string, "hit" | "miss" | null> {
  const out: Record<string, "hit" | "miss" | null> = {};
  for (const c of cols) {
    if (c.kind === "meta") continue;
    out[c.id] = null;
  }
  if (!isMatchSettled(kickoffAt, homeScore, awayScore)) return out;
  if (homeScore == null || awayScore == null) return out;

  const total = homeScore + awayScore;
  const result = homeScore > awayScore ? "H" : homeScore < awayScore ? "A" : "D";
  const btts = homeScore > 0 && awayScore > 0;
  const htReady = homeHtScore != null && awayHtScore != null;
  const htTotal = htReady ? homeHtScore! + awayHtScore! : null;
  const htResult = htReady
    ? homeHtScore! > awayHtScore!
      ? "H"
      : homeHtScore! < awayHtScore!
        ? "A"
        : "D"
    : null;

  for (const c of cols) {
    if (c.kind !== "market") continue;
    if (c.marketType === "HOME_DRAW_AWAY" && c.marketScope === "FULL_TIME") {
      out[c.id] = c.side === result ? "hit" : "miss";
    } else if (c.marketType === "HOME_DRAW_AWAY" && c.marketScope === "FIRST_HALF" && htResult) {
      out[c.id] = c.side === htResult ? "hit" : "miss";
    } else if (c.marketType === "OVER_UNDER" && c.marketScope === "FULL_TIME" && c.line) {
      const line = Number(c.line);
      if (!Number.isFinite(line)) continue;
      const over = total > line;
      const under = total < line;
      if (total === line) {
        out[c.id] = null;
      } else if (c.side === "OVER") {
        out[c.id] = over ? "hit" : "miss";
      } else if (c.side === "UNDER") {
        out[c.id] = under ? "hit" : "miss";
      }
    } else if (
      c.marketType === "OVER_UNDER" &&
      c.marketScope === "FIRST_HALF" &&
      c.line &&
      htTotal != null
    ) {
      const line = Number(c.line);
      if (!Number.isFinite(line)) continue;
      if (htTotal === line) {
        out[c.id] = null;
      } else if (c.side === "OVER") {
        out[c.id] = htTotal > line ? "hit" : "miss";
      } else if (c.side === "UNDER") {
        out[c.id] = htTotal < line ? "hit" : "miss";
      }
    } else if (c.marketType === "BOTH_TEAMS_TO_SCORE" && c.marketScope === "FULL_TIME") {
      const wantYes = c.side.endsWith("YES");
      out[c.id] = wantYes === btts ? "hit" : "miss";
    } else if (c.marketType === "DOUBLE_CHANCE" && c.marketScope === "FULL_TIME") {
      const ok =
        (c.side === "DC:1X" && (result === "H" || result === "D")) ||
        (c.side === "DC:12" && (result === "H" || result === "A")) ||
        (c.side === "DC:X2" && (result === "D" || result === "A"));
      out[c.id] = ok ? "hit" : "miss";
    } else if (c.marketType === "CORRECT_SCORE" && c.marketScope === "FULL_TIME") {
      const actual = `${homeScore}:${awayScore}`;
      const want = c.side.replace(/^score:/, "");
      out[c.id] = want === actual ? "hit" : "miss";
    } else if (
      c.marketType === "HALF_FULL_TIME" &&
      c.marketScope === "FULL_TIME" &&
      htResult &&
      c.side.startsWith("htft:")
    ) {
      const want = c.side.slice(5);
      const htSym = htResult === "H" ? "1" : htResult === "D" ? "X" : "2";
      const ftSym = result === "H" ? "1" : result === "D" ? "X" : "2";
      out[c.id] = want === `${htSym}/${ftSym}` ? "hit" : "miss";
    }
  }
  return out;
}

export function fixtureToTableRow(
  f: FixtureRow,
  bookmakerId: number = PREFERRED_BM,
): TableRow {
  const parts = kickoffParts(f.kickoff_at);
  const { lig, altLig } = splitLeague(f.league);
  const { h, a } = parseScore(f.home_score, f.away_score);
  const { h: htH, a: htA } = parseScore(f.home_ht_score, f.away_ht_score);
  const odds = oddsByColumn(f.odds, {
    bookmakerId,
    homeId: f.home_id,
    awayId: f.away_id,
  });
  const settled = isMatchSettled(f.kickoff_at, h, a);
  // Show score only if settled or non-zero (live); hide prematch 0-0
  const skorOut =
    h != null && a != null && (settled || h > 0 || a > 0) ? `${h}-${a}` : "";
  const skor1yOut =
    htH != null && htA != null && (settled || htH > 0 || htA > 0) ? `${htH}-${htA}` : "";
  return {
    id: f.match_id,
    source: "fixture",
    meta: {
      ...parts,
      kaynak: "fixture",
      lig,
      altLig,
      ev: f.home_name || "",
      dep: f.away_name || "",
      skor1y: skor1yOut,
      skor: skorOut,
    },
    odds,
    outcome: outcomeForColumns(h, a, ALL_COLUMNS, f.kickoff_at, htH, htA),
    homeScore: h,
    awayScore: a,
  };
}

/** Fixture sort: upcoming/live first, finished last; then kickoff ascending. */
export function compareFixturesForTable(a: FixtureRow, b: FixtureRow): number {
  const pa = parseScore(a.home_score, a.away_score);
  const pb = parseScore(b.home_score, b.away_score);
  const aDone = isMatchSettled(a.kickoff_at, pa.h, pa.a) ? 1 : 0;
  const bDone = isMatchSettled(b.kickoff_at, pb.h, pb.a) ? 1 : 0;
  if (aDone !== bDone) return aDone - bDone;
  const ka = a.kickoff_at ? new Date(a.kickoff_at).getTime() : 0;
  const kb = b.kickoff_at ? new Date(b.kickoff_at).getTime() : 0;
  const ta = Number.isFinite(ka) ? ka : 0;
  const tb = Number.isFinite(kb) ? kb : 0;
  if (ta !== tb) return ta - tb;
  return String(a.home_name || "").localeCompare(String(b.home_name || ""));
}

/** True when compact odds array has at least one row. */
export function fixtureHasOdds(f: FixtureRow): boolean {
  return Array.isArray(f.odds) && f.odds.length > 0;
}

export function fixturesToTableRows(
  fixtures: FixtureRow[],
  bookmakerId: number = PREFERRED_BM,
  opts?: { includeWithoutOdds?: boolean },
): TableRow[] {
  const list = opts?.includeWithoutOdds
    ? fixtures
    : fixtures.filter(fixtureHasOdds);
  const ordered = [...list].sort(compareFixturesForTable);
  return ordered.map((f) => fixtureToTableRow(f, bookmakerId));
}

function bookmakerIdsFromCompact(odds: CompactOddsRow[] | null | undefined): number[] {
  const set = new Set<number>();
  for (const row of odds || []) {
    if (!Array.isArray(row) || row.length < 1) continue;
    const n = Number(row[0]);
    if (Number.isFinite(n) && n > 0) set.add(n);
  }
  return [...set];
}

function bookmakerIdsFromEvent(event: OddsEvent): number[] {
  return bookmakerIdsFromCompact(marketsBlobToCompactOdds(asMarketsBlob(event.markets_json)));
}

/** Prefer preferredBm; otherwise first BM whose row satisfies all criteria. */
export function pickTableRowForCriteria(
  build: (bm: number) => TableRow,
  candidateBms: number[],
  criteria: OddsCriterion[],
  tolerance: number,
  preferredBm: number,
): TableRow | null {
  if (!criteria.length) return build(preferredBm);
  const ordered = [
    preferredBm,
    ...candidateBms.filter((b) => b !== preferredBm),
  ];
  const seen = new Set<number>();
  for (const bm of ordered) {
    if (!Number.isFinite(bm) || bm <= 0 || seen.has(bm)) continue;
    seen.add(bm);
    const row = build(bm);
    if (tableRowMatchesCriteria(row, criteria, tolerance)) return row;
  }
  return null;
}

/**
 * Fixture rows for the table. When anyBookmaker + criteria, each row uses a BM
 * that actually matches the clicked prices (AH 1.50 doesn't vanish).
 */
export function fixturesToTableRowsForFilter(
  fixtures: FixtureRow[],
  bookmakerId: number,
  criteria: OddsCriterion[],
  tolerance: number,
  anyBookmaker: boolean,
): TableRow[] {
  if (!criteria.length) {
    return fixturesToTableRows(fixtures, bookmakerId);
  }
  if (!anyBookmaker) {
    return fixturesToTableRows(fixtures, bookmakerId).filter((r) =>
      tableRowMatchesCriteria(r, criteria, tolerance),
    );
  }
  const withOdds = fixtures.filter(fixtureHasOdds);
  const ordered = [...withOdds].sort(compareFixturesForTable);
  const out: TableRow[] = [];
  for (const f of ordered) {
    const row = pickTableRowForCriteria(
      (bm) => fixtureToTableRow(f, bm),
      bookmakerIdsFromCompact(f.odds),
      criteria,
      tolerance,
      bookmakerId,
    );
    if (row) out.push(row);
  }
  return out;
}

function asMarketsBlob(raw: OddsEvent["markets_json"]): MarketsBlob {
  if (!raw) return { markets: [] };
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as MarketsBlob;
    } catch {
      return { markets: [] };
    }
  }
  return raw;
}

/** Flatten events.markets_json into compact odds rows for column mapping. */
export function marketsBlobToCompactOdds(blob: MarketsBlob | null | undefined): CompactOddsRow[] {
  const out: CompactOddsRow[] = [];
  for (const m of blob?.markets ?? []) {
    const mtype = m.type || "UNKNOWN";
    const scope = m.scope || "FULL_TIME";
    const mLine = m.line != null && m.line !== "" ? String(m.line) : null;
    for (const s of m.selections ?? []) {
      let side = String(s.key || "?");
      if (
        (mtype === "OVER_UNDER" || mtype === "ASIAN_HANDICAP" || mtype === "EUROPEAN_HANDICAP") &&
        mLine &&
        !side.includes(":")
      ) {
        side = `${side}:${mLine}`;
      }
      const nested = s.bookmakers;
      if (nested && typeof nested === "object" && Object.keys(nested).length > 0) {
        for (const [bid, q] of Object.entries(nested)) {
          const bm = Number(bid);
          if (!Number.isFinite(bm) || bm <= 0) continue;
          const opening = q?.opening ?? null;
          const current = q?.current ?? null;
          if (opening == null && current == null) continue;
          out.push([
            bm,
            mtype,
            scope,
            side,
            opening,
            current,
            q?.active !== false,
          ]);
        }
        continue;
      }
      out.push([
        Number(s.bookmaker_id) || 0,
        mtype,
        scope,
        side,
        s.opening ?? null,
        s.odds ?? null,
        !s.suspended,
      ]);
    }
  }
  return out;
}

export function eventToTableRow(
  event: OddsEvent,
  bookmakerId: number = PREFERRED_BM,
): TableRow {
  const parts = kickoffParts(event.kickoff_at);
  const { lig, altLig } = splitLeague(event.competition);
  const { h, a } = parseScore(event.home_score, event.away_score);
  const { h: htH, a: htA } = parseScore(event.home_ht_score, event.away_ht_score);
  const blob = asMarketsBlob(event.markets_json);
  const odds = oddsByColumn(marketsBlobToCompactOdds(blob), {
    bookmakerId,
    homeId: event.home_team_id,
    awayId: event.away_team_id,
  });
  const settled = isMatchSettled(event.kickoff_at, h, a);
  const skorOut =
    h != null && a != null && (settled || h > 0 || a > 0) ? `${h}-${a}` : "";
  const skor1yOut =
    htH != null && htA != null && (settled || htH > 0 || htA > 0) ? `${htH}-${htA}` : "";
  return {
    id: event.id || event.source_event_id,
    source: "archive",
    meta: {
      ...parts,
      kaynak: "archive",
      lig: lig || event.season_slug || "",
      altLig,
      ev: event.home_team || "",
      dep: event.away_team || "",
      skor1y: skor1yOut,
      skor: skorOut,
    },
    odds,
    outcome: outcomeForColumns(h, a, ALL_COLUMNS, event.kickoff_at, htH, htA),
    homeScore: h,
    awayScore: a,
  };
}

export function eventsToTableRows(
  events: OddsEvent[],
  bookmakerId: number = PREFERRED_BM,
): TableRow[] {
  return events.map((e) => eventToTableRow(e, bookmakerId));
}

/** Archive rows: with Any BM, render the bookmaker that matched the filter. */
export function eventsToTableRowsForFilter(
  events: OddsEvent[],
  bookmakerId: number,
  criteria: OddsCriterion[],
  tolerance: number,
  anyBookmaker: boolean,
): TableRow[] {
  if (!criteria.length || !anyBookmaker) {
    return eventsToTableRows(events, bookmakerId);
  }
  const out: TableRow[] = [];
  for (const e of events) {
    const row = pickTableRowForCriteria(
      (bm) => eventToTableRow(e, bm),
      bookmakerIdsFromEvent(e),
      criteria,
      tolerance,
      bookmakerId,
    );
    if (row) out.push(row);
  }
  return out;
}

/**
 * Sparse row from profile hits only (matched criteria). Prefer eventsToTableRows /
 * searchProfile.tableRows so the grid shows every market side in markets_json.
 */
export function profileMatchToTableRow(m: ProfileMatch): TableRow {
  const parts = kickoffParts(m.kickoffAt);
  const { lig, altLig } = splitLeague(m.competition);
  let h: number | null = null;
  let a: number | null = null;
  if (m.score && /^\d+-\d+$/.test(m.score)) {
    const [hs, as] = m.score.split("-").map(Number);
    h = hs;
    a = as;
  }
  let htH: number | null = null;
  let htA: number | null = null;
  if (m.htScore && /^\d+-\d+$/.test(m.htScore)) {
    const [hs, as] = m.htScore.split("-").map(Number);
    htH = hs;
    htA = as;
  }
  const odds: Record<string, CellOdds | null> = {};
  for (const c of ALL_COLUMNS) {
    if (c.kind === "market") odds[c.id] = null;
  }
  for (const hit of m.hits) {
    const col = ALL_COLUMNS.find(
      (c): c is MarketColumnDef =>
        c.kind === "market" &&
        (c.side === hit.side ||
          criterionMatchesColumn(
            {
              marketType: hit.marketType,
              marketScope: hit.marketScope,
              side: hit.side,
              line: hit.line,
              targetOdds: hit.targetOdds,
            },
            c,
          )),
    );
    if (col) {
      const closing = hit.closing ?? hit.targetOdds;
      const opening = hit.opening;
      odds[col.id] = {
        opening: opening != null && Number.isFinite(opening) ? opening : null,
        closing: closing != null && Number.isFinite(closing) ? closing : null,
      };
    }
  }
  return {
    id: m.eventId || m.sourceEventId,
    source: "archive",
    meta: {
      ...parts,
      kaynak: "archive",
      lig: lig || (m.seasonSlug || ""),
      altLig,
      ev: m.homeTeam || "",
      dep: m.awayTeam || "",
      skor1y: m.htScore || "",
      skor: m.score || "",
    },
    odds,
    outcome: outcomeForColumns(h, a, ALL_COLUMNS, m.kickoffAt, htH, htA),
    homeScore: h,
    awayScore: a,
  };
}

export function profileMatchesToTableRows(matches: ProfileMatch[]): TableRow[] {
  return matches.map(profileMatchToTableRow);
}

function cellOddsMatchTarget(
  cell: CellOdds | null | undefined,
  target: number,
  tolerance: number,
  price?: "opening" | "closing",
): boolean {
  if (!cell) return false;
  const vals: number[] = [];
  if (price === "opening") {
    if (cell.opening != null && Number.isFinite(cell.opening) && cell.opening >= 1.01) {
      vals.push(cell.opening);
    }
  } else if (price === "closing") {
    if (cell.closing != null && Number.isFinite(cell.closing) && cell.closing >= 1.01) {
      vals.push(cell.closing);
    }
  } else {
    if (cell.closing != null && Number.isFinite(cell.closing) && cell.closing >= 1.01) {
      vals.push(cell.closing);
    }
    if (cell.opening != null && Number.isFinite(cell.opening) && cell.opening >= 1.01) {
      vals.push(cell.opening);
    }
  }
  if (!vals.length) return false;
  if (tolerance <= 0) {
    const t = Math.round(target * 100);
    return vals.some((v) => Math.round(v * 100) === t);
  }
  return vals.some((v) => Math.abs(v - target) <= tolerance);
}

/** Hücre aktif filtreye (kolon + O/C + oran) uyuyor mu. */
export function cellMatchesCriterion(
  col: MarketColumnDef,
  cell: CellOdds | null | undefined,
  c: OddsCriterion,
  tolerance: number,
  priceLabel: "open" | "close",
): boolean {
  if (!criterionMatchesColumn(c, col)) return false;
  const price = priceLabel === "open" ? "opening" : "closing";
  if (c.price === "opening" && priceLabel !== "open") return false;
  if (c.price === "closing" && priceLabel !== "close") return false;
  return cellOddsMatchTarget(cell, c.targetOdds, tolerance, c.price ?? price);
}

export function rowHasVisibleOdds(row: TableRow): boolean {
  return Object.values(row.odds).some((c) => cellOddsValue(c) != null);
}

/** Relative slot → seçili maçın O/C oranı ile somut kriter. */
export function resolveCriteriaFromFixture(
  criteria: OddsCriterion[],
  fixture: FixtureRow | null,
  bookmakerId: number = PREFERRED_BM,
): OddsCriterion[] {
  const out: OddsCriterion[] = [];
  for (const c of criteria) {
    if (!c.relative) {
      if (c.targetOdds > 1) out.push(c);
      continue;
    }
    if (!fixture) continue;
    const row = fixtureToTableRow(fixture, bookmakerId);
    const col = c.columnId
      ? ALL_COLUMNS.find((x): x is MarketColumnDef => x.kind === "market" && x.id === c.columnId)
      : ALL_COLUMNS.find(
          (x): x is MarketColumnDef => x.kind === "market" && criterionMatchesColumn(c, x),
        );
    if (!col) continue;
    const cell = row.odds[col.id];
    let val: number | null = null;
    if (c.price === "opening") val = cell?.opening ?? null;
    else if (c.price === "closing") val = cell?.closing ?? cellOddsValue(cell);
    else val = cellOddsValue(cell);
    if (val == null || val < 1.01) continue;
    const { relative: _r, ...rest } = c;
    out.push({ ...rest, targetOdds: val });
  }
  return out;
}

/** Satır aktif oran kriterlerine uyuyor mu (tıklanan kolon + O/C). */
export function tableRowMatchesCriteria(
  row: TableRow,
  criteria: OddsCriterion[],
  tolerance: number,
): boolean {
  if (!criteria.length) return true;
  for (const c of criteria) {
    const col = c.columnId
      ? ALL_COLUMNS.find((x): x is MarketColumnDef => x.kind === "market" && x.id === c.columnId)
      : ALL_COLUMNS.find(
          (x): x is MarketColumnDef => x.kind === "market" && criterionMatchesColumn(c, x),
        );
    if (!col) return false;
    if (!cellOddsMatchTarget(row.odds[col.id], c.targetOdds, tolerance, c.price)) {
      return false;
    }
  }
  return true;
}

/**
 * fixture rows on top, archive (events) below.
 * Always include both; optional criteria filter applies to each.
 */
export function mergeFixtureAndArchiveRows(
  bulletin: TableRow[],
  archive: TableRow[],
  opts?: { criteria?: OddsCriterion[]; tolerance?: number },
): TableRow[] {
  const criteria = opts?.criteria ?? [];
  const tol = opts?.tolerance ?? 0;
  const seen = new Set<string>();
  const out: TableRow[] = [];

  const push = (r: TableRow) => {
    const soft = `${r.meta.ev}|${r.meta.dep}|${r.meta.tarih}|${r.meta.saat}`;
    const key = r.id || soft;
    if (seen.has(key) || seen.has(soft)) return;
    seen.add(key);
    seen.add(soft);
    out.push(r);
  };

  const match = (r: TableRow) =>
    !criteria.length || tableRowMatchesCriteria(r, criteria, tol);

  for (const r of bulletin) {
    if (match(r)) push(r);
  }
  for (const r of archive) {
    if (match(r)) push(r);
  }
  return out;
}

export function filterTableRows(
  rows: TableRow[],
  filters: Record<string, string>,
  columns: TableColumnDef[],
): TableRow[] {
  const active = Object.entries(filters).filter(([, v]) => v.trim() !== "");
  if (!active.length) return rows;
  return rows.filter((row) => {
    for (const [colId, raw] of active) {
      const q = raw.trim().toLowerCase();
      let cell = "";

      // Market open/close filter keys: ms_1__o / ms_1__c
      const oc = /^(.*)__(o|c)$/.exec(colId);
      if (oc) {
        const base = oc[1];
        const which = oc[2] === "o" ? "opening" : "closing";
        const pair = row.odds[base];
        const n = pair?.[which] ?? null;
        cell = n != null ? String(n) : "";
        // "2.30" yazınca JS 2.3 → "2.3" kaçmasın
        const qNum = Number(q.replace(",", "."));
        if (n != null && Number.isFinite(qNum) && qNum >= 1.01) {
          if (Math.round(n * 100) !== Math.round(qNum * 100)) return false;
          continue;
        }
      } else {
        const col = columns.find((c) => c.id === colId);
        if (!col) continue;
        if (col.kind === "meta") {
          cell = row.meta[col.id] || "";
        } else {
          const o = cellOddsValue(row.odds[col.id]);
          cell = o != null ? String(o) : "";
          const qNum = Number(q.replace(",", "."));
          if (o != null && Number.isFinite(qNum) && qNum >= 1.01) {
            if (Math.round(o * 100) !== Math.round(qNum * 100)) return false;
            continue;
          }
        }
      }
      if (!cell.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------------------ */
/* match_odds (flat Postgres tablosu) satırlarından TableRow kurma          */
/* ------------------------------------------------------------------------ */

/**
 * match_odds satırlarını (event meta + quote alanları aynı satırda) oddsByColumn'un
 * beklediği CompactOddsRow tuple'larına çevirir. events.markets_json'a hiç
 * dokunmadan tam bookmaker grid'i kurmayı sağlar.
 */
export function marketQuoteRowsToCompactOdds(rows: MatchOddsWithMetaRow[]): CompactOddsRow[] {
  const out: CompactOddsRow[] = [];
  for (const row of rows) {
    if (!row.bookmaker) continue;
    const bm = bookmakerNameToPseudoId(String(row.bookmaker));
    const { marketType: mtype, marketScope: scope } = splitMarket(row.market);
    let side = row.selection;
    if (!side) continue;
    // match_odds şemasında line ayrı kolon (selection çıplak "OVER"/"H" gelir).
    // compactMatchesCol/parseSideToken ise "OVER:2.5" gibi gömülü line formatı
    // bekliyor — yoksa O/U ve AH kolonları line eşleşmesinde hep false dönüp
    // boş kalıyordu. Zaten gömülüyse (":" içeriyorsa) dokunma.
    if (row.line != null && String(row.line) !== "" && !side.includes(":")) {
      side = `${side}:${row.line}`;
    }
    const opening = row.opening == null ? null : Number(row.opening);
    const current = row.odds == null ? null : Number(row.odds);
    if (opening == null && current == null) continue;
    const active = row.active !== false && row.active !== "false" && row.active !== "False";
    out.push([bm, mtype, scope, side, opening, current, active]);
  }
  return out;
}

/** match_odds satırının meta alanlarından (markets_json'suz) bir TableRow kurar. */
export function eventMetaToTableRow(
  meta: MatchOddsWithMetaRow,
  quoteRows: MatchOddsWithMetaRow[],
  bookmakerId: number | string = PREFERRED_BM_NAME,
): TableRow {
  const bmNum = typeof bookmakerId === "string" ? bookmakerNameToPseudoId(bookmakerId) : bookmakerId;
  const parts = kickoffParts(meta.kickoff_at);
  const { lig, altLig } = splitLeague(meta.competition);
  const { h, a } = parseScore(meta.home_score, meta.away_score);
  const { h: htH, a: htA } = parseScore(meta.home_ht_score, meta.away_ht_score);
  const odds = oddsByColumn(marketQuoteRowsToCompactOdds(quoteRows), { bookmakerId: bmNum });
  const settled = isMatchSettled(meta.kickoff_at, h, a);
  const skorOut = h != null && a != null && (settled || h > 0 || a > 0) ? `${h}-${a}` : "";
  const skor1yOut =
    htH != null && htA != null && (settled || htH > 0 || htA > 0) ? `${htH}-${htA}` : "";
  return {
    id: String(meta.event_id ?? meta.source_event_id ?? ""),
    source: "archive",
    meta: {
      ...parts,
      kaynak: "archive",
      lig: lig || meta.season_slug || "",
      altLig,
      ev: meta.home_team || "",
      dep: meta.away_team || "",
      skor1y: skor1yOut,
      skor: skorOut,
    },
    odds,
    outcome: outcomeForColumns(h, a, ALL_COLUMNS, meta.kickoff_at, htH, htA),
    homeScore: h,
    awayScore: a,
  };
}

/**
 * match_odds'tan gelen düz satırları event_id'ye göre grupla, her event için
 * bir TableRow (tam bookmaker grid'i) üret. searchProfile'ın eşleşen
 * event_id'ler için events.markets_json'a dönüp full grid çekmesine gerek
 * bırakmaz — match_odds zaten aynı veriyi flat taşıyor.
 */
export function eventsMetaAndQuotesToTableRows(
  rows: MatchOddsWithMetaRow[],
  bookmakerId: number | string = PREFERRED_BM_NAME,
): Map<string, TableRow> {
  const byEvent = new Map<string, MatchOddsWithMetaRow[]>();
  for (const row of rows) {
    const id = String(row.event_id ?? "");
    if (!id) continue;
    const arr = byEvent.get(id);
    if (arr) arr.push(row);
    else byEvent.set(id, [row]);
  }
  const out = new Map<string, TableRow>();
  for (const [id, quoteRows] of byEvent) {
    out.set(id, eventMetaToTableRow(quoteRows[0], quoteRows, bookmakerId));
  }
  return out;
}
