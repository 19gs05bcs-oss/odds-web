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
  | "eh"
  | "oe"
  | "ou_x"
  | "ah_x"
  | "cs_ht"
  | "cs_2h";

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
  | "skor"
  | "skor2y"
  | "htRes"
  | "ftRes"
  | "shRes";

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
  // FT 1X2 comes first, then HT, then 2H.
  { id: "ms1x2", label: "FT 1X2" },
  { id: "ht1x2", label: "HT 1X2" },
  { id: "sh1x2", label: "2H 1X2" },
  { id: "htft", label: "HT/FT" },
  { id: "dc", label: "Double Chance" },
  { id: "btts", label: "BTTS" },
  { id: "oe", label: "Odd/Even" },
  { id: "ou_ht", label: "O/U HT" },
  { id: "ou_ms", label: "O/U FT" },
  { id: "ou_2h", label: "O/U 2H" },
  { id: "ou_x", label: "O/U extra lines (¼ & whole)" },
  { id: "ah", label: "Asian Handicap" },
  { id: "ah_x", label: "Asian Handicap extra lines (±1.25 … ±3)" },
  { id: "cs", label: "Correct Score FT" },
  { id: "cs_ht", label: "Correct Score HT" },
  { id: "cs_2h", label: "Correct Score 2H" },
  { id: "dnb", label: "Draw No Bet" },
  { id: "eh", label: "European Handicap" },
];

/**
 * Heavy groups: off by default; when ticked in "Edit columns" EVERY column of the
 * group is shown (there is no per-column switch for them).
 */
export const OPT_IN_GROUPS: ReadonlySet<ColumnGroupId> = new Set<ColumnGroupId>([
  "ou_x",
  "ah_x",
  "cs",
  "cs_ht",
  "cs_2h",
  "eh",
]);

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
  // 2nd-half score = FT − HT (only when both are known).
  { kind: "meta", id: "skor2y", header: "2H", group: "meta", defaultOn: true },
  { kind: "meta", id: "skor", header: "FT", group: "meta", defaultOn: true },
  // Home / Draw / Away result derived from the HT, FT and 2H scores (coloured in the table).
  { kind: "meta", id: "htRes", header: "HT RES", group: "meta", defaultOn: true },
  { kind: "meta", id: "ftRes", header: "FT RES", group: "meta", defaultOn: true },
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

/** Odd/Even total goals — archive side tokens are "sel:ODD" / "sel:EVEN" (all 3 scopes). */
const OE: MarketColumnDef[] = [
  m("oe_odd", "ODD", "oe", "ODD_OR_EVEN", "FULL_TIME", "sel:ODD"),
  m("oe_even", "EVEN", "oe", "ODD_OR_EVEN", "FULL_TIME", "sel:EVEN"),
  m("oe_odd_ht", "HT ODD", "oe", "ODD_OR_EVEN", "FIRST_HALF", "sel:ODD"),
  m("oe_even_ht", "HT EVEN", "oe", "ODD_OR_EVEN", "FIRST_HALF", "sel:EVEN"),
  m("oe_odd_2h", "2H ODD", "oe", "ODD_OR_EVEN", "SECOND_HALF", "sel:ODD"),
  m("oe_even_2h", "2H EVEN", "oe", "ODD_OR_EVEN", "SECOND_HALF", "sel:EVEN"),
];

/**
 * Line string as the archive writes it (Python str(float): "1.0", "-1.0", "2.5").
 * Used for the extra-line columns so click-to-filter queries hit the stored value.
 */
function pyLine(n: number): string {
  let t = n.toFixed(2).replace(/(\.\d*?)0+$/, "$1");
  if (t.endsWith(".")) t += "0";
  return t;
}

