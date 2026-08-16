/** Analyze market table column definitions (no chips). */

import type { OddsCriterion } from "@/lib/analysis/profile";

export type ColumnGroupId =
  | "meta"
  | "ht1x2"
  | "ms1x2"
  | "sh1x2"
  | "htft"
  | "dc"
  | "btts"
  | "ou_ht"
  | "ou_ms"
  | "ou_2h"
  | "ah"
  | "cs"
  | "dnb"
  | "eh";

export type MetaField =
  | "kaynak"
  | "tarih"
  | "yil"
  | "ay"
  | "gun"
  | "gunAdi"
  | "saat"
  | "lig"
  | "altLig"
  | "ev"
  | "dep"
  | "skor1y"
  | "skor";

export type MarketColumnDef = {
  kind: "market";
  id: string;
  header: string;
  group: ColumnGroupId;
  /** Default visible */
  defaultOn: boolean;
  marketType: string;
  marketScope: string;
  /** Compact / archive side token (H, D, A, OVER, UNDER, DC:1X, htft:1/1, H with line…) */
  side: string;
  line?: string | null;
};

export type MetaColumnDef = {
  kind: "meta";
  id: MetaField;
  header: string;
  group: "meta";
  defaultOn: boolean;
};

export type TableColumnDef = MetaColumnDef | MarketColumnDef;

export const COLUMN_GROUPS: { id: ColumnGroupId; label: string }[] = [
  { id: "meta", label: "League / teams" },
  { id: "ht1x2", label: "HT 1X2" },
  { id: "ms1x2", label: "FT 1X2" },
  { id: "sh1x2", label: "2H 1X2" },
  { id: "htft", label: "HT/FT" },
  { id: "dc", label: "Double Chance" },
  { id: "btts", label: "BTTS" },
  { id: "ou_ht", label: "O/U HT" },
  { id: "ou_ms", label: "O/U FT" },
  { id: "ou_2h", label: "O/U 2H" },
  { id: "ah", label: "Asian Handicap" },
  { id: "cs", label: "Correct Score" },
  { id: "dnb", label: "Draw No Bet" },
  { id: "eh", label: "European Handicap" },
];

const META: MetaColumnDef[] = [
  { kind: "meta", id: "kaynak", header: "SRC", group: "meta", defaultOn: true },
  { kind: "meta", id: "tarih", header: "DATE", group: "meta", defaultOn: true },
  { kind: "meta", id: "yil", header: "YEAR", group: "meta", defaultOn: false },
  { kind: "meta", id: "ay", header: "MONTH", group: "meta", defaultOn: false },
  { kind: "meta", id: "gun", header: "DAY", group: "meta", defaultOn: false },
  { kind: "meta", id: "gunAdi", header: "WEEKDAY", group: "meta", defaultOn: false },
  { kind: "meta", id: "saat", header: "TIME", group: "meta", defaultOn: true },
  { kind: "meta", id: "lig", header: "LEAGUE", group: "meta", defaultOn: true },
  { kind: "meta", id: "altLig", header: "DIVISION", group: "meta", defaultOn: false },
  { kind: "meta", id: "ev", header: "HOME", group: "meta", defaultOn: true },
  { kind: "meta", id: "dep", header: "AWAY", group: "meta", defaultOn: true },
  { kind: "meta", id: "skor1y", header: "HT", group: "meta", defaultOn: true },
  { kind: "meta", id: "skor", header: "FT", group: "meta", defaultOn: true },
];

function m(
  id: string,
  header: string,
  group: ColumnGroupId,
  marketType: string,
  marketScope: string,
  side: string,
  line?: string | null,
  defaultOn = true,
): MarketColumnDef {
  return {
    kind: "market",
    id,
    header,
    group,
    defaultOn,
    marketType,
    marketScope,
    side,
    line: line ?? null,
  };
}

const HT_1X2: MarketColumnDef[] = [
  m("ht_1", "HT1", "ht1x2", "HOME_DRAW_AWAY", "FIRST_HALF", "H"),
  m("ht_x", "HTX", "ht1x2", "HOME_DRAW_AWAY", "FIRST_HALF", "D"),
  m("ht_2", "HT2", "ht1x2", "HOME_DRAW_AWAY", "FIRST_HALF", "A"),
];

