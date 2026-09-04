import { sqlDirect as sql } from "@/lib/dbDirect";
import { MATCH_ODDS_TABLE } from "./marketQuotes";
import { SIMILARITY_CODES, type SimilarityCode } from "./similarityCodes";
import weightsCfg from "./similarityWeights.json";
import statsCfg from "./similarityStats.json";

type CodeStats = { mean_drift_pct: [number, number]; spread_close: [number, number] };
const STATS = statsCfg as unknown as Record<string, CodeStats>;
const WEIGHTS = (weightsCfg as { weights: Record<string, number> }).weights;
const K_DEFAULT = (weightsCfg as { k_default: number }).k_default;
const K_MIN = (weightsCfg as { k_min: number }).k_min;

const STAGE1_MARKET = "HOME_DRAW_AWAY:FULL_TIME";
const STAGE1_POOL = 250;
const STAGE2_POOL = 12; // artık sadece samples icin degil, regime havuzu icin de kullaniliyor
const BAND = 0.045;

// --- YENİ: LIQ_BAND artık sabit değil, adaptif. Aday sayısı azsa gevşer, çoksa sıkılaşır. ---
const LIQ_BAND_DEFAULT = 0.06;
const LIQ_BAND_STEPS = [0.04, 0.05, 0.06, 0.08, 0.10, 0.12, 0.15];
const LIQ_MIN_SAMPLE = 8; // bu adaydan azsa bir sonraki (daha geniş) adıma geç
const LIQ_MAX_SAMPLE = 60; // bu adaydan çoksa bir önceki (daha sıkı) adıma geç

// --- YENİ: steamDown/steamUp artık mutlak puan değil, yüzdesel eşik kullanıyor.
// Eskiden odds<=opening-0.12 gibi mutlak eşikler, düşük oranlarda (ör. DNB 1.3) orantısız
// katı, yüksek oranlarda (ör. DNB 8.0) orantısız gevşek davranıyordu.
const STEAM_TRIGGER_PCT = 0.08; // fixture'da "steam var mı" tetikleme yüzdesi (eski ~0.15 karşılığı)
const STEAM_MATCH_PCT = 0.06; // adayda "yeterince steam var mı" yüzdesi (eski ~0.12 karşılığı)
const STEAM_TRIGGER_PCT_AH = 0.12; // Asian Handicap için biraz daha toleranslı (eski ~0.25)
const STEAM_MATCH_PCT_AH = 0.10; // (eski ~0.20)

// --- YENİ: CS 3:3 "gizli gol radarı" — 41K maçlık backtest (cs33_backtest.csv) sonucu eklendi.
// CS 3:3 oranı açılıştan ≥%10 kısalırsa: 5+ gol %12.0 -> %15.5, Over 2.5 %48.4 -> %53.8 (n=13713 vs n=11755 yatay).
// Not: 3-3 skorunun kendisi gelme ihtimali neredeyse sabit kalıyor (~%1.0 -> %1.2); sinyal skor değil, gol enflasyonu içindir.
const CS33_STEAM_PCT = 0.10;

// --- YENİ: CS 0:0 "kısır maç radarı" — aynı backtest ailesinden (0:0 hareketi tablosu).
// CS 0:0 oranı açılıştan ≥%10 kısalırsa: 0-0 ihtimali %5.1 -> %9.5, Under 2.5 %40.6 -> %56.3.
// Ters yönde (0:0 ≥%10 uzarsa) tam tersi: 0-0 ihtimali düşük, Over/gol beklentisi artıyor — bu yönü ayrıca işaretlemiyoruz,
// sadece kısalma yönü aksiyona bağlanıyor (Under 2.5 / BTTS NO).
const CS00_STEAM_PCT = 0.10;

// --- YENİ: Favori oranı drift (uzama) sinyali — 1X2 favori hareketi tablosundan.
// Favori oranı açılıştan ≥%10 uzarsa (piyasa favoriden soğuyorsa): 0-0 %8.3, Under 2.5 %52.9'a çıkıyor.
// Favori kısaldığında ise tam tersi (0-0 en düşük %6.5) — o yön ayrı bir "Over" sinyali olarak kodlanmadı, şimdilik
// sadece istenen "favori uzarsa Under listesine al" kuralı uygulanıyor.
const FAV_DRIFT_PCT = 0.10;

// CS/HTFT ince ayarı icin core hatlar - liquid sorgusunda zaten cekiliyor
const CS_CORE_LINES = [
  "1:0", "2:0", "2:1", "3:0", "3:1", "1:1", "0:0", "1:2", "0:1", "3:2", "2:2", "1:3",
];
const HTFT_SELS = ["htft:1/1", "htft:X/X", "htft:2/2"] as const;

const LIQUID_1X2_DC_BTTS_MARKETS = new Set([
  "HOME_DRAW_AWAY:FULL_TIME",
  "HOME_DRAW_AWAY:FIRST_HALF",
  "HOME_DRAW_AWAY:SECOND_HALF",
  "DOUBLE_CHANCE:FULL_TIME",
  "BOTH_TEAMS_TO_SCORE:FULL_TIME",
]);
const LIQUID_OU_LINES = new Set([1.5, 2.5, 3.5]);
const LIQUID_AH_LINES = new Set([-1, -0.5, 0, 0.5, 1]);

function parseLine(side: string): number | null {
  const idx = side.indexOf(":");
  if (idx === -1) return null;
  const n = Number(side.slice(idx + 1));
  return Number.isFinite(n) ? n : null;
}

function isLiquidCode(c: SimilarityCode): boolean {
  if (LIQUID_1X2_DC_BTTS_MARKETS.has(c.market)) return true;
  if (c.market === "OVER_UNDER:FULL_TIME" || c.market.startsWith("OVER_UNDER:FULL_TIME:")) {
    const line = parseLine(c.side) ?? parseLine(c.market);
    return line != null && LIQUID_OU_LINES.has(line);
  }
  if (c.market === "ASIAN_HANDICAP:FULL_TIME" || c.market.startsWith("ASIAN_HANDICAP:FULL_TIME:")) {
    const line = parseLine(c.side);
    return line != null && LIQUID_AH_LINES.has(line);
  }
  return false;
}

export type FixtureOddsRow = { market: string; selection: string; odds: number; opening: number | null };

type SqlParamPusher = (v: unknown) => string;
function makePush(params: unknown[]): SqlParamPusher {
  return (v) => {
    params.push(v);
    return `$${params.length}`;
  };
}

function findFixtureRowForCode(code: SimilarityCode, rows: FixtureOddsRow[]): FixtureOddsRow | null {
  const direct = rows.find((r) => r.market === code.market && r.selection === code.side);
  if (direct) return direct;

  if (code.group === "BTTS") {
    const alt = code.side === "btts:YES" ? ["YES", "True", "btts:True"] : ["NO", "False", "btts:False"];
    for (const s of alt) {
      const r = rows.find((r) => r.market === code.market && r.selection === s);
      if (r) return r;
    }
  }
  if (code.group === "HTFT") {
    const bareCombo = code.side.replace("htft:", "");
    const r = rows.find((r) => r.market === code.market && r.selection === bareCombo);
    if (r) return r;
  }
  return null;
}

export type SimilarityFamily =
  | "CLEAN_AWAY"
  | "AWAY_SHUTOUT"
  | "HOME_BURST"
  | "HOME_NUDGE"
  | "OPEN_GAME"
  | "OPEN_DRAW"
  | "BASE";

export const FAMILY_EXPLAIN: Record<SimilarityFamily, { title: string; note: string }> = {
  BASE: {
    title: "BASE — no special family",
    note: "This match did not meet any named family rule (home burst, clean away, open game, etc.). Neighbours are matched on the standard 1X2 + O/U 2.5 + BTTS band only. Treat the score call as a distance rank, not a locked script.",
  },
  HOME_BURST: {
    title: "HOME_BURST — short home favourite, goals opening",
    note: "Home price ≤ 1.50 and totals are short or shortening. High home-goal neighbours are preferred; 0-0 / 1-0 are dropped from the core list.",
  },
  HOME_NUDGE: {
    title: "HOME_NUDGE — mild home favourite, BTTS turning on",
    note: "Home around 1.85–2.40 with BTTS yes shortening and O/U opening but still not a blowout price. Typical core: 2-1 / 1-1.",
  },
  OPEN_GAME: {
    title: "OPEN_GAME — both teams priced to score",
    note: "BTTS yes ≤ 1.75 and goals are opening. Low-score 0-0 / 1-0 neighbours are dropped when O/U 2.5 is ≤ 1.62.",
  },
  OPEN_DRAW: {
    title: "OPEN_DRAW — pick’em with short BTTS",
    note: "Home and away prices are within 12% and the draw is short. High-scoring draws stay in play.",
  },
  CLEAN_AWAY: {
    title: "CLEAN_AWAY — away favourite, totals shutting",
    note: "Away is favoured and O/U + BTTS no are shortening toward a shutout. 5+ goal neighbours are dropped.",
  },
  AWAY_SHUTOUT: {
    title: "AWAY_SHUTOUT — away favourite, BTTS no priced shorter",
    note: "Away side plus BTTS no shorter than yes. Expect 0-1 / 0-2 style neighbours; 5+ goal games are dropped.",
  },
};

