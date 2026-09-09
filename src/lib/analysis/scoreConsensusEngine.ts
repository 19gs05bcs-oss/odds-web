import type { CompactOddsRow } from "@/lib/archiveCache";

/**
 * "Skor Konsensüs Motoru" (Correct-Score Consensus / Volume Engine).
 *
 * Kaynak: Ali'nin ad-hoc test_sporting_galatasaray.py betiği — orada Supabase'ten
 * tek bir maç çekilip CORRECT_SCORE + OVER_UNDER 2.5 oranlarından hacim-uyumlu bir
 * skor sıralaması üretiliyordu. Burada aynı mantık, marketSignals.ts ile AYNI
 * şekilde saf client-side (ek API isteği YOK) çalışacak biçimde TS'e taşındı:
 * seçilen maçın kendi `odds`/`bookmakers` verisinden hesaplanır.
 *
 * Yöntem özeti:
 *  1) Over/Under 2.5 medyan oranlarından üst/alt 2.5 gol olasılığı çıkarılır
 *     (2 yönlü implied probability, vig normalize edilmiş).
 *  2) Her büronun CORRECT_SCORE (FULL_TIME) skorları toplanır — en az
 *     MIN_SCORES_PER_BOOKMAKER farklı skor veren bürolar dikkate alınır.
 *  3) Büro başına implied probability^GAMMA / toplam ile normalize edilmiş bir
 *     "hacim payı" hesaplanır; skor bazında bürolar arası medyan + CV
 *     (tutarlılık) + medyan-min "drop" (para girişi izlenimi) çıkarılır.
 *  4) Toplam gol sayısı, Over/Under 2.5 olasılığıyla ağırlıklandırılıp
 *     (O/U piyasasıyla TUTARLI skorlar öne çıksın diye) nihai bir puan
 *     üretilir ve azalan sırada sıralanır.
 *
 * NOT — YORUM SINIRI: marketSignals.ts'teki notla aynı: bu "kesin skor tahmini"
 * DEĞİL, bürolar arası konsensüs + hacim izlenimini özetleyen bir sıralama.
 * Az büro veri verdiğinde (confidence: "low") tek bir aykırı fiyat sıralamayı
 * domine edebilir.
 */

export type ScoreConsensusRow = {
  score: string; // "2:1" formatında
  totalGoals: number;
  value: number; // sıralama puanı — yüksek = daha "hacimli" konsensüs
  medianOdds: number;
  minOdds: number;
  dropPct: number; // (medyan-min)/medyan * 100
  bookmakerCount: number; // bu skoru veren (ve eşiği geçen) büro sayısı
  cv: number; // bürolar-arası implied probability tutarsızlığı, yüzde
};

export type ScoreConsensus = {
  bookmakerCount: number; // CS için kullanılan (>= MIN_SCORES_PER_BOOKMAKER skor veren) büro sayısı
  over25Prob: number; // yüzde
  under25Prob: number; // yüzde
  confidence: "high" | "low";
  rankings: ScoreConsensusRow[]; // azalan value sırası, en fazla TOP_N
  actualScore: string | null; // maç oynandıysa gerçek skor, oynanmadıysa null
};

const MIN_BOOKMAKERS_FOR_CS = 3; // test script: len(bm_scores) < 3 -> iptal
const MIN_SCORES_PER_BOOKMAKER = 8; // test script: len(scores) < 8 -> o büro atlanır
const MIN_QUOTES_PER_SCORE = 3; // test script: len(p_list) < 3 -> o skor atlanır
export const LOW_CONFIDENCE_BM_COUNT = 6;
const GAMMA = 1.18;
const TOP_N = 8;