function ouCols(
  group: ColumnGroupId,
  scope: string,
  lines: number[],
  prefix: string,
  opts: { idPrefix?: string; defaultOn?: boolean; pyFormat?: boolean } = {},
): MarketColumnDef[] {
  const out: MarketColumnDef[] = [];
  const idPrefix = opts.idPrefix ?? group;
  const defaultOn = opts.defaultOn ?? true;
  for (const line of lines) {
    const ls = String(line);
    const lineValue = opts.pyFormat ? pyLine(line) : ls;
    const lsId = ls.replace(".", "_");
    out.push(
      m(`${idPrefix}_u${lsId}`, `${prefix}O${ls}`, group, "OVER_UNDER", scope, "OVER", lineValue, defaultOn),
      m(`${idPrefix}_a${lsId}`, `${prefix}U${ls}`, group, "OVER_UNDER", scope, "UNDER", lineValue, defaultOn),
    );
  }
  return out;
}

/** Every 0.25 step in (from, to] that is NOT already in `main`. */
function quarterStepsExcept(to: number, main: number[]): number[] {
  const have = new Set(main);
  const out: number[] = [];
  for (let i = 1; i * 0.25 <= to + 1e-9; i++) {
    const v = i * 0.25;
    if (!have.has(v)) out.push(v);
  }
  return out;
}

const OU_HT_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const OU_MS_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5];
const OU_2H_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const OU_HT = ouCols("ou_ht", "FIRST_HALF", OU_HT_LINES, "HT ");
const OU_MS = ouCols("ou_ms", "FULL_TIME", OU_MS_LINES, "");
const OU_2H = ouCols("ou_2h", "SECOND_HALF", OU_2H_LINES, "2H ");

/**
 * Remaining O/U lines of the archive (0.25 … 7.0 in 0.25 steps): quarter lines and
 * whole lines. Opt-in group — FT up to 7.0, HT / 2H up to 4.5.
 */
const OU_X = [
  ...ouCols("ou_x", "FULL_TIME", quarterStepsExcept(7, OU_MS_LINES), "", {
    idPrefix: "oux_ms",
    defaultOn: false,
    pyFormat: true,
  }),
  ...ouCols("ou_x", "FIRST_HALF", quarterStepsExcept(4.5, OU_HT_LINES), "HT ", {
    idPrefix: "oux_ht",
    defaultOn: false,
    pyFormat: true,
  }),
  ...ouCols("ou_x", "SECOND_HALF", quarterStepsExcept(4.5, OU_2H_LINES), "2H ", {
    idPrefix: "oux_2h",
    defaultOn: false,
    pyFormat: true,
  }),
];

/** AH lines (compact side H:<line> / A:<line>). Kept as-is: smartMatchReportSQL imports it. */
export const AH_LINES = [-1.5, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.5];

/** Rest of the archive's AH range (-3 … +3 in 0.25 steps) — opt-in group "ah_x". */
export const AH_EXT_LINES = [
  -3, -2.75, -2.5, -2.25, -2, -1.75, -1.25, 1.25, 1.75, 2, 2.25, 2.5, 2.75, 3,
];

function ahCols(
  idPrefix: string,
  headerPrefix: string,
  scope: string,
  lines: number[],
  opts: { group?: ColumnGroupId; defaultOn?: boolean; pyFormat?: boolean } = {},
): MarketColumnDef[] {
  const out: MarketColumnDef[] = [];
  const group = opts.group ?? "ah";
  const defaultOn = opts.defaultOn ?? true;
  for (const line of lines) {
    const ls = String(line);
    const lineValue = opts.pyFormat ? pyLine(line) : ls;
    const lsId = ls.replace(".", "_").replace("-", "m");
    const sign = line > 0 ? `+${ls}` : ls;
    out.push(
      m(`${idPrefix}_h_${lsId}`, `${headerPrefix}AH ${sign}`, group, "ASIAN_HANDICAP", scope, "H", lineValue, defaultOn),
      m(`${idPrefix}_a_${lsId}`, `${headerPrefix}AH ${sign} A`, group, "ASIAN_HANDICAP", scope, "A", lineValue, defaultOn),
    );
  }
  return out;
}

