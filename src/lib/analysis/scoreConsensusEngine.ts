import type { CompactOddsRow } from "@/lib/archiveCache";

/**
 * "Skor Konsensüs Motoru" — V8.
 *
 * Kaynak: Ali'nin ad-hoc test_v8_engine.py betiği. marketSignals.ts ile AYNI
 * şekilde saf client-side (ek API isteği YOK) çalışır: seçilen maçın kendi
 * `odds`/`bookmakers` verisinden hesaplanır.
 *
 * V7'den (önceki sürüm) farkı: genel "en hacimli 8 skor" tablosu yerine, script
 * ile birebir aynı 3 KOLTUKLU PORTFÖY üretir:
 *   1) Konsensüs / Favori   — 1X2 favorisi tarafındaki en güçlü skor
 *   2) Piyasa Temposu (BTTS Sentez) — kalan skorlardan en güçlüsü; KG Var
 *      piyasası çok baskılıysa (<=1.65) sadece "her iki takım da gol atar"
 *      skorlarına daralır
 *   3) Türev Kırılma / Hedge Anomali — favori DIŞI tarafta, drop*sqrt(prob)
 *      sıralamasına göre en belirgin oran kırılması
 *
 * Asian Handicap / HT-FT dönüş / "clear handicap" mantığı V8'de YOK — onun
 * yerine BTTS sentezi (is_btts_heavy) var. Bu, script'teki tasarım kararı;
 * burada da aynen korunuyor.
 *
 * NOT — YORUM SINIRI: bu bir "kesin skor tahmini" DEĞİL, bürolar arası
 * konsensüs + hacim izlenimini özetleyen bir portföy. Az büro veri verdiğinde
 * (confidence: "low") tek bir aykırı fiyat seçimi domine edebilir.
 */

export type ScoreConsensusPickRole = "favorite" | "tempo" | "hedge";

export type ScoreConsensusPick = {
  role: ScoreConsensusPickRole;
  score: string; // "2:1" formatında
  totalGoals: number;
  side: "H" | "D" | "A";
  medianOdds: number;
  dropPct: number; // (medyan-min)/medyan * 100
  probPct: number; // büro-arası implied probability medyanı, yüzde
  powerScore: number; // sıralama puanı
  bookmakerCount: number; // bu skoru veren büro sayısı
};

export type ScoreConsensus = {
  bookmakerCount: number; // CS için kullanılan (>= MIN_SCORES_PER_BOOKMAKER skor veren) büro sayısı
  confidence: "high" | "low";
  home1x2Prob: number; // yüzde
  draw1x2Prob: number; // yüzde
  away1x2Prob: number; // yüzde
  over25Prob: number; // yüzde
  under25Prob: number; // yüzde
  bttsYesOdds: number;
  bttsNoOdds: number;
  isBttsHeavy: boolean; // KG Var medyan oranı <= 1.65
  favoriteSide: "H" | "A";
  picks: ScoreConsensusPick[]; // favorite + (varsa) tempo + hedge, bu sırayla
  actualScore: string | null; // maç oynandıysa gerçek skor, oynanmadıysa null
};

const MIN_SCORES_PER_BOOKMAKER = 8; // script: len(scores) < 8 -> o büro atlanır
const MIN_QUOTES_PER_SCORE = 4; // script: len(p_list) < 4 / len(r) < 4 -> o skor atlanır
export const LOW_CONFIDENCE_BM_COUNT = 6;
const GAMMA = 1.18;
const BTTS_HEAVY_THRESHOLD = 1.65;
const PANIC_DROP_THRESHOLD = 0.45;
const PANIC_DROP_MIN_BOOKMAKERS = 8;
const NON_PANIC_MAX_ODDS = 55.0;
const NON_PANIC_MIN_PROB_PCT = 1.0;

function parseOddsNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1.01 ? n : null;
}

function pickOddsValue(opening: unknown, current: unknown): number | null {
  return parseOddsNum(current) ?? parseOddsNum(opening);
}

function isActive(active: unknown): boolean {
  return !(active === false || active === 0 || active === "0" || active === "false");
}

/** HOME_DRAW_AWAY side eşleşmesi — tableRows.ts'teki ile aynı defansif kural. */
function matchHdaSide(side: string, want: "H" | "D" | "A"): boolean {
  return side === want || side.startsWith(`${want}:`);
}

/** BOTH_TEAMS_TO_SCORE side eşleşmesi — tableRows.ts'teki ile aynı defansif kural. */
function matchBttsSide(side: string, wantYes: boolean): boolean {
  return wantYes
    ? /btts:(YES|True)$/i.test(side) || side === "YES" || side === "True"
    : /btts:(NO|False)$/i.test(side) || side === "NO" || side === "False";
}