// marketSignals.ts'teki parseOddsNum/pickOddsValue ile AYNI kural: değerler
// bazen string gelebilir, current boşsa opening'e düşülür.
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

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function computeScoreConsensus(
  odds: CompactOddsRow[] | null | undefined,
  bookmakers: Record<string, string> | null | undefined,
  homeScore?: string | number | null,
  awayScore?: string | number | null,
): ScoreConsensus | null {
  if (!odds?.length) return null;
  const bmNames = bookmakers ?? {};
  const bmName = (id: number) => bmNames[String(id)] ?? `BM_${id}`;

  const over25: number[] = [];
  const under25: number[] = [];
  // büro adı -> skor -> oran
  const bmScores = new Map<string, Map<string, number>>();

  for (const row of odds) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [bmId, mtype, scope, sideTok, opening, current, active] = row;
    if (String(scope) !== "FULL_TIME" || !isActive(active)) continue;
    const val = pickOddsValue(opening, current);
    if (val == null) continue;

    if (String(mtype) === "OVER_UNDER") {
      const side = String(sideTok);
      if (side === "OVER:2.5") over25.push(val);
      else if (side === "UNDER:2.5") under25.push(val);
      continue;
    }

    if (String(mtype) === "CORRECT_SCORE") {
      const parsed = parseScoreToken(String(sideTok));
      if (!parsed) continue;
      const name = bmName(Number(bmId));
      let m = bmScores.get(name);
      if (!m) {
        m = new Map();
        bmScores.set(name, m);
      }
      m.set(parsed.score, val);
    }
  }

  if (bmScores.size < MIN_BOOKMAKERS_FOR_CS) return null;

  // --- Over/Under 2.5 implied probability (vig normalize) ---
  const medOver = over25.length ? median(over25) : 1.9;
  const medUnder = under25.length ? median(under25) : 1.9;
  const invSum = 1 / medOver + 1 / medUnder;
  const pOver = 1 / medOver / invSum;
  const pUnder = 1 / medUnder / invSum;

  // --- Sadece yeterli skor veren büroları normalize et ---
  const probsByScore = new Map<string, number[]>();
  const oddsByScore = new Map<string, number[]>();
  let usedBmCount = 0;

  for (const [, scores] of bmScores) {
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

  if (usedBmCount < MIN_BOOKMAKERS_FOR_CS) return null;

  const rankings: ScoreConsensusRow[] = [];
  for (const [score, pList] of probsByScore) {
    if (pList.length < MIN_QUOTES_PER_SCORE) continue;
    const parts = score.split(":");
    const totalGoals = Number(parts[0]) + Number(parts[1]);

    const medP = median(pList);
    const m = mean(pList);
    const sd = stdev(pList, m);
    const cv = m > 0 ? (sd / m) * 100 : 0;

    const rOdds = oddsByScore.get(score)!;
    const medOdd = median(rOdds);
    const minOdd = Math.min(...rOdds);
    const drop = medOdd > 0 ? (medOdd - minOdd) / medOdd : 0;

    // Over/Under piyasasıyla tutarlılık ağırlığı: 3+ gollü skorlar Over 2.5,
    // 0-1-2 gollü skorlar Under 2.5 piyasasına göre ölçeklenir.
    const volFactor = totalGoals >= 3 ? pOver / 0.5 : pUnder / 0.5;
    const dampedDrop = drop * (1 / Math.log2(Math.max(medOdd, 2)));

    const value = medP * 100 * volFactor * (1 + dampedDrop * 3) * (1 + cv / 15);

    rankings.push({
      score,
      totalGoals,
      value: Math.round(value * 100) / 100,
      medianOdds: Math.round(medOdd * 100) / 100,
      minOdds: Math.round(minOdd * 100) / 100,
      dropPct: Math.round(drop * 1000) / 10,
      bookmakerCount: pList.length,
      cv: Math.round(cv * 10) / 10,
    });
  }

  rankings.sort((a, b) => b.value - a.value);

  const hs = homeScore != null ? Number(homeScore) : null;
  const as_ = awayScore != null ? Number(awayScore) : null;
  const actualScore =
    hs != null && as_ != null && Number.isFinite(hs) && Number.isFinite(as_)
      ? `${hs}:${as_}`
      : null;

  return {
    bookmakerCount: usedBmCount,
    over25Prob: Math.round(pOver * 1000) / 10,
    under25Prob: Math.round(pUnder * 1000) / 10,
    confidence: usedBmCount >= LOW_CONFIDENCE_BM_COUNT ? "high" : "low",
    rankings: rankings.slice(0, TOP_N),
    actualScore,
  };
}