export function explainFamily(family: SimilarityFamily | undefined) {
  return FAMILY_EXPLAIN[family ?? "BASE"];
}

export type ScoreBucket = { scoreline: string; n: number };
export type RegimeBuckets = {
  open: ScoreBucket[];
  shut: ScoreBucket[];
  openN: number;
  shutN: number;
};

export type BoardCall = {
  stance: "LOCK" | "LEAN" | "SPLIT";
  family: SimilarityFamily;
  side: "HOME" | "AWAY" | "PICKEM";
  sideSteam: "HOME" | "AWAY" | "NONE";
  goalSteam: "OPEN" | "SHUT" | "FLAT";
  bttsSteam: "ON" | "OFF" | "FLAT";
  open: ScoreBucket[];
  shut: ScoreBucket[];
  openN: number;
  shutN: number;
  openShare: number;
  call: string;
  alt: string;
  veto: string[];
  reason: string;
  csLadder: { score: string; odds: number; steam: "DOWN" | "UP" | "FLAT" }[];
  htft: { sel: string; odds: number; steam: "DOWN" | "UP" | "FLAT" }[];
  // YENİ: kural-tabanlı uyarılar (şu an sadece CS 3:3 sinyali). UI'da rozet/banner olarak gösterilebilir.
  alerts: string[];
  cs33Signal: {
    active: boolean; // >= CS33_STEAM_PCT kısaldı mı
    pct: number | null; // kısalma yüzdesi (pozitif = kısaldı), veri yoksa null
    odds: number | null;
    opening: number | null;
    note: string;
  } | null;
  cs00Signal: {
    active: boolean; // >= CS00_STEAM_PCT kısaldı mı
    pct: number | null; // kısalma yüzdesi (pozitif = kısaldı)
    odds: number | null;
    opening: number | null;
    note: string;
  } | null;
  favDriftSignal: {
    active: boolean; // favori >= FAV_DRIFT_PCT uzadı mı
    side: "HOME" | "AWAY" | null;
    pct: number | null; // uzama yüzdesi (pozitif = uzadı)
    odds: number | null;
    opening: number | null;
    note: string;
  } | null;
};

export type MarketInsight = {
  label: string;
  n: number;
  d: number;
  pct: number;
};

export type SimilarityResult = {
  matchedCount: number;
  samples: { event_id: string; score: number }[];
  usedCodes: string[];
  family?: SimilarityFamily;
  buckets?: ScoreBucket[];
  regimes?: RegimeBuckets;
  prediction?: { primary: string; backup: string; reason: string };
  predictionV2?: { primary: string; backup: string; reason: string; top: ScoredCorrectScore[]; goalTotals: GoalTotalBucket[] };
  board?: BoardCall;
  insights?: MarketInsight[];
  durationMs?: number;
  usedLiqBand?: number; // YENİ: adaptif aramanın sonunda kullanılan LIQ_BAND değeri (şeffaflık için)
};

function steamDir(row: FixtureOddsRow | null, min = 0.05): "DOWN" | "UP" | "FLAT" {
  if (!row || row.opening == null) return "FLAT";
  if (row.odds <= row.opening - min) return "DOWN";
  if (row.odds >= row.opening + min) return "UP";
  return "FLAT";
}

// Pozitif = kısaldı (odds < opening), negatif = uzadı. null = opening bilgisi yok.
function steamPct(row: FixtureOddsRow | null): number | null {
  if (!row || row.opening == null || row.opening <= 0) return null;
  return (row.opening - row.odds) / row.opening;
}

function directionOf(scoreline: string): "HOME" | "AWAY" | "DRAW" {
  const [hs, as] = scoreline.split("-").map(Number);
  if (hs > as) return "HOME";
  if (hs < as) return "AWAY";
  return "DRAW";
}

// YENİ: sideSteam (ev/deplasman yönünde para akışı) hesaplanıyor ama önceden hiç
// kullanılmıyordu — veto listesine "ev/deplasman kilidi yok" diye yazılıyor ama
// open[0]/shut[0] seçimi saf frekansa göre yapıldığı için bu sinyali görmezden
// geliyordu (ör. sideSteam=AWAY olsa bile frekansı yüksek bir ev skoru seçilebiliyordu).
// Bu fonksiyon, bucket'ı sideSteam yönüyle uyumlu skorlar öne gelecek şekilde
// yeniden sıralar (frekans sırasını bozmadan, sadece grup içi öncelik ekler).
function orderByDirection(bucket: ScoreBucket[], sideSteam: "HOME" | "AWAY" | "NONE"): ScoreBucket[] {
  if (sideSteam === "NONE") return bucket;
  const matches = bucket.filter((b) => directionOf(b.scoreline) === sideSteam);
  const rest = bucket.filter((b) => directionOf(b.scoreline) !== sideSteam);
  return [...matches, ...rest];
}