const AH = [
  ...ahCols("ah", "", "FULL_TIME", AH_LINES),
  ...ahCols("ah_ht", "HT ", "FIRST_HALF", AH_LINES),
  ...ahCols("ah_2h", "2H ", "SECOND_HALF", AH_LINES),
];

const AH_X = [
  ...ahCols("ahx", "", "FULL_TIME", AH_EXT_LINES, { group: "ah_x", defaultOn: false, pyFormat: true }),
  ...ahCols("ahx_ht", "HT ", "FIRST_HALF", AH_EXT_LINES, { group: "ah_x", defaultOn: false, pyFormat: true }),
  ...ahCols("ahx_2h", "2H ", "SECOND_HALF", AH_EXT_LINES, { group: "ah_x", defaultOn: false, pyFormat: true }),
];

/**
 * Common CS — kept as-is: smartMatchReportSQL uses CS_SCORES.slice(0, 6) as its key scores,
 * so do not reorder / extend this list. The table uses the full grids below.
 */
export const CS_SCORES = ["1:0", "2:0", "2:1", "0:0", "1:1", "0:1", "0:2", "1:2", "2:2", "3:1", "3:2"];

/** Full home×away grid (0..maxH × 0..maxA), home-major: 0:0, 0:1, … */
function csGrid(maxH: number, maxA: number): string[] {
  const out: string[] = [];
  for (let h = 0; h <= maxH; h++) for (let a = 0; a <= maxA; a++) out.push(`${h}:${a}`);
  return out;
}

/** FT: 0..5 each side (36). HT / 2H: 0..3 each side (16). All opt-in. */
const CS_FT_GRID = csGrid(5, 5);
const CS_HALF_GRID = csGrid(3, 3);

const CS: MarketColumnDef[] = CS_FT_GRID.map((sc) =>
  m(`cs_${sc.replace(":", "_")}`, sc, "cs", "CORRECT_SCORE", "FULL_TIME", `score:${sc}`, null, false),
);
const CS_HT: MarketColumnDef[] = CS_HALF_GRID.map((sc) =>
  m(`cs_ht_${sc.replace(":", "_")}`, `HT ${sc}`, "cs_ht", "CORRECT_SCORE", "FIRST_HALF", `score:${sc}`, null, false),
);
const CS_2H: MarketColumnDef[] = CS_HALF_GRID.map((sc) =>
  m(`cs_2h_${sc.replace(":", "_")}`, `2H ${sc}`, "cs_2h", "CORRECT_SCORE", "SECOND_HALF", `score:${sc}`, null, false),
);

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

/** Column order: meta → 1X2 (FT, HT, 2H) → HT/FT → DC → BTTS → Odd/Even → O/U → AH → CS → DNB → EH. */
export const ALL_COLUMNS: TableColumnDef[] = [
  ...META,
  ...MS_1X2,
  ...HT_1X2,
  ...SH_1X2,
  ...HTFT,
  ...DC,
  ...BTTS,
  ...OE,
  ...OU_HT,
  ...OU_MS,
  ...OU_2H,
  ...OU_X,
  ...AH,
  ...AH_X,
  ...CS,
  ...CS_HT,
  ...CS_2H,
  ...DNB,
  ...EH,
];

export function defaultVisibleGroupIds(): Set<ColumnGroupId> {
  return new Set(COLUMN_GROUPS.map((g) => g.id).filter((id) => !OPT_IN_GROUPS.has(id)));
}

/** Visible columns: meta if defaultOn; market if defaultOn — or the whole group when it is opt-in and ticked. */
export function visibleColumns(groups: Set<ColumnGroupId>): TableColumnDef[] {
  return ALL_COLUMNS.filter((c) => {
    if (!groups.has(c.group)) return false;
    if (c.kind === "meta") return c.defaultOn;
    if (OPT_IN_GROUPS.has(c.group)) return true;
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
  if (want.startsWith("sel:")) return cs.replace(/^sel:/i, "").toUpperCase() === want.slice(4);
  return false;
}