const MS_1X2: MarketColumnDef[] = [
  m("ms_1", "1", "ms1x2", "HOME_DRAW_AWAY", "FULL_TIME", "H"),
  m("ms_x", "X", "ms1x2", "HOME_DRAW_AWAY", "FULL_TIME", "D"),
  m("ms_2", "2", "ms1x2", "HOME_DRAW_AWAY", "FULL_TIME", "A"),
];

const SH_1X2: MarketColumnDef[] = [
  m("sh_1", "2H1", "sh1x2", "HOME_DRAW_AWAY", "SECOND_HALF", "H"),
  m("sh_x", "2HX", "sh1x2", "HOME_DRAW_AWAY", "SECOND_HALF", "D"),
  m("sh_2", "2H2", "sh1x2", "HOME_DRAW_AWAY", "SECOND_HALF", "A"),
];

const HTFT_COMBOS = ["1/1", "1/X", "1/2", "X/1", "X/X", "X/2", "2/1", "2/X", "2/2"] as const;
const HTFT: MarketColumnDef[] = HTFT_COMBOS.map((c) =>
  m(`htft_${c.replace("/", "")}`, c, "htft", "HALF_FULL_TIME", "FULL_TIME", `htft:${c}`),
);

const DC: MarketColumnDef[] = [
  m("dc_1x", "1X", "dc", "DOUBLE_CHANCE", "FULL_TIME", "DC:1X"),
  m("dc_12", "12", "dc", "DOUBLE_CHANCE", "FULL_TIME", "DC:12"),
  m("dc_x2", "X2", "dc", "DOUBLE_CHANCE", "FULL_TIME", "DC:X2"),
  m("dc_1x_ht", "HT 1X", "dc", "DOUBLE_CHANCE", "FIRST_HALF", "DC:1X"),
  m("dc_12_ht", "HT 12", "dc", "DOUBLE_CHANCE", "FIRST_HALF", "DC:12"),
  m("dc_x2_ht", "HT X2", "dc", "DOUBLE_CHANCE", "FIRST_HALF", "DC:X2"),
  m("dc_1x_2h", "2H 1X", "dc", "DOUBLE_CHANCE", "SECOND_HALF", "DC:1X"),
  m("dc_12_2h", "2H 12", "dc", "DOUBLE_CHANCE", "SECOND_HALF", "DC:12"),
  m("dc_x2_2h", "2H X2", "dc", "DOUBLE_CHANCE", "SECOND_HALF", "DC:X2"),
];

const BTTS: MarketColumnDef[] = [
  m("btts_y", "BTTS Y", "btts", "BOTH_TEAMS_TO_SCORE", "FULL_TIME", "btts:YES"),
  m("btts_n", "BTTS N", "btts", "BOTH_TEAMS_TO_SCORE", "FULL_TIME", "btts:NO"),
  m("btts_y_ht", "HT BTTS Y", "btts", "BOTH_TEAMS_TO_SCORE", "FIRST_HALF", "btts:YES"),
  m("btts_n_ht", "HT BTTS N", "btts", "BOTH_TEAMS_TO_SCORE", "FIRST_HALF", "btts:NO"),
  m("btts_y_2h", "2H BTTS Y", "btts", "BOTH_TEAMS_TO_SCORE", "SECOND_HALF", "btts:YES"),
  m("btts_n_2h", "2H BTTS N", "btts", "BOTH_TEAMS_TO_SCORE", "SECOND_HALF", "btts:NO"),
];

function ouCols(
  group: ColumnGroupId,
  scope: string,
  lines: number[],
  prefix: string,
): MarketColumnDef[] {
  const out: MarketColumnDef[] = [];
  for (const line of lines) {
    const ls = String(line);
    out.push(
      m(
        `${group}_u${ls.replace(".", "_")}`,
        `${prefix}O${ls}`,
        group,
        "OVER_UNDER",
        scope,
        "OVER",
        ls,
      ),
      m(
        `${group}_a${ls.replace(".", "_")}`,
        `${prefix}U${ls}`,
        group,
        "OVER_UNDER",
        scope,
        "UNDER",
        ls,
      ),
    );
  }
  return out;
}

const OU_HT = ouCols("ou_ht", "FIRST_HALF", [0.5, 1.5, 2.5, 3.5, 4.5], "HT ");
const OU_MS = ouCols("ou_ms", "FULL_TIME", [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5], "");
const OU_2H = ouCols("ou_2h", "SECOND_HALF", [0.5, 1.5, 2.5, 3.5, 4.5], "2H ");