/** "score:2:1" ya da (bkz. tableRows.ts'teki aynı defansif kontrol) "2:1" -> {score:"2:1", h:2, a:1} | null */
function parseScoreToken(sideTok: string): { score: string; h: number; a: number } | null {
  const stripped = sideTok.startsWith("score:") ? sideTok.slice(6) : sideTok;
  const parts = stripped.split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const a = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) return null;
  return { score: `${h}:${a}`, h, a };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

type PoolRow = {
  score: string;
  h: number;
  a: number;
  tot: number;
  side: "H" | "D" | "A";
  medOdd: number;
  dropPct: number;
  probPct: number;
  power: number;
  bookmakerCount: number;
};

function toPick(row: PoolRow, role: ScoreConsensusPickRole): ScoreConsensusPick {
  return {
    role,
    score: row.score,
    totalGoals: row.tot,
    side: row.side,
    medianOdds: row.medOdd,
    dropPct: row.dropPct,
    probPct: row.probPct,
    powerScore: row.power,
    bookmakerCount: row.bookmakerCount,
  };
}

export function computeScoreConsensus(
  odds: CompactOddsRow[] | null | undefined,
  bookmakers: Record<string, string> | null | undefined,
  homeScore?: string | number | null,
  awayScore?: string | number | null,
): ScoreConsensus | null {
  if (!odds?.length) return null;

  const hdaFt: Record<"H" | "D" | "A", number[]> = { H: [], D: [], A: [] };
  const ouLines = { over25: [] as number[], under25: [] as number[] };
  const btts = { yes: [] as number[], no: [] as number[] };
  // bmId -> skor -> oran
  const csByBm = new Map<string, Map<string, number>>();

  for (const row of odds) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [bmId, mtype, scope, sideTok, opening, current, active] = row;
    if (String(scope) !== "FULL_TIME" || !isActive(active)) continue;
    const val = pickOddsValue(opening, current);
    if (val == null) continue;
    const side = String(sideTok);
    const type = String(mtype);

    if (type === "HOME_DRAW_AWAY") {
      if (matchHdaSide(side, "H")) hdaFt.H.push(val);
      else if (matchHdaSide(side, "D")) hdaFt.D.push(val);
      else if (matchHdaSide(side, "A")) hdaFt.A.push(val);
      continue;
    }
    if (type === "OVER_UNDER") {
      if (side === "OVER:2.5") ouLines.over25.push(val);
      else if (side === "UNDER:2.5") ouLines.under25.push(val);
      continue;
    }
    if (type === "BOTH_TEAMS_TO_SCORE") {
      if (matchBttsSide(side, true)) btts.yes.push(val);
      else if (matchBttsSide(side, false)) btts.no.push(val);
      continue;
    }
    if (type === "CORRECT_SCORE") {
      const parsed = parseScoreToken(side);
      if (!parsed) continue;
      const key = String(bmId);
      let m = csByBm.get(key);
      if (!m) {
        m = new Map();
        csByBm.set(key, m);
      }
      m.set(parsed.score, val);
    }
  }

  // --- 1X2 implied probability (vig normalize) ---
  const medH = hdaFt.H.length ? median(hdaFt.H) : 2.5;
  const medD = hdaFt.D.length ? median(hdaFt.D) : 3.2;
  const medA = hdaFt.A.length ? median(hdaFt.A) : 2.8;
  const invHda = 1 / medH + 1 / medD + 1 / medA;
  const pH = 1 / medH / invHda;
  const pD = 1 / medD / invHda;
  const pA = 1 / medA / invHda;

  // --- Over/Under 2.5 implied probability ---
  const medOver = ouLines.over25.length ? median(ouLines.over25) : 1.9;
  const medUnder = ouLines.under25.length ? median(ouLines.under25) : 1.9;
  const pOver = 1 / medOver / (1 / medOver + 1 / medUnder);
  const pUnder = 1 - pOver;

  // --- BTTS ---
  const medBy = btts.yes.length ? median(btts.yes) : 1.85;
  const medBn = btts.no.length ? median(btts.no) : 1.85;
  const isBttsHeavy = medBy <= BTTS_HEAVY_THRESHOLD;

  // --- Sadece yeterli skor veren büroları normalize et ---
  const probsByScore = new Map<string, number[]>();
  const oddsByScore = new Map<string, number[]>();
  let usedBmCount = 0;

  for (const [, scores] of csByBm) {
    if (scores.size < MIN_SCORES_PER_BOOKMAKER) continue;
    usedBmCount += 1;
    let powerSum = 0;
    for (const o of scores.values()) powerSum += Math.pow(1 / o, GAMMA);
    if (powerSum <= 0) continue;
    for (const [score, o] of scores) {
      const p = Math.pow(1 / o, GAMMA) / powerSum;
      if (!probsByScore.has(score)) probsByScore.set(score, []);
      probsByScore.get(score)!.push(p);
      if (!oddsByScore.has(score)) oddsByScore.set(score, []);
      oddsByScore.get(score)!.push(o);
    }
  }

  // --- Skor havuzu (script: scores_pool) ---
  const pool: PoolRow[] = [];
  for (const [score, pList] of probsByScore) {
    if (pList.length < MIN_QUOTES_PER_SCORE) continue;
    const rOdds = oddsByScore.get(score)!;
    if (rOdds.length < MIN_QUOTES_PER_SCORE) continue;

    const parts = score.split(":");
    const h = Number(parts[0]);
    const a = Number(parts[1]);

    const medOdd = median(rOdds);
    const minOdd = Math.min(...rOdds);
    const drop = medOdd > 0 ? (medOdd - minOdd) / medOdd : 0;
    const csP = median(pList);

    // Sığ büro panik-drop koruması: en az 8 büro yoksa ekstrem drop'u yalan kabul et
    const isPanic = drop >= PANIC_DROP_THRESHOLD && rOdds.length >= PANIC_DROP_MIN_BOOKMAKERS;
    if (!isPanic && (medOdd > NON_PANIC_MAX_ODDS || csP * 100 < NON_PANIC_MIN_PROB_PCT)) continue;

    const side: "H" | "D" | "A" = h > a ? "H" : h === a ? "D" : "A";
    const tot = h + a;

    // BTTS Sinerji Cezası: KG Var <=1.65 iken 0 çeken skorlara ağır ceza
    const bttsPenalty = isBttsHeavy && (h === 0 || a === 0) ? 0.1 : 1.0;

    const power = csP * 100 * bttsPenalty * (1 + drop * 2.0);

    pool.push({
      score,
      h,
      a,
      tot,
      side,
      medOdd: Math.round(medOdd * 100) / 100,
      dropPct: Math.round(drop * 1000) / 10,
      probPct: Math.round(csP * 10000) / 100,
      power: Math.round(power * 100) / 100,
      bookmakerCount: rOdds.length,
    });
  }

  if (pool.length === 0) return null;

  const favoriteSide: "H" | "A" = pH >= pA ? "H" : "A";
  const picks: ScoreConsensusPick[] = [];
  const used = new Set<string>();

  // 1. KOLTUK: Konsensüs / Favori
  const favPool = pool.filter((r) => r.side === favoriteSide).sort((x, y) => y.power - x.power);
  const pick1 = favPool[0] ?? pool[0];
  picks.push(toPick(pick1, "favorite"));
  used.add(pick1.score);

  // 2. KOLTUK: Piyasa Temposu (BTTS Sentez)
  let tempoPool = pool.filter((r) => !used.has(r.score));
  if (isBttsHeavy) tempoPool = tempoPool.filter((r) => r.h >= 1 && r.a >= 1);
  tempoPool = [...tempoPool].sort((x, y) => y.power - x.power);
  const pick2 = tempoPool[0];
  if (pick2) {
    picks.push(toPick(pick2, "tempo"));
    used.add(pick2.score);
  }

  // 3. KOLTUK: Türev Kırılma / Hedge Anomali
  let counterPool = pool.filter((r) => !used.has(r.score) && r.side !== favoriteSide);
  if (isBttsHeavy) counterPool = counterPool.filter((r) => r.h >= 1 && r.a >= 1);
  counterPool = [...counterPool].sort(
    (x, y) => y.dropPct * Math.sqrt(y.probPct) - x.dropPct * Math.sqrt(x.probPct),
  );
  // Not: script'teki gibi counterPool boşsa TÜM havuzdan (used'a bakmaksızın)
  // en güçlü skora düşülüyor — bu, pick1 ile aynı skorun tekrar seçilebildiği
  // bilinen bir davranış; V8 test script'iyle birebir aynı tutuldu.
  const pick3 = counterPool[0] ?? [...pool].sort((x, y) => y.power - x.power)[0];
  picks.push(toPick(pick3, "hedge"));

  const hs = homeScore != null ? Number(homeScore) : null;
  const as_ = awayScore != null ? Number(awayScore) : null;
  const actualScore =
    hs != null && as_ != null && Number.isFinite(hs) && Number.isFinite(as_)
      ? `${hs}:${as_}`
      : null;

  return {
    bookmakerCount: usedBmCount,
    confidence: usedBmCount >= LOW_CONFIDENCE_BM_COUNT ? "high" : "low",
    home1x2Prob: Math.round(pH * 1000) / 10,
    draw1x2Prob: Math.round(pD * 1000) / 10,
    away1x2Prob: Math.round(pA * 1000) / 10,
    over25Prob: Math.round(pOver * 1000) / 10,
    under25Prob: Math.round(pUnder * 1000) / 10,
    bttsYesOdds: Math.round(medBy * 100) / 100,
    bttsNoOdds: Math.round(medBn * 100) / 100,
    isBttsHeavy,
    favoriteSide,
    picks,
    actualScore,
  };
}