/** Tek skor iddiası yok. İki rejim + steam uyumu okunur. */
export function readBoard(opts: {
  fixtureOdds: FixtureOddsRow[];
  regimes?: RegimeBuckets;
}): BoardCall {
  const p = classifyFamily(opts.fixtureOdds);
  const pred = predictScoreline(opts.fixtureOdds);
  const Hc = p.h?.odds ?? 99;
  const Ac = p.a?.odds ?? 99;
  const side: BoardCall["side"] =
    Math.abs(Hc - Ac) / Math.min(Hc, Ac) <= 0.12 ? "PICKEM" : Hc <= Ac ? "HOME" : "AWAY";
  const hDir = steamDir(p.h);
  const aDir = steamDir(p.a);
  const sideSteam: BoardCall["sideSteam"] =
    hDir === "DOWN" && aDir !== "DOWN" ? "HOME" : aDir === "DOWN" && hDir !== "DOWN" ? "AWAY" : "NONE";
  const ouDir = steamDir(p.ou25);
  const goalSteam: BoardCall["goalSteam"] =
    ouDir === "DOWN" ? "OPEN" : ouDir === "UP" ? "SHUT" : "FLAT";
  const bDir = steamDir(p.bttsYes);
  const bttsSteam: BoardCall["bttsSteam"] =
    bDir === "DOWN" ? "ON" : steamDir(p.bttsNo) === "DOWN" ? "OFF" : "FLAT";

  const open = opts.regimes?.open ?? [];
  const shut = opts.regimes?.shut ?? [];
  const openN = opts.regimes?.openN ?? 0;
  const shutN = opts.regimes?.shutN ?? 0;
  const tot = openN + shutN;
  const openShare = tot ? openN / tot : 0.5;

  const veto: string[] = [];
  if (goalSteam === "SHUT") veto.push("4+ gol / 3-2 / 4-3 kilidi yok");
  if (goalSteam === "FLAT" && (p.ou25?.odds ?? 0) >= 1.85) veto.push("patlama skoru yok");
  if (bttsSteam === "OFF") veto.push("2-1 / 1-2 / 3-2 BTTS kilidi yok");
  if (sideSteam === "AWAY") veto.push("3-1 / 2-0 ev kilidi yok");
  if (sideSteam === "HOME") veto.push("0-1 / 1-3 dep kilidi yok");
  if (side === "PICKEM") veto.push("tek taraf kilidi yok");

  // --- YENİ: CS 3:3 gol enflasyonu sinyali (bkz. CS33_STEAM_PCT tanımı) ---
  const cs33Row =
    pickRow(opts.fixtureOdds, "CORRECT_SCORE:FULL_TIME", "score:3:3") ||
    opts.fixtureOdds.find((x) => x.market.includes("CORRECT_SCORE") && x.selection === "score:3:3") ||
    null;
  const cs33Pct = steamPct(cs33Row);
  const cs33Active = cs33Pct != null && cs33Pct >= CS33_STEAM_PCT;
  const cs33Signal: BoardCall["cs33Signal"] = cs33Row
    ? {
        active: cs33Active,
        pct: cs33Pct,
        odds: cs33Row.odds,
        opening: cs33Row.opening,
        note: cs33Active
          ? `CS 3:3 oranı açılıştan %${(cs33Pct! * 100).toFixed(1)} kısaldı — backtestte (n=13713) bu grupta 5+ gol %15.5 (baz %12.0) ve Over 2.5 %53.8 (baz %48.4) çıkıyor. 3-3'ün kendisi gelme ihtimali ~sabit (%1.2); sinyal "gollü kaos" için, doğrudan skor için değil.`
          : "CS 3:3 hareketi eşik altında (uyarı yok).",
      }
    : null;

  // --- YENİ: CS 0:0 kısır maç sinyali (bkz. CS00_STEAM_PCT tanımı) ---
  const cs00Row =
    pickRow(opts.fixtureOdds, "CORRECT_SCORE:FULL_TIME", "score:0:0") ||
    opts.fixtureOdds.find((x) => x.market.includes("CORRECT_SCORE") && x.selection === "score:0:0") ||
    null;
  const cs00Pct = steamPct(cs00Row);
  const cs00Active = cs00Pct != null && cs00Pct >= CS00_STEAM_PCT;
  const cs00Signal: BoardCall["cs00Signal"] = cs00Row
    ? {
        active: cs00Active,
        pct: cs00Pct,
        odds: cs00Row.odds,
        opening: cs00Row.opening,
        note: cs00Active
          ? `CS 0:0 oranı açılıştan %${(cs00Pct! * 100).toFixed(1)} kısaldı — backtestte 0-0 ihtimali %5.1 -> %9.5, Under 2.5 %40.6 -> %56.3'e çıkıyor. Bu maçlarda %51.5 ihtimalle BTTS NO gerçekleşiyor; Over 2.5 / BTTS YES önerilmemeli.`
          : "CS 0:0 hareketi eşik altında (uyarı yok).",
      }
    : null;

  // --- YENİ: favori oranı drift (uzama) sinyali (bkz. FAV_DRIFT_PCT tanımı) ---
  const favSide: "HOME" | "AWAY" | null = p.h != null || p.a != null ? (Hc <= Ac ? "HOME" : "AWAY") : null;
  const favRow = favSide === "HOME" ? p.h : favSide === "AWAY" ? p.a : null;
  const favPct = steamPct(favRow); // pozitif = favori kısaldı
  const favDriftPct = favPct != null ? -favPct : null; // pozitif = favori uzadı (drift)
  const favDriftActive = favDriftPct != null && favDriftPct >= FAV_DRIFT_PCT;
  const favDriftSignal: BoardCall["favDriftSignal"] = favRow
    ? {
        active: favDriftActive,
        side: favSide,
        pct: favDriftPct,
        odds: favRow.odds,
        opening: favRow.opening,
        note: favDriftActive
          ? `Favori (${favSide}) oranı açılıştan %${(favDriftPct! * 100).toFixed(1)} uzadı — backtestte bu grupta 0-0 ihtimali %8.3, Under 2.5 %52.9'a çıkıyor. Sürpriz gol düellosu değil, favorinin kilit açamadığı bir "alt/kısır" senaryosu daha olası.`
          : "Favori oranı hareketi eşik altında (uyarı yok).",
      }
    : null;

  const alerts: string[] = [];
  if (cs33Active) {
    alerts.push("CS 3:3 kısalma sinyali → Over 2.5 / BTTS olasılığı artıyor (bkz. cs33Signal)");
  }
  if (cs00Active) {
    alerts.push("CS 0:0 kısalma sinyali → Under 2.5 / BTTS NO olasılığı artıyor (bkz. cs00Signal)");
  }
  if (favDriftActive) {
    alerts.push(`Favori (${favSide}) oranı uzuyor → kısır/Under maç ihtimali artıyor (bkz. favDriftSignal)`);
  }

  const conflict =
    (sideSteam === "AWAY" && goalSteam === "SHUT") ||
    (goalSteam === "FLAT" && Math.abs(openShare - 0.5) < 0.2) ||
    (sideSteam === "NONE" && Math.abs(openShare - 0.5) < 0.22);

  let stance: BoardCall["stance"] = "LEAN";
  if (conflict || Math.abs(openShare - 0.5) < 0.18) stance = "SPLIT";
  else if (openShare >= 0.62 || openShare <= 0.38) stance = "LOCK";

  let call = pred.primary;
  let alt = pred.backup;
  const openOrdered = orderByDirection(open, sideSteam);
  const shutOrdered = orderByDirection(shut, sideSteam);
  if (stance === "SPLIT") {
    call = openOrdered[0]?.scoreline ?? pred.primary;
    alt = shutOrdered[0]?.scoreline ?? pred.backup;
  } else if (openShare >= 0.55) {
    call = openOrdered[0]?.scoreline ?? pred.primary;
    alt = openOrdered[1]?.scoreline ?? shutOrdered[0]?.scoreline ?? pred.backup;
  } else {
    call = shutOrdered[0]?.scoreline ?? pred.primary;
    alt = shutOrdered[1]?.scoreline ?? openOrdered[0]?.scoreline ?? pred.backup;
  }

  const reason = [
    `aile ${p.family}`,
    `taraf ${side} steam ${sideSteam}`,
    `gol ${goalSteam} btts ${bttsSteam}`,
    `açık ${openN} kilit ${shutN}`,
    `duruş ${stance}`,
  ].join(" · ");

  const csLadder: BoardCall["csLadder"] = (() => {
    const out: BoardCall["csLadder"] = [];
    for (const line of ["1:0", "2:0", "2:1", "3:0", "3:1", "1:1", "0:0", "1:2", "0:1"]) {
      const row =
        pickRow(opts.fixtureOdds, "CORRECT_SCORE:FULL_TIME", `score:${line}`) ||
        opts.fixtureOdds.find((x) => x.market.includes("CORRECT_SCORE") && x.selection === `score:${line}`) ||
        null;
      if (!row) continue;
      out.push({ score: line.replace(":", "-"), odds: row.odds, steam: steamDir(row, 0.04) });
    }
    out.sort((a, b) => a.odds - b.odds);
    return out;
  })();

  const htft: BoardCall["htft"] = (() => {
    const out: BoardCall["htft"] = [];
    for (const sel of ["htft:1/1", "htft:X/1", "htft:2/2", "htft:X/X"]) {
      const row = pickRow(opts.fixtureOdds, "HALF_FULL_TIME:FULL_TIME", sel);
      if (!row) continue;
      out.push({ sel, odds: row.odds, steam: steamDir(row, 0.04) });
    }
    return out;
  })();

  return {
    stance,
    family: p.family,
    side,
    sideSteam,
    goalSteam,
    bttsSteam,
    open,
    shut,
    openN,
    shutN,
    openShare,
    call,
    alt,
    veto,
    reason,
    csLadder,
    htft,
    alerts,
    cs33Signal,
    cs00Signal,
    favDriftSignal,
  };
}

export type SimilarityBulkQueries = {
  driftQuery: { text: string; params: unknown[] };
  buildSpreadQuery: (eventIds: string[]) => { text: string; params: unknown[] };
  activeCodes: SimilarityCode[];
};