/** AH lines (compact side H:<line> / A:<line>). */
export const AH_LINES = [-1.5, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.5];

function ahCols(
  idPrefix: string,
  headerPrefix: string,
  scope: string,
  lines: number[],
): MarketColumnDef[] {
  const out: MarketColumnDef[] = [];
  for (const line of lines) {
    const ls = String(line);
    const lsId = ls.replace(".", "_").replace("-", "m");
    const sign = line > 0 ? `+${ls}` : ls;
    out.push(
      m(`${idPrefix}_h_${lsId}`, `${headerPrefix}AH ${sign}`, "ah", "ASIAN_HANDICAP", scope, "H", ls),
      m(`${idPrefix}_a_${lsId}`, `${headerPrefix}AH ${sign} A`, "ah", "ASIAN_HANDICAP", scope, "A", ls),
    );
  }
  return out;
}

const AH = [
  ...ahCols("ah", "", "FULL_TIME", AH_LINES),
  ...ahCols("ah_ht", "HT ", "FIRST_HALF", AH_LINES),
  ...ahCols("ah_2h", "2H ", "SECOND_HALF", AH_LINES),
];

/** Common CS — off by default. */
export const CS_SCORES = ["1:0", "2:0", "2:1", "0:0", "1:1", "0:1", "0:2", "1:2", "2:2", "3:1", "3:2"];
const CS: MarketColumnDef[] = [
  ...CS_SCORES.map((s) =>
    m(`cs_${s.replace(":", "_")}`, s, "cs", "CORRECT_SCORE", "FULL_TIME", `score:${s}`, null, false),
  ),
  ...CS_SCORES.map((s) =>
    m(`cs_ht_${s.replace(":", "_")}`, `HT ${s}`, "cs", "CORRECT_SCORE", "FIRST_HALF", `score:${s}`, null, false),
  ),
  ...CS_SCORES.map((s) =>
    m(`cs_2h_${s.replace(":", "_")}`, `2H ${s}`, "cs", "CORRECT_SCORE", "SECOND_HALF", `score:${s}`, null, false),
  ),
];

/** Draw No Bet — confirmed archive format: plain "H"/"A" side, no line, FULL_TIME only. */
const DNB: MarketColumnDef[] = [
  m("dnb_h", "DNB 1", "dnb", "DRAW_NO_BET", "FULL_TIME", "H"),
  m("dnb_a", "DNB 2", "dnb", "DRAW_NO_BET", "FULL_TIME", "A"),
];

/**
 * European Handicap — confirmed archive format: three-way side token "H:<line>" /
 * "D:<line>" / "A:<line>" (same shape as Asian Handicap's H:/A: tokens, plus D:).
 * IMPORTANT: unlike AH, the away selection's embedded line is the NEGATION of the
 * home/draw line — e.g. the "home -1" market posts H:-1.0, D:-1.0, but A:1.0 (confirmed
 * against archive data: matching row counts pair H:-1.0/D:-1.0/A:1.0, and separately
 * H:1.0/D:1.0/A:-1.0). `line` below is always the home-perspective handicap value.
 * Only FULL_TIME scope confirmed so far.
 */
export const EH_LINES = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];

function ehCols(idPrefix: string, headerPrefix: string, scope: string, lines: number[]): MarketColumnDef[] {
  const out: MarketColumnDef[] = [];
  for (const line of lines) {
    const ls = String(line);
    const lsId = ls.replace(".", "_").replace("-", "m");
    const sign = line > 0 ? `+${ls}` : ls;
    out.push(
      m(`${idPrefix}_h_${lsId}`, `${headerPrefix}EH ${sign} 1`, "eh", "EUROPEAN_HANDICAP", scope, "H", ls, false),
      m(`${idPrefix}_x_${lsId}`, `${headerPrefix}EH ${sign} X`, "eh", "EUROPEAN_HANDICAP", scope, "D", ls, false),
      m(`${idPrefix}_a_${lsId}`, `${headerPrefix}EH ${sign} 2`, "eh", "EUROPEAN_HANDICAP", scope, "A", String(-line), false),
    );
  }
  return out;
}

const EH = ehCols("eh", "", "FULL_TIME", EH_LINES);

/** Column order: meta → HT markets → FT markets. */
export const ALL_COLUMNS: TableColumnDef[] = [
  ...META,
  ...HT_1X2,
  ...MS_1X2,
  ...SH_1X2,
  ...HTFT,
  ...DC,
  ...BTTS,
  ...OU_HT,
  ...OU_MS,
  ...OU_2H,
  ...AH,
  ...CS,
  ...DNB,
  ...EH,
];

export function defaultVisibleGroupIds(): Set<ColumnGroupId> {
  return new Set(
    COLUMN_GROUPS.map((g) => g.id).filter((id) => id !== "cs" && id !== "eh") as ColumnGroupId[],
  );
}

/** Visible columns: meta if defaultOn; market if defaultOn (or cs/eh group on — those are opt-in, all-or-nothing). */
export function visibleColumns(groups: Set<ColumnGroupId>): TableColumnDef[] {
  return ALL_COLUMNS.filter((c) => {
    if (!groups.has(c.group)) return false;
    if (c.kind === "meta") return c.defaultOn;
    if (c.group === "cs" || c.group === "eh") return true;
    return c.defaultOn;
  });
}

/** All meta column defs (for optional date-part toggles). */
export function allMetaColumns(): MetaColumnDef[] {
  return ALL_COLUMNS.filter((c): c is MetaColumnDef => c.kind === "meta");
}

export function columnToCriterion(
  col: MarketColumnDef,
  targetOdds: number,
  price?: "opening" | "closing",
): OddsCriterion {
  return {
    marketType: col.marketType,
    marketScope: col.marketScope,
    side: col.side,
    line: col.line ?? null,
    targetOdds,
    price,
    columnId: col.id,
  };
}

/** Tablo hücre rengi: taraf bazlı (1 yeşil, X sarı, 2 kırmızı, …). */
export type MarketTone =
  | "home"
  | "draw"
  | "away"
  | "over"
  | "under"
  | "bttsYes"
  | "bttsNo";

export function marketColumnTone(col: MarketColumnDef): MarketTone | null {
  if (col.marketType === "HOME_DRAW_AWAY" || col.marketType === "DRAW_NO_BET" || col.marketType === "EUROPEAN_HANDICAP") {
    if (col.side === "H" || col.side.startsWith("H:")) return "home";
    if (col.side === "D" || col.side.startsWith("D:")) return "draw";
    if (col.side === "A" || col.side.startsWith("A:")) return "away";
  }
  if (col.marketType === "OVER_UNDER") {
    if (col.side === "OVER" || col.side.startsWith("OVER")) return "over";
    if (col.side === "UNDER" || col.side.startsWith("UNDER")) return "under";
  }
  if (col.marketType === "BOTH_TEAMS_TO_SCORE") {
    if (/YES|True/i.test(col.side)) return "bttsYes";
    if (/NO|False/i.test(col.side)) return "bttsNo";
  }
  return null;
}

export function criterionMatchesColumn(c: OddsCriterion, col: MarketColumnDef): boolean {
  if (c.columnId) return c.columnId === col.id;
  if (c.marketType !== col.marketType) return false;
  if (c.marketScope !== col.marketScope) return false;
  // Line varsa zorunlu eşle (AH +0.5 ≠ AH -0.5)
  const wantLine = c.line != null && c.line !== "" ? String(c.line) : "";
  const colLine = col.line != null && col.line !== "" ? String(col.line) : "";
  if (wantLine) {
    if (!colLine) return false;
    if (Number(wantLine) !== Number(colLine) && wantLine !== colLine) return false;
  } else if (
    (c.marketType === "ASIAN_HANDICAP" ||
      c.marketType === "EUROPEAN_HANDICAP" ||
      c.marketType === "OVER_UNDER") &&
    colLine
  ) {
    // Kriter linesiz handicap/OU — belirsiz, kolon kabul etme
    return false;
  }
  const cs = c.side;
  const want = col.side;
  if (cs === want) return true;
  if (want === "OVER" || want === "UNDER") {
    return cs === want || cs.startsWith(want + ":");
  }
  if (want === "H" || want === "A" || want === "D") {
    return cs === want || cs.startsWith(want + ":");
  }
  if (want.startsWith("htft:")) return cs === want || cs === want.slice(5);
  if (want.startsWith("btts:")) {
    const yn = want.endsWith("YES");
    return (
      cs === want ||
      (yn && /btts:(YES|True)$/i.test(cs)) ||
      (!yn && /btts:(NO|False)$/i.test(cs))
    );
  }
  if (want.startsWith("score:")) return cs === want || cs === `score:${want.slice(6)}`;
  return false;
}