function codeKey(market: string, side: string): string {
  return `${market}\u0000${side}`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function band(v: number, pct = BAND): [number, number] {
  return [v * (1 - pct), v * (1 + pct)];
}

function pickRow(rows: FixtureOddsRow[], market: string, selection: string): FixtureOddsRow | null {
  const exact = rows.find((r) => r.market === market && r.selection === selection);
  if (exact) return exact;
  if (market === "OVER_UNDER:FULL_TIME:2.5") {
    return (
      rows.find((r) => r.market === "OVER_UNDER:FULL_TIME" && r.selection === "OVER:2.5") ||
      rows.find((r) => r.market.startsWith("OVER_UNDER") && r.selection === "OVER:2.5") ||
      null
    );
  }
  if (market === "OVER_UNDER:FULL_TIME:3.5") {
    return (
      rows.find((r) => r.market === "OVER_UNDER:FULL_TIME" && r.selection === "OVER:3.5") ||
      rows.find((r) => r.market.startsWith("OVER_UNDER") && r.selection === "OVER:3.5") ||
      null
    );
  }
  if (market === "BOTH_TEAMS_TO_SCORE:FULL_TIME" && selection === "btts:YES") {
    return (
      rows.find((r) => r.market.includes("BOTH_TEAMS") && (r.selection === "btts:YES" || r.selection === "YES")) ||
      null
    );
  }
  if (market === "BOTH_TEAMS_TO_SCORE:FULL_TIME" && selection === "btts:NO") {
    return (
      rows.find((r) => r.market.includes("BOTH_TEAMS") && (r.selection === "btts:NO" || r.selection === "NO")) ||
      null
    );
  }
  if (market === "HALF_FULL_TIME:FULL_TIME" || market === "CORRECT_SCORE:FULL_TIME") {
    return rows.find((r) => r.market === market && r.selection === selection) || null;
  }
  if (market === "DRAW_NO_BET:FULL_TIME") {
    return (
      rows.find((r) => r.market === market && r.selection === selection) ||
      rows.find((r) => r.market.includes("DRAW_NO_BET") && r.selection === selection) ||
      null
    );
  }
  if (market === "HOME_DRAW_AWAY:SECOND_HALF" || market === "ASIAN_HANDICAP:FULL_TIME") {
    return (
      rows.find((r) => r.market === market && r.selection === selection) ||
      rows.find((r) => r.market.startsWith(market.split(":")[0]) && r.selection === selection) ||
      null
    );
  }
  return null;
}

export function classifyFamily(fixtureOdds: FixtureOddsRow[]): {
  family: SimilarityFamily;
  h: FixtureOddsRow | null;
  d: FixtureOddsRow | null;
  a: FixtureOddsRow | null;
  ou25: FixtureOddsRow | null;
  ou35: FixtureOddsRow | null;
  bttsYes: FixtureOddsRow | null;
  bttsNo: FixtureOddsRow | null;
} {
  const h = pickRow(fixtureOdds, STAGE1_MARKET, "H");
  const d = pickRow(fixtureOdds, STAGE1_MARKET, "D");
  const a = pickRow(fixtureOdds, STAGE1_MARKET, "A");
  const ou25 = pickRow(fixtureOdds, "OVER_UNDER:FULL_TIME:2.5", "OVER:2.5");
  const ou35 = pickRow(fixtureOdds, "OVER_UNDER:FULL_TIME:3.5", "OVER:3.5");
  const bttsYes = pickRow(fixtureOdds, "BOTH_TEAMS_TO_SCORE:FULL_TIME", "btts:YES");
  const bttsNo = pickRow(fixtureOdds, "BOTH_TEAMS_TO_SCORE:FULL_TIME", "btts:NO");

  const Hc = h?.odds ?? null;
  const Ac = a?.odds ?? null;
  const side: "HOME" | "AWAY" = Hc != null && Ac != null && Hc <= Ac ? "HOME" : "AWAY";
  const fav = Math.min(Hc ?? 99, Ac ?? 99);

  const goalsOpen =
    ou25?.opening != null &&
    ou25.odds < ou25.opening &&
    (ou35?.opening == null || ou35.odds <= ou35.opening);
  const goalsShut =
    ou25?.opening != null &&
    ou25.odds > ou25.opening &&
    bttsNo?.opening != null &&
    bttsNo.odds < bttsNo.opening;
  const bttsOn = bttsYes?.opening != null && bttsYes.odds < bttsYes.opening;

  const bttsNoFav =
    bttsNo != null && bttsYes != null && bttsNo.odds < bttsYes.odds && bttsYes.odds >= 1.9;
  const pickem =
    Hc != null && Ac != null && Math.abs(Hc - Ac) / Math.min(Hc, Ac) <= 0.12 && (d?.odds ?? 99) <= 3.55;

  let family: SimilarityFamily = "BASE";
  if (side === "AWAY" && bttsNoFav) family = "AWAY_SHUTOUT";
  else if (side === "AWAY" && goalsShut) family = "CLEAN_AWAY";
  else if (side === "HOME" && fav <= 1.5 && (goalsOpen || (ou25 != null && ou25.odds <= 1.58))) family = "HOME_BURST";
  else if (pickem && (bttsYes?.odds ?? 99) <= 1.8 && (ou35?.odds ?? 99) <= 3.3) family = "OPEN_DRAW";
  else if ((goalsOpen || bttsOn) && (bttsYes?.odds ?? 99) <= 1.75) family = "OPEN_GAME";
  else if (
    side === "HOME" &&
    fav >= 1.85 &&
    fav <= 2.4 &&
    bttsOn &&
    goalsOpen &&
    (ou25?.odds ?? 0) >= 1.95 &&
    (bttsYes?.odds ?? 99) <= 2.0
  ) {
    family = "HOME_NUDGE";
  }

  return { family, h, d, a, ou25, ou35, bttsYes, bttsNo };
}

function csOdds(rows: FixtureOddsRow[], line: string): number | null {
  const r =
    pickRow(rows, "CORRECT_SCORE:FULL_TIME", `score:${line}`) ||
    rows.find((x) => x.market.includes("CORRECT_SCORE") && (x.selection === `score:${line}` || x.selection === line));
  return r?.odds ?? null;
}

/** K1–K6 nokta atışı. fixtureOdds içinde CS / HTFT varsa K6 da çalışır. */
export function predictScoreline(fixtureOdds: FixtureOddsRow[]): {
  family: SimilarityFamily;
  primary: string;
  backup: string;
  reason: string;
} {
  const p = classifyFamily(fixtureOdds);
  const cs20 = csOdds(fixtureOdds, "2:0");
  const cs21 = csOdds(fixtureOdds, "2:1");
  const cs11 = csOdds(fixtureOdds, "1:1");
  const cs22 = csOdds(fixtureOdds, "2:2");
  const cs32 = csOdds(fixtureOdds, "3:2");
  const ratio21 =
    cs21 != null && cs20 != null && cs20 > 0 ? cs21 / cs20 : null;
  const awayGoalPriced = ratio21 != null && ratio21 <= 1.2;

  const htft11 = pickRow(fixtureOdds, "HALF_FULL_TIME:FULL_TIME", "htft:1/1");
  const ahM15 = pickRow(fixtureOdds, "ASIAN_HANDICAP:FULL_TIME", "H:-1.5");

  if (p.family === "AWAY_SHUTOUT") {
    const ahA = pickRow(fixtureOdds, "ASIAN_HANDICAP:FULL_TIME", "A:-1.5");
    if (ahA && ahA.odds >= 2.1) return { family: p.family, primary: "0-1", backup: "0-2", reason: "AWAY_SHUTOUT + AH-1.5 uzun" };
    return { family: p.family, primary: "0-2", backup: "0-1", reason: "AWAY_SHUTOUT" };
  }
  if (p.family === "CLEAN_AWAY") {
    return { family: p.family, primary: "0-2", backup: "0-1", reason: "CLEAN_AWAY OU kapanır" };
  }
  if (p.family === "HOME_BURST") {
    if (awayGoalPriced || (p.bttsYes && p.bttsYes.odds <= 1.75)) {
      const tightAh = ahM15 != null && ahM15.odds <= 2.05;
      if (p.ou35 && p.ou35.odds <= 1.9) return { family: p.family, primary: "4-2", backup: "5-1", reason: "HOME_BURST OU35 çok kısa" };
      if (tightAh) return { family: p.family, primary: "4-2", backup: "5-2", reason: "HOME_BURST BTTS + -1.5" };
      return { family: p.family, primary: "3-1", backup: "2-1", reason: "HOME_BURST BTTS, -1.5 sınır" };
    }
    if (p.ou25 && p.ou25.odds <= 1.55) return { family: p.family, primary: "3-0", backup: "2-0", reason: "HOME_BURST clean-sheet eğilim" };
    return { family: p.family, primary: "2-0", backup: "3-0", reason: "HOME_BURST" };
  }
  if (p.family === "HOME_NUDGE") {
    const cs10 = csOdds(fixtureOdds, "1:0");
    const cs21row = pickRow(fixtureOdds, "CORRECT_SCORE:FULL_TIME", "score:2:1");
    const twoOneDown =
      cs21row?.opening != null && cs21row.odds < cs21row.opening;
    const oneNilUp =
      cs10 != null &&
      (() => {
        const r = pickRow(fixtureOdds, "CORRECT_SCORE:FULL_TIME", "score:1:0");
        return r?.opening != null && r.odds > r.opening;
      })();
    if (twoOneDown || oneNilUp) {
      return { family: p.family, primary: "2-1", backup: "1-1", reason: "HOME_NUDGE BTTS flip + CS 2-1 kısalır / 1-0 uzar" };
    }
    return { family: p.family, primary: "2-1", backup: "1-0", reason: "HOME_NUDGE ev ~2.15 + gol açılır" };
  }
  if (p.family === "OPEN_DRAW") {
    if (p.ou35 && p.ou35.odds <= 3.25 && (p.bttsYes?.odds ?? 99) <= 1.75) {
      return { family: p.family, primary: "3-3", backup: "2-2", reason: "OPEN_DRAW + OU35 + BTTS" };
    }
    return { family: p.family, primary: "1-1", backup: "2-2", reason: "OPEN_DRAW" };
  }
  if (p.family === "OPEN_GAME") {
    if (p.ou25 && p.ou25.odds <= 1.55 && (p.bttsYes?.odds ?? 99) <= 1.5) {
      return { family: p.family, primary: "2-2", backup: "3-2", reason: "OPEN_GAME OU25/BTTS çok kısa; 1-1 totals ile çelişir" };
    }
    if (awayGoalPriced && p.ou35 && p.ou35.odds <= 2.55) {
      return { family: p.family, primary: "2-1", backup: "3-2", reason: "OPEN_GAME CS(2-1)≈CS(2-0) + OU35" };
    }
    if (htft11 && (p.h?.odds ?? 99) <= 2.1) {
      return { family: p.family, primary: "2-1", backup: "3-1", reason: "OPEN_GAME HT/FT 1/1" };
    }
    return { family: p.family, primary: "2-1", backup: "2-2", reason: "OPEN_GAME" };
  }

  if (cs11 != null && cs21 != null && cs11 <= cs21 && (p.ou25?.odds ?? 0) > 1.7) {
    return { family: p.family, primary: "1-1", backup: "2-1", reason: "CS 1-1 en kısa" };
  }
  return { family: p.family, primary: "2-1", backup: "1-1", reason: "BASE" };
}

// ============================================================================
// V2: Piyasa-skorlamalı tahmin motoru (aile kurallarına değil, tüm marketlerin
// birleşik implied-probability'sine dayanır). predictScoreline (V1, kural
// tabanlı) dokunulmadan duruyor — ikisi paralel çalıştırılıp karşılaştırılabilir.
//
// ÖNEMLİ: sabit bir "maxTotal" sınırıyla adaylar üretmiyoruz — bookmaker
// FULL_TIME CORRECT_SCORE marketinde fiilen neyi fiyatlamışsa (bazılarında
// 9-1/8-2/7-3'e kadar var, bazılarında sadece 4-4'e kadar) onu tarıyoruz. Yani
// 7 gollü bir skor piyasada fiyatlanmışsa aday listesine giriyor, fiyatlanmamışsa
// zaten piyasa da o ihtimale bir görüş bildirmemiş demektir.
// ============================================================================

export type ScoredCorrectScore = {
  h: number;
  a: number;
  /** Sadece CORRECT_SCORE marketinin devig edilmiş implied prob'u */
  csProb: number;
  /** 1X2/OU2.5/OU3.5/BTTS'ten gelen çarpan (kova düzeyinde, skor içi sıralamayı bozmaz) */
  crossMarketMult: number;
  /** Son, normalize edilmiş olasılık (tüm adaylar toplamı 1) */
  prob: number;
};

export type GoalTotalBucket = { total: number; prob: number };

export type V2Weights = {
  /** 1X2 yönünün (H/D/A) etkisi */
  dir: number;
  /** Over/Under 2.5'in etkisi */
  ou25: number;
  /** Over/Under 3.5'in etkisi */
  ou35: number;
  /** BTTS Yes/No'nun etkisi */
  btts: number;
  /** Sağlama amaçlı üst sınır — piyasa hatası/garip novelty bahisleri elemek için.
      Gerçek aday üretimini kısıtlamaz, sadece aşırı uçları (ör. 15+ gol) filtreler. */
  sanityMaxTotal: number;
};

// TODO(kalibrasyon): Bu ağırlıklar şu an sadece birkaç örnek maçla elle seçildi.
// Arşiv (events/match_odds, ~90k maç) üzerinde backtest yapılıp grid/gradient
// search ile kalibre edilmeli — production'a almadan önce bunu yapmadan güvenme.
// calibrate_v2.py script'i bu amaçla hazırlandı.
export const V2_DEFAULT_WEIGHTS: V2Weights = {
  dir: 0.6,
  ou25: 0.5,
  ou35: 0.3,
  btts: 0.4,
  sanityMaxTotal: 12,
};

/** İki taraflı bir marketin (over/under, home/draw/away, btts yes/no) oranlarını devig eder. */
function devigPair(a: number | null | undefined, b: number | null | undefined): [number, number] {
  const pa = a ? 1 / a : 0;
  const pb = b ? 1 / b : 0;
  const sum = pa + pb || 1;
  return [pa / sum, pb / sum];
}

function devigTriple(
  a: number | null | undefined,
  b: number | null | undefined,
  c: number | null | undefined
): [number, number, number] {
  const pa = a ? 1 / a : 0;
  const pb = b ? 1 / b : 0;
  const pc = c ? 1 / c : 0;
  const sum = pa + pb + pc || 1;
  return [pa / sum, pb / sum, pc / sum];
}

/** fixtureOdds içindeki tüm FULL_TIME CORRECT_SCORE satırlarını (h,a,odds) olarak çıkarır. */
function extractAllCorrectScores(
  fixtureOdds: FixtureOddsRow[],
  sanityMaxTotal: number
): { h: number; a: number; odds: number }[] {
  const out: { h: number; a: number; odds: number }[] = [];
  for (const row of fixtureOdds) {
    if (row.market !== "CORRECT_SCORE:FULL_TIME") continue;
    if (!row.selection.startsWith("score:")) continue;
    const parts = row.selection.split(":"); // ["score", "H", "A"]
    if (parts.length !== 3) continue;
    const h = Number(parts[1]);
    const a = Number(parts[2]);
    if (!Number.isFinite(h) || !Number.isFinite(a) || h < 0 || a < 0) continue;
    if (h + a > sanityMaxTotal) continue;
    if (!Number.isFinite(row.odds) || row.odds <= 1) continue;
    out.push({ h, a, odds: row.odds });
  }
  return out;
}

/**
 * Tüm doğru skor adaylarını (bookmaker'ın fiilen fiyatladığı her h-a) piyasanın
 * birleşik görüşüne göre skorlayıp olasılığa göre sıralar. CS market taban
 * alınır (kova-içi sıralamayı o belirler); 1X2/OU2.5/OU3.5/BTTS ise her kovaya
 * (yön/toplam/btts durumu) eşit uygulanan çarpanlardır — yani "3-0 mı 4-0 mü"
 * CS'e, "az mı çok mu gol" OU'ya kalır. 7+ gollü kombinasyonlar dahil, piyasa
 * fiyatlamışsa hiçbir üst sınırla kesilmez.
 */
export function scoreCorrectScoreDistribution(
  fixtureOdds: FixtureOddsRow[],
  weights: V2Weights = V2_DEFAULT_WEIGHTS
): ScoredCorrectScore[] {
  const h = pickRow(fixtureOdds, STAGE1_MARKET, "H");
  const d = pickRow(fixtureOdds, STAGE1_MARKET, "D");
  const a = pickRow(fixtureOdds, STAGE1_MARKET, "A");
  const over25 = pickRow(fixtureOdds, "OVER_UNDER:FULL_TIME:2.5", "OVER:2.5");
  const under25 = pickRow(fixtureOdds, "OVER_UNDER:FULL_TIME", "UNDER:2.5");
  const over35 = pickRow(fixtureOdds, "OVER_UNDER:FULL_TIME:3.5", "OVER:3.5");
  const under35 = pickRow(fixtureOdds, "OVER_UNDER:FULL_TIME", "UNDER:3.5");
  const bttsYes = pickRow(fixtureOdds, "BOTH_TEAMS_TO_SCORE:FULL_TIME", "btts:YES");
  const bttsNo = pickRow(fixtureOdds, "BOTH_TEAMS_TO_SCORE:FULL_TIME", "btts:NO");

  const [pH, pD, pA] = devigTriple(h?.odds, d?.odds, a?.odds);
  const [pOver25, pUnder25] = devigPair(over25?.odds, under25?.odds);
  const [pOver35, pUnder35] = devigPair(over35?.odds, under35?.odds);
  const [pBttsYes, pBttsNo] = devigPair(bttsYes?.odds, bttsNo?.odds);

  const raw = extractAllCorrectScores(fixtureOdds, weights.sanityMaxTotal);
  if (!raw.length) return [];

  const csProbSum = raw.reduce((s, r) => s + 1 / r.odds, 0) || 1;

  const scored2: ScoredCorrectScore[] = raw.map(({ h: hs, a: as, odds }) => {
    const csProb = 1 / odds / csProbSum;
    const total = hs + as;
    const dirFactor = hs > as ? pH : hs === as ? pD : pA;
    const ou25Factor = total >= 3 ? pOver25 : pUnder25;
    const ou35Factor = total >= 4 ? pOver35 : pUnder35;
    const bttsFactor = hs > 0 && as > 0 ? pBttsYes : pBttsNo;
    // *3 / *2: kovanın "nötr" payı (1/3, 1/2) 1.0'a gelsin diye — nötr bir
    // sinyal çarpanı değiştirmesin, sadece piyasanın normalden sapması etkilesin.
    const crossMarketMult =
      Math.pow(dirFactor * 3, weights.dir) *
      Math.pow(ou25Factor * 2, weights.ou25) *
      Math.pow(ou35Factor * 2, weights.ou35) *
      Math.pow(bttsFactor * 2, weights.btts);
    return { h: hs, a: as, csProb, crossMarketMult, prob: csProb * crossMarketMult };
  });

  const probSum = scored2.reduce((s, c) => s + c.prob, 0) || 1;
  const normalized = scored2.map((c) => ({ ...c, prob: c.prob / probSum }));
  normalized.sort((x, y) => y.prob - x.prob);
  return normalized;
}

/**
 * scoreCorrectScoreDistribution çıktısını toplam gol sayısına göre gruplar
 * (0, 1, 2, ... N gol). "7 gollü bir maça da, 0-0/1-0'a da yakın olabilmeli"
 * ihtiyacı için: bu, maçın olası toplam gol profilini (düşük mü yüksek mi
 * skorlu olacağı) tek bakışta gösterir.
 */
export function goalTotalDistribution(fixtureOdds: FixtureOddsRow[], weights?: V2Weights): GoalTotalBucket[] {
  const dist = scoreCorrectScoreDistribution(fixtureOdds, weights);
  const byTotal = new Map<number, number>();
  for (const c of dist) {
    const t = c.h + c.a;
    byTotal.set(t, (byTotal.get(t) ?? 0) + c.prob);
  }
  return Array.from(byTotal.entries())
    .map(([total, prob]) => ({ total, prob }))
    .sort((x, y) => x.total - y.total);
}

/**
 * predictScoreline (V1) ile aynı dönüş şeklinde (family/primary/backup/reason),
 * ama primary/backup aile kuralları yerine scoreCorrectScoreDistribution'ın
 * en olası 2 skorundan geliyor. `family` sadece etiketleme/loglama için
 * classifyFamily'den taşınıyor, karar mekanizmasına girmiyor.
 */
export function predictScorelineV2(
  fixtureOdds: FixtureOddsRow[],
  weights: V2Weights = V2_DEFAULT_WEIGHTS
): {
  family: SimilarityFamily;
  primary: string;
  backup: string;
  reason: string;
  top: ScoredCorrectScore[];
  goalTotals: GoalTotalBucket[];
} {
  const p = classifyFamily(fixtureOdds);
  const dist = scoreCorrectScoreDistribution(fixtureOdds, weights);
  const goalTotals = goalTotalDistribution(fixtureOdds, weights);
  if (dist.length < 2) {
    return {
      family: p.family,
      primary: "2-1",
      backup: "1-1",
      reason: "V2: CS verisi yetersiz, fallback",
      top: dist,
      goalTotals,
    };
  }
  const [top1, top2] = dist;
  return {
    family: p.family,
    primary: `${top1.h}-${top1.a}`,
    backup: `${top2.h}-${top2.a}`,
    reason: `V2 piyasa-skorlama: ${top1.h}-${top1.a}(%${(top1.prob * 100).toFixed(1)}) / ${top2.h}-${top2.a}(%${(top2.prob * 100).toFixed(1)})`,
    top: dist,
    goalTotals,
  };
}

/** Eski UNION/tüm-kod tarama — sadece geriye dönük uyumluluk. Production path findSimilarForBookmaker. */
export function buildSimilarityQueries(opts: {
  bookmaker: string;
  fixtureOdds: FixtureOddsRow[];
}): SimilarityBulkQueries | null {
  const { bookmaker, fixtureOdds } = opts;

  const activeCodes = SIMILARITY_CODES.filter((c) => {
    if (!STATS[c.code]) return false;
    const row = findFixtureRowForCode(c, fixtureOdds);
    return row != null && row.opening != null && row.opening !== 0;
  });
  if (!activeCodes.length) return null;

  const driftParams: unknown[] = [bookmaker];
  const driftValues = activeCodes
    .map((c) => {
      driftParams.push(c.market, c.side);
      return `($${driftParams.length - 1}, $${driftParams.length})`;
    })
    .join(", ");
  const driftQuery = {
    text: `
      SELECT mo.event_id, mo.market, mo.selection, mo.odds, mo.opening
      FROM ${MATCH_ODDS_TABLE} mo
      JOIN (VALUES ${driftValues}) AS codes(market, selection)
        ON mo.market = codes.market AND mo.selection = codes.selection
      WHERE mo.bookmaker = $1
        AND mo.opening IS NOT NULL AND mo.opening != 0
    `,
    params: driftParams,
  };

  const buildSpreadQuery = (eventIds: string[]) => {
    const params: unknown[] = [];
    const values = activeCodes
      .map((c) => {
        params.push(c.market, c.side);
        return `($${params.length - 1}, $${params.length})`;
      })
      .join(", ");
    params.push(eventIds);
    return {
      text: `
        SELECT mo.event_id, mo.market, mo.selection, STDDEV(mo.odds) AS spread_close
        FROM ${MATCH_ODDS_TABLE} mo
        JOIN (VALUES ${values}) AS codes(market, selection)
          ON mo.market = codes.market AND mo.selection = codes.selection
        WHERE mo.event_id = ANY($${params.length}::text[])
        GROUP BY mo.event_id, mo.market, mo.selection
      `,
      params,
    };
  };

  return { driftQuery, buildSpreadQuery, activeCodes };
}

function rel(a: number, b: number): number {
  if (!b) return 1;
  return Math.abs(a - b) / b;
}

// Yüzdesel steam yönü tespiti — steamDown/steamUp'ın yerini alıyor.
// pct: opening'e göre yüzde kaç düşmüş/artmış olmalı (0.08 = %8).
function steamDownPct(
  row: { odds: number; opening: number | null } | FixtureOddsRow | null | undefined,
  pct: number,
): boolean {
  if (!row || row.opening == null || row.opening <= 0) return false;
  return (row.opening - row.odds) / row.opening >= pct;
}
function steamUpPct(
  row: { odds: number; opening: number | null } | FixtureOddsRow | null | undefined,
  pct: number,
): boolean {
  if (!row || row.opening == null || row.opening <= 0) return false;
  return (row.odds - row.opening) / row.opening >= pct;
}

export async function findSimilarForBookmaker(opts: {
  eventId: string;
  bookmaker: string;
  fixtureOdds: FixtureOddsRow[];
  limit?: number;
}): Promise<SimilarityResult> {
  const t0 = Date.now();
  const { eventId, bookmaker, fixtureOdds, limit = 60 } = opts;
  const prof = classifyFamily(fixtureOdds);

  if (!prof.h || !prof.d || !prof.a) {
    return { matchedCount: 0, samples: [], usedCodes: [], family: prof.family, durationMs: Date.now() - t0 };
  }

  const [hLo, hHi] = band(prof.h.odds);
  const [dLo, dHi] = band(prof.d.odds);
  const [aLo, aHi] = band(prof.a.odds);

  const stage1 = (await sql.unsafe(
    `
    SELECT event_id,
           MAX(CASE WHEN selection = 'H' THEN odds END) AS h,
           MAX(CASE WHEN selection = 'D' THEN odds END) AS d,
           MAX(CASE WHEN selection = 'A' THEN odds END) AS a,
           MAX(CASE WHEN selection = 'H' THEN opening END) AS h_open,
           MAX(CASE WHEN selection = 'D' THEN opening END) AS d_open,
           MAX(CASE WHEN selection = 'A' THEN opening END) AS a_open
    FROM ${MATCH_ODDS_TABLE}
    WHERE bookmaker = $1
      AND market = '${STAGE1_MARKET}'
      AND selection IN ('H','D','A')
      AND opening IS NOT NULL AND opening <> 0
      AND event_id <> $2
    GROUP BY event_id
    HAVING MAX(CASE WHEN selection = 'H' THEN odds END) BETWEEN $3 AND $4
       AND MAX(CASE WHEN selection = 'D' THEN odds END) BETWEEN $5 AND $6
       AND MAX(CASE WHEN selection = 'A' THEN odds END) BETWEEN $7 AND $8
    `,
    [bookmaker, eventId, hLo, hHi, dLo, dHi, aLo, aHi] as never[],
  )) as {
    event_id: string;
    h: number;
    d: number;
    a: number;
    h_open: number | null;
    d_open: number | null;
    a_open: number | null;
  }[];

  const homeLen =
    prof.h.opening != null && prof.h.odds >= prof.h.opening + 0.05;
  const homeSh =
    prof.h.opening != null && prof.h.odds <= prof.h.opening - 0.05;
  const awayLen =
    prof.a.opening != null && prof.a.odds >= prof.a.opening + 0.05;
  const awaySh =
    prof.a.opening != null && prof.a.odds <= prof.a.opening - 0.05;

  const stage1Scored = stage1
    .filter((r) => {
      if (homeLen && !(r.h_open != null && r.h >= r.h_open + 0.04)) return false;
      if (homeSh && !(r.h_open != null && r.h <= r.h_open - 0.04)) return false;
      if (awayLen && !(r.a_open != null && r.a >= r.a_open + 0.04)) return false;
      if (awaySh && !(r.a_open != null && r.a <= r.a_open - 0.04)) return false;
      return true;
    })
    .map((r) => ({
      ...r,
      d1:
        rel(r.h, prof.h!.odds) ** 2 +
        rel(r.d, prof.d!.odds) ** 2 +
        rel(r.a, prof.a!.odds) ** 2,
    }))
    .sort((x, y) => x.d1 - y.d1)
    .slice(0, STAGE1_POOL);

  if (!stage1Scored.length) {
    return {
      matchedCount: 0,
      samples: [],
      usedCodes: ["1X2_FT"],
      family: prof.family,
      durationMs: Date.now() - t0,
    };
  }

  const candidateIds = stage1Scored.map((r) => r.event_id);
  const liquid = (await sql.unsafe(
    `
    SELECT event_id, market, selection, odds, opening
    FROM ${MATCH_ODDS_TABLE}
    WHERE bookmaker = $1
      AND event_id = ANY($2::text[])
      AND (
        (market = 'OVER_UNDER:FULL_TIME:2.5' AND selection IN ('OVER:2.5','UNDER:2.5'))
        OR (market = 'OVER_UNDER:FULL_TIME:3.5' AND selection IN ('OVER:3.5','UNDER:3.5'))
        OR (market = 'BOTH_TEAMS_TO_SCORE:FULL_TIME' AND selection IN ('btts:YES','btts:NO','YES','NO'))
        OR (market = 'HALF_FULL_TIME:FULL_TIME' AND selection IN ('htft:1/1','htft:X/X','htft:2/2','htft:1/2','htft:2/1','1/1','X/X','2/2','1/2','2/1'))
        OR (market = 'CORRECT_SCORE:FULL_TIME' AND selection IN (
          'score:1:0','score:2:0','score:2:1','score:3:0','score:3:1','score:3:2',
          'score:1:1','score:2:2','score:0:0','score:0:1','score:0:2','score:1:2','score:1:3'
        ))
        OR (market = 'DRAW_NO_BET:FULL_TIME' AND selection IN ('H','A'))
        OR (market = 'HOME_DRAW_AWAY:SECOND_HALF' AND selection IN ('H','D','A'))
        OR (market = 'HOME_DRAW_AWAY:FIRST_HALF' AND selection IN ('H','D','A'))
        OR (market = 'ASIAN_HANDICAP:FULL_TIME' AND selection IN ('A:-1.0','H:-1.0','A:0.0','H:0.0'))
        OR (market = 'EUROPEAN_HANDICAP:FULL_TIME' AND selection IN ('A:-1.0','H:-1.0'))
      )
    `,
    [bookmaker, candidateIds] as never[],
  )) as { event_id: string; market: string; selection: string; odds: number; opening: number | null }[];

  const liqByEvent = new Map<string, Map<string, { odds: number; opening: number | null }>>();
  for (const row of liquid) {
    let m = liqByEvent.get(row.event_id);
    if (!m) {
      m = new Map();
      liqByEvent.set(row.event_id, m);
    }
    const sel = row.selection === "YES" ? "btts:YES" : row.selection === "NO" ? "btts:NO" : row.selection;
    m.set(`${row.market}|${sel}`, { odds: row.odds, opening: row.opening });
  }

  // --- YENİ: fixture'ın kendi CS core hatları + favori HTFT kombinasyonu ---
  const fxCsRows = CS_CORE_LINES
    .map((line) => ({ line, row: pickRow(fixtureOdds, "CORRECT_SCORE:FULL_TIME", `score:${line}`) }))
    .filter((x): x is { line: string; row: FixtureOddsRow } => x.row != null);

  type HtftRow = { sel: (typeof HTFT_SELS)[number]; row: FixtureOddsRow };
  const fxHtftRows: HtftRow[] = HTFT_SELS
    .map((sel) => ({ sel, row: pickRow(fixtureOdds, "HALF_FULL_TIME:FULL_TIME", sel) }))
    .filter((x): x is HtftRow => x.row != null);
  const favHtft: HtftRow | null = fxHtftRows.length
    ? fxHtftRows.slice().sort((a, b) => a.row.odds - b.row.odds)[0]
    : null;

  const fxHtH = pickRow(fixtureOdds, "HOME_DRAW_AWAY:FIRST_HALF", "H");
  const fxDnbA = pickRow(fixtureOdds, "DRAW_NO_BET:FULL_TIME", "A");
  const fxDnbH = pickRow(fixtureOdds, "DRAW_NO_BET:FULL_TIME", "H");
  const fxShA = pickRow(fixtureOdds, "HOME_DRAW_AWAY:SECOND_HALF", "A");
  const fxShH = pickRow(fixtureOdds, "HOME_DRAW_AWAY:SECOND_HALF", "H");
  const fxAhA1 = pickRow(fixtureOdds, "ASIAN_HANDICAP:FULL_TIME", "A:-1.0");
  const fxAhH1 = pickRow(fixtureOdds, "ASIAN_HANDICAP:FULL_TIME", "H:-1.0");
  // YENİ: berabere-eksenli sinyaller — Flamengo-Mirassol testinde HT-D/2H-D/HTFT-X/X/CS
  // kombinasyonunun tek başına 1X2'den daha isabetli komşu getirdiği görüldü. Sert veto değil,
  // yumuşak ağırlıklı mesafe olarak ekleniyor (havuzu sıfıra düşürme riski olmasın diye).
  const fxHtD = pickRow(fixtureOdds, "HOME_DRAW_AWAY:FIRST_HALF", "D");
  const fxShD = pickRow(fixtureOdds, "HOME_DRAW_AWAY:SECOND_HALF", "D");
  const fxHtftXX = pickRow(fixtureOdds, "HALF_FULL_TIME:FULL_TIME", "htft:X/X");
  // YENİ: dönüş senaryoları — bir yarıda önde olup diğerinde kaybeden/kazanan maçlar (1/2, 2/1)
  // için ayrı bir eksen. U3LxCw77 (HT 0-1, FT 2-1 — deplasman önde başlayıp ev sahibi çevirdi) testi
  // bu marketlerin comeback/dönüş dinamiğini yakalayabildiğini gösterdi.
  const fxHtft12 = pickRow(fixtureOdds, "HALF_FULL_TIME:FULL_TIME", "htft:1/2");
  const fxHtft21 = pickRow(fixtureOdds, "HALF_FULL_TIME:FULL_TIME", "htft:2/1");

  type Ranked = { event_id: string; score: number };

  // Ranking hesaplamasını bir fonksiyona çıkardık ki adaptif band aramasında
  // tekrar tekrar (farklı liqBand değerleriyle) çağırabilelim.
  function computeRanked(liqBand: number): Ranked[] {
    const out: Ranked[] = [];
    for (const r of stage1Scored) {
      const L = liqByEvent.get(r.event_id);
      const ou25 = L?.get("OVER_UNDER:FULL_TIME:2.5|OVER:2.5");
      const ou35 = L?.get("OVER_UNDER:FULL_TIME:3.5|OVER:3.5");
      const bttsY = L?.get("BOTH_TEAMS_TO_SCORE:FULL_TIME|btts:YES");
      const bttsN = L?.get("BOTH_TEAMS_TO_SCORE:FULL_TIME|btts:NO");
      const htH = L?.get("HOME_DRAW_AWAY:FIRST_HALF|H");
      if (fxHtH && htH && rel(htH.odds, fxHtH.odds) > 0.08) continue;

      const dnbA = L?.get("DRAW_NO_BET:FULL_TIME|A");
      const dnbH = L?.get("DRAW_NO_BET:FULL_TIME|H");
      const shA = L?.get("HOME_DRAW_AWAY:SECOND_HALF|A");
      const shH = L?.get("HOME_DRAW_AWAY:SECOND_HALF|H");
      const ahA1 = L?.get("ASIAN_HANDICAP:FULL_TIME|A:-1.0");
      const ahH1 = L?.get("ASIAN_HANDICAP:FULL_TIME|H:-1.0");

      // YENİ: mutlak puan eşiği yerine yüzdesel steam kontrolü — düşük oranlarda (DNB ~1.3)
      // ve yüksek oranlarda (DNB ~8.0) tutarlı davranır.
      if (steamDownPct(fxDnbA, STEAM_TRIGGER_PCT) && dnbA && !steamDownPct(dnbA, STEAM_MATCH_PCT)) continue;
      if (steamDownPct(fxDnbH, STEAM_TRIGGER_PCT) && dnbH && !steamDownPct(dnbH, STEAM_MATCH_PCT)) continue;
      if (steamDownPct(fxShA, STEAM_TRIGGER_PCT) && shA && !steamDownPct(shA, STEAM_MATCH_PCT)) continue;
      if (steamDownPct(fxShH, STEAM_TRIGGER_PCT) && shH && !steamDownPct(shH, STEAM_MATCH_PCT)) continue;
      if (steamDownPct(fxAhA1, STEAM_TRIGGER_PCT_AH) && ahA1 && !steamDownPct(ahA1, STEAM_MATCH_PCT_AH)) continue;
      if (steamDownPct(fxAhH1, STEAM_TRIGGER_PCT_AH) && ahH1 && !steamDownPct(ahH1, STEAM_MATCH_PCT_AH)) continue;

      if (!ou25 || !bttsY) continue;
      if (prof.ou25 && rel(ou25.odds, prof.ou25.odds) > liqBand) continue;
      if (prof.ou35) {
        if (!ou35 || rel(ou35.odds, prof.ou35.odds) > liqBand) continue;
      }
      if (prof.bttsYes && rel(bttsY.odds, prof.bttsYes.odds) > liqBand) continue;
      if ((prof.family === "CLEAN_AWAY" || prof.family === "AWAY_SHUTOUT") && bttsN && prof.bttsNo) {
        if (rel(bttsN.odds, prof.bttsNo.odds) > liqBand) continue;
      }

      const parts: number[] = [r.d1];
      parts.push((1.3 * rel(ou25.odds, prof.ou25?.odds ?? ou25.odds)) ** 2);
      if (prof.ou35 && ou35) parts.push((1.4 * rel(ou35.odds, prof.ou35.odds)) ** 2);
      parts.push((1.4 * rel(bttsY.odds, prof.bttsYes?.odds ?? bttsY.odds)) ** 2);
      if (fxDnbA && dnbA) parts.push((1.2 * rel(dnbA.odds, fxDnbA.odds)) ** 2);
      if (fxShA && shA) parts.push((1.15 * rel(shA.odds, fxShA.odds)) ** 2);
      if (fxAhA1 && ahA1) parts.push((1.1 * rel(ahA1.odds, fxAhA1.odds)) ** 2);
      if (fxHtH && htH) parts.push((1.2 * rel(htH.odds, fxHtH.odds)) ** 2);

      // YENİ: HT-D / 2H-D / HTFT-X/X — berabere-ekseni mesafesi
      const htD = L?.get("HOME_DRAW_AWAY:FIRST_HALF|D");
      if (fxHtD && htD) parts.push((1.1 * rel(htD.odds, fxHtD.odds)) ** 2);
      const shD = L?.get("HOME_DRAW_AWAY:SECOND_HALF|D");
      if (fxShD && shD) parts.push((1.1 * rel(shD.odds, fxShD.odds)) ** 2);
      const htftXX = L?.get("HALF_FULL_TIME:FULL_TIME|htft:X/X");
      if (fxHtftXX && htftXX) parts.push((1.15 * rel(htftXX.odds, fxHtftXX.odds)) ** 2);
      const htft12 = L?.get("HALF_FULL_TIME:FULL_TIME|htft:1/2");
      if (fxHtft12 && htft12) parts.push((1.2 * rel(htft12.odds, fxHtft12.odds)) ** 2);
      const htft21 = L?.get("HALF_FULL_TIME:FULL_TIME|htft:2/1");
      if (fxHtft21 && htft21) parts.push((1.2 * rel(htft21.odds, fxHtft21.odds)) ** 2);

      // CORRECT_SCORE ladder ortalama mesafesi
      if (fxCsRows.length) {
        const csDists: number[] = [];
        for (const { line, row } of fxCsRows) {
          const cand = L?.get(`CORRECT_SCORE:FULL_TIME|score:${line}`);
          if (cand) csDists.push(rel(cand.odds, row.odds));
        }
        if (csDists.length >= 6) {
          const csAvg = csDists.reduce((a, b) => a + b, 0) / csDists.length;
          parts.push((0.9 * csAvg) ** 2);
        }
      }

      // fixture'ın favori HTFT kombinasyonu üzerinden mesafe
      if (favHtft) {
        const candHtft = L?.get(`HALF_FULL_TIME:FULL_TIME|${favHtft.sel}`);
        if (candHtft) parts.push((1.2 * rel(candHtft.odds, favHtft.row.odds)) ** 2);
      }

      out.push({ event_id: r.event_id, score: Math.sqrt(parts.reduce((s, x) => s + x, 0)) });
    }
    out.sort((x, y) => x.score - y.score);
    return out;
  }

  // --- YENİ: adaptif band araması. Varsayılan bandtan başlar; aday sayısı hedefin
  // dışındaysa merdivende bir sonraki (uygun yöndeki) adıma geçer. "Akıllıca" davranışı:
  // çok az aday -> bandı gevşet (daha fazla tarihsel maç kabul et)
  // çok fazla aday -> bandı sıkılaştır (daha spesifik/benzer maçlara odaklan)
  const defaultIdx = LIQ_BAND_STEPS.indexOf(LIQ_BAND_DEFAULT);
  let bandIdx = defaultIdx;
  let ranked = computeRanked(LIQ_BAND_STEPS[bandIdx]);
  let usedLiqBand = LIQ_BAND_STEPS[bandIdx];

  if (ranked.length < LIQ_MIN_SAMPLE) {
    // yukarı doğru (daha geniş bantlara) tara, yeterli örnekleme ulaşınca dur
    for (let i = bandIdx + 1; i < LIQ_BAND_STEPS.length; i++) {
      const attempt = computeRanked(LIQ_BAND_STEPS[i]);
      bandIdx = i;
      ranked = attempt;
      usedLiqBand = LIQ_BAND_STEPS[i];
      if (attempt.length >= LIQ_MIN_SAMPLE) break;
    }
  } else if (ranked.length > LIQ_MAX_SAMPLE) {
    // aşağı doğru (daha dar bantlara) tara, hedef aralığa girene kadar
    for (let i = bandIdx - 1; i >= 0; i--) {
      const attempt = computeRanked(LIQ_BAND_STEPS[i]);
      if (attempt.length < LIQ_MIN_SAMPLE) break; // çok daraltma, örneklem tekrar azalıyor
      bandIdx = i;
      ranked = attempt;
      usedLiqBand = LIQ_BAND_STEPS[i];
      if (attempt.length <= LIQ_MAX_SAMPLE) break;
    }
  }

  const shortlist = ranked.slice(0, 40);
  const ids = shortlist.map((s) => s.event_id);

  let scored: { event_id: string; score: number; hs: number; as: number }[] = [];
  if (ids.length) {
    const evs = (await sql.unsafe(
      `SELECT id, home_score, away_score FROM events
       WHERE id = ANY($1::text[]) AND home_score IS NOT NULL AND away_score IS NOT NULL`,
      [ids] as never[],
    )) as { id: string; home_score: number; away_score: number }[];
    const evMap = new Map(evs.map((e) => [e.id, e]));
    for (const s of shortlist) {
      const e = evMap.get(s.event_id);
      if (!e) continue;
      scored.push({
        event_id: s.event_id,
        score: s.score,
        hs: Number(e.home_score),
        as: Number(e.away_score),
      });
    }
  }

  const ouClose = prof.ou25?.odds ?? null;
  const ouOpen = prof.ou25?.opening ?? null;
  const goalShut =
    ouOpen != null && ouClose != null && ouClose > ouOpen + 0.04;
  const goalOpen =
    ouOpen != null && ouClose != null && ouClose < ouOpen - 0.04;
  const bttsNoFav =
    prof.bttsNo != null &&
    prof.bttsYes != null &&
    prof.bttsNo.odds <= prof.bttsYes.odds;
  const pruned = scored.filter((s) => {
    const tot = s.hs + s.as;
    const low = tot <= 1 || `${s.hs}-${s.as}` === "1-0" || `${s.hs}-${s.as}` === "0-0";
    const burst = tot >= 5;
    // YENİ: burst artık koşulsuz elenmiyor — sadece fixture'ın kendi OU sinyali
    // gerçekten düşük gollü bir maça işaret ediyorsa (goalShut + uzun over oranı)
    // 5+ gollü tarihsel komşular havuzdan çıkarılıyor. Aksi halde (fixture yüksek
    // gollü bir profil gösteriyorsa) burst'ler havuzda kalmaya devam eder — "7 gollü
    // maça da yakın olmalı" ihtiyacı tam olarak bu simetriyi gerektiriyor.
    if (goalShut && ouClose != null && ouClose >= 2.2) {
      if (burst) return false;
    }
    if (goalOpen && ouClose != null && ouClose <= 1.62) {
      if (low) return false;
    }
    if (prof.family === "HOME_BURST" && low) return false;
    return true;
  });
  const usedScores = pruned.length ? pruned : scored;

  // --- YENİ: regime (open/shut) oylamasını sadece en yakın STAGE2_POOL komşuya kısıtla ---
  // `usedScores` zaten `score`'a göre sıralı geliyor (scored, shortlist sırasını korur, shortlist ranked'a göre sıralı).
  // Böylece CS/HTFT ile iyileşen sıralama artık call/alt'a da yansır; 40 komşuluk düz oy çoğunluğu yerine
  // en benzer 12 komşu oy kullanır.
  const regimePool = usedScores.slice(0, STAGE2_POOL);

  function freqOf(rows: typeof scored): ScoreBucket[] {
    const freq = new Map<string, number>();
    for (const s of rows) {
      const k = `${s.hs}-${s.as}`;
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
    return [...freq.entries()]
      .map(([scoreline, n]) => ({ scoreline, n }))
      .sort((a, b) => b.n - a.n || a.scoreline.localeCompare(b.scoreline));
  }

  const openRows = regimePool.filter((s) => s.hs > 0 && s.as > 0 && s.hs + s.as >= 3);
  const shutRows = regimePool.filter((s) => s.hs === 0 || s.as === 0 || s.hs + s.as <= 2);
  const regimes: RegimeBuckets = {
    open: freqOf(openRows).slice(0, 6),
    shut: freqOf(shutRows).slice(0, 6),
    openN: openRows.length,
    shutN: shutRows.length,
  };
  const buckets = freqOf(scored);

  const pred = predictScoreline(fixtureOdds);
  const split = regimes.openN + regimes.shutN;
  const openShare = split ? regimes.openN / split : 0.5;
  const shutShare = split ? regimes.shutN / split : 0.5;

  const core = regimePool.filter((s) => s.hs + s.as < 5).slice(0, 6);
  if (core.length) {
    const callLine = `${core[0].hs}-${core[0].as}`;
    const altRow = core.find((s) => `${s.hs}-${s.as}` !== callLine);
    pred.primary = callLine;
    pred.backup = altRow ? `${altRow.hs}-${altRow.as}` : pred.backup;
    pred.reason = `ilk ${core.length} mesafe (5+ gol atıldı): ${core
      .map((s) => `${s.hs}-${s.as}`)
      .join(", ")}`;
  }

  const top = usedScores.slice(0, Math.max(K_MIN, Math.min(limit, STAGE2_POOL))).map((s) => ({
    event_id: s.event_id,
    score: s.score,
  }));
  const insights: MarketInsight[] = [];
  if (scored.length) {
    const d = scored.length;
    const add = (label: string, n: number) => {
      insights.push({ label, n, d, pct: Math.round((100 * n) / d) });
    };
    add("ev kazanır", scored.filter((s) => s.hs > s.as).length);
    add("ev 2+ fark", scored.filter((s) => s.hs - s.as >= 2).length);
    add("ev 3.5+ gol (ev golleri)", scored.filter((s) => s.hs >= 4).length);
    add("maç 3.5 üst", scored.filter((s) => s.hs + s.as > 3.5).length);
    add("BTTS", scored.filter((s) => s.hs > 0 && s.as > 0).length);
    add("clean sheet ev", scored.filter((s) => s.as === 0 && s.hs > 0).length);
  }

  const board = readBoard({ fixtureOdds, regimes });
  pred.primary = board.call;
  pred.backup = board.alt;
  pred.reason = board.reason;

  return {
    matchedCount: scored.length,
    samples: top,
    usedCodes: [
      "1X2_FT",
      "OU25",
      "OU35",
      "BTTS",
      "DNB",
      "2H_1X2",
      "AH_-1",
      "STEAM_SIGN",
      "REGIME_A_B",
      "CS_LADDER",
      "HTFT_FAV",
      `FAMILY:${prof.family}`,
      `LIQ_BAND:${usedLiqBand}`,
    ],
    family: pred.family,
    buckets,
    regimes,
    prediction: { primary: pred.primary, backup: pred.backup, reason: pred.reason },
    predictionV2: predictScorelineV2(fixtureOdds),
    board,
    insights,
    durationMs: Date.now() - t0,
    usedLiqBand,
  };
}
