import type { CompactOddsRow } from "@/lib/archiveCache";

export type ScoreConsensusSlot = {
  score: string;
  marketOdds: number | null;
  openingOdds: number | null;
  driftVelocity: number;
  power: number;
  tier: "core" | "insurance";
  isActual: boolean;
};

export type ScoreConsensus = {
  regimeCode: string;
  regimeLabel: string;
  confidenceLabel: string;
  homeProb: number;
  drawProb: number;
  awayProb: number;
  over25Prob: number;
  under25Prob: number;
  bttsYesProb: number;
  portfolio: ScoreConsensusSlot[];
  actualScore: string | null;
  hit3: boolean | null;
  hit4: boolean | null;
};

const FALLBACK_H = 2.5;
const FALLBACK_D = 3.4;
const FALLBACK_A = 2.8;

function parseOddsNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1.01 ? n : null;
}

function isActive(active: unknown): boolean {
  return !(active === false || active === 0 || active === "0" || active === "false");
}

function parseScoreToken(sideTok: string): { score: string; h: number; a: number } | null {
  const stripped = sideTok.toLowerCase().startsWith("score:") ? sideTok.slice(6) : sideTok;
  const parts = stripped.replace("-", ":").split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const a = Number(parts[1]);
  if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) return null;
  return { score: `${h}:${a}`, h, a };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function impliedTwo(o: number, u: number): [number, number] {
  const io = 1 / o;
  const iu = 1 / u;
  return [io / (io + iu), iu / (io + iu)];
}

export function computeScoreConsensus(
  odds: CompactOddsRow[] | null | undefined,
  bookmakers: Record<string, string> | null | undefined,
  homeScore?: string | number | null,
  awayScore?: string | number | null,
): ScoreConsensus | null {
  if (!odds?.length) return null;

  const hOdds: number[] = [];
  const dOdds: number[] = [];
  const aOdds: number[] = [];
  const bttsYesOdds: number[] = [];
  const bttsNoOdds: number[] = [];
  const over25Odds: number[] = [];
  const under25Odds: number[] = [];

  const ftCsCurrent = new Map<string, number[]>();
  const ftCsOpening = new Map<string, number[]>();
  const htCsCurrent = new Map<string, number[]>();

  for (const row of odds) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [, mtype, scope, sideTok, opening, current, active] = row;
    if (!isActive(active)) continue;

    const curVal = parseOddsNum(current);
    const opVal = parseOddsNum(opening);
    const effVal = curVal ?? opVal;
    if (effVal == null) continue;

    const type = String(mtype).toUpperCase();
    const scp = String(scope).toUpperCase();
    const side = String(sideTok).toUpperCase();

    // 1X2 Piyasa Dağılımı
    if ((type === "HOME_DRAW_AWAY" || type === "1X2") && (scp === "FULL_TIME" || !scp.includes("HALF"))) {
      if (side === "H" || side === "1") hOdds.push(effVal);
      else if (side === "D" || side === "X") dOdds.push(effVal);
      else if (side === "A" || side === "2") aOdds.push(effVal);
      continue;
    }

    // 2.5 Gol Baremi
    if ((type.includes("OVER_UNDER") || type.includes("TOTAL")) && (scp === "FULL_TIME" || !scp.includes("HALF"))) {
      if (side.includes("2.5") || type.includes("2.5")) {
        if (side.includes("OVER") || side === "O") over25Odds.push(effVal);
        else if (side.includes("UNDER") || side === "U") under25Odds.push(effVal);
      }
      continue;
    }

    // Karşılıklı Gol (KG Var / Yok)
    if (type.includes("BOTH_TEAMS_TO_SCORE") && (scp === "FULL_TIME" || !scp.includes("HALF"))) {
      if (side.includes("YES") || side === "Y") bttsYesOdds.push(effVal);
      else if (side.includes("NO") || side === "N") bttsNoOdds.push(effVal);
      continue;
    }

    // Doğru Skor (FT vs HT1)
    if (type.includes("CORRECT_SCORE") || type.includes("SCORE")) {
      const parsed = parseScoreToken(side);
      if (!parsed) continue;

      if (scp.includes("FIRST_HALF") || scp.includes("1ST") || scp.includes("HT1")) {
        if (curVal) {
          if (!htCsCurrent.has(parsed.score)) htCsCurrent.set(parsed.score, []);
          htCsCurrent.get(parsed.score)!.push(curVal);
        }
      } else if (scp === "FULL_TIME" || !scp.includes("HALF")) {
        if (curVal) {
          if (!ftCsCurrent.has(parsed.score)) ftCsCurrent.set(parsed.score, []);
          ftCsCurrent.get(parsed.score)!.push(curVal);
        }
        if (opVal) {
          if (!ftCsOpening.has(parsed.score)) ftCsOpening.set(parsed.score, []);
          ftCsOpening.get(parsed.score)!.push(opVal);
        }
      }
    }
  }

  // 1. 1X2 Olasılık Normalizasyonu
  const medH = hOdds.length ? median(hOdds) : FALLBACK_H;
  const medD = dOdds.length ? median(dOdds) : FALLBACK_D;
  const medA = aOdds.length ? median(aOdds) : FALLBACK_A;
  const sum1x2 = 1 / medH + 1 / medD + 1 / medA;
  const pH = (1 / medH) / sum1x2;
  const pD = (1 / medD) / sum1x2;
  const pA = (1 / medA) / sum1x2;

  // 2. 2.5 Barem Olasılığı
  let pOver25 = 0.5;
  if (over25Odds.length && under25Odds.length) {
    [pOver25] = impliedTwo(median(over25Odds), median(under25Odds));
  }
  const pUnder25 = 1 - pOver25;
  const isHyperOver = pOver25 >= 0.58;
  const isHardUnder = pOver25 <= 0.44;

  // 3. KG Var / Yok Olasılığı
  let pBttsYes = 0.52;
  if (bttsYesOdds.length && bttsNoOdds.length) {
    [pBttsYes] = impliedTwo(median(bttsYesOdds), median(bttsNoOdds));
  }
  const pBttsNo = 1 - pBttsYes;

  // 4. HT1 Korelasyon Matrisi
  const htNormMap = new Map<string, number>();
  if (htCsCurrent.size > 0) {
    let totHtInv = 0;
    for (const oddsList of htCsCurrent.values()) {
      totHtInv += 1 / median(oddsList);
    }
    for (const [sc, oddsList] of htCsCurrent.entries()) {
      htNormMap.set(sc, (1 / median(oddsList)) / totHtInv);
    }
  }

  // 5. Ham Büro Sıralaması ve Mutlak Çapa / Clean Sheet Tespiti (Colon Formatı Uyumlu)
  const sortedRawCs = Array.from(ftCsCurrent.entries())
    .map(([sc, list]) => ({ sc, med: median(list) }))
    .filter((x) => x.med > 1.0)
    .sort((a, b) => a.med - b.med);

  const absoluteTopScore = sortedRawCs.length ? sortedRawCs[0].sc : null;
  const top6RawScores = sortedRawCs.slice(0, 6).map((x) => x.sc);

  const isHeavyFav = pH >= 0.75 || pA >= 0.75;
  const cleanSheetTarget = pH >= 0.75 ? "1:0" : "0:1";
  const hasCleanSheetControl = isHeavyFav && top6RawScores.includes(cleanSheetTarget);

  // 6. Çoklu Piyasa Konsensüs ve Drift Puanlaması
  const candidates: {
    score: string;
    power: number;
    curOdd: number;
    opOdd: number | null;
    drift: number;
    h: number;
    a: number;
  }[] = [];

  for (const [scoreStr, curList] of ftCsCurrent.entries()) {
    const curOdd = median(curList);
    if (curOdd <= 1.0) continue;

    const opList = ftCsOpening.get(scoreStr);
    const opOdd = opList?.length ? median(opList) : curOdd;

    const parsed = parseScoreToken(scoreStr);
    if (!parsed) continue;
    const { h, a } = parsed;
    const totG = h + a;

    // (a) Ham Piyasa Zımni Olasılığı
    const baseProb = (1 / curOdd) * 100;

    // (b) Drift Velocity
    const rawDrift = curOdd > 0 && opOdd > 0 ? opOdd / curOdd : 1.0;
    const driftVelocity = Math.max(0.6, Math.min(1.6, rawDrift));

    // (c) 1X2 Taraf Uyumu
    const sideW = h > a ? pH / 0.33 : a > h ? pA / 0.33 : pD / 0.33;

    // (d) Barem Maske Kırıcı & Rölanti Kontrolü
    let baremFactor = 1.0;
    if (hasCleanSheetControl && scoreStr === cleanSheetTarget) {
      baremFactor = 1.45; // Erken Gol + Rölanti (Clean Sheet Control)
    } else if (isHyperOver) {
      if (totG <= 1) baremFactor = 0.35;
      else if (totG === 2) baremFactor = 0.65;
      else if (totG >= 4) baremFactor = 1.5;
      else baremFactor = 1.15;
    } else if (isHardUnder) {
      if (totG <= 1) baremFactor = 1.4;
      else if (totG === 2) baremFactor = 1.1;
      else if (totG >= 3) baremFactor = 0.5;
    }

    // (e) KG Var / Yok Uyumu
    const isBoth = h > 0 && a > 0;
    const bttsW = isBoth ? pBttsYes / 0.5 : pBttsNo / 0.5;

    // (f) HT1 Yarı Desteği
    let htFactor = 1.1;
    if (htNormMap.size > 0) {
      let compatibleHtProb = 0;
      let paths = 0;
      for (let i = 0; i <= h; i++) {
        for (let j = 0; j <= a; j++) {
          const key = `${i}:${j}`;
          if (htNormMap.has(key)) {
            compatibleHtProb += htNormMap.get(key)!;
            paths++;
          }
        }
      }
      htFactor = 1.0 + (paths > 0 ? compatibleHtProb / paths : 0.05);
    }

    // Master Power Formülü
    const power = baseProb * sideW * baremFactor * bttsW * Math.pow(driftVelocity, 1.5) * htFactor;

    candidates.push({
      score: scoreStr,
      power,
      curOdd,
      opOdd: opList?.length ? opOdd : null,
      drift: driftVelocity,
      h,
      a,
    });
  }

  // Güce göre büyükten küçüğe sırala
  candidates.sort((a, b) => b.power - a.power);

  // 7. Çapa Dokunulmazlığı ve Portföy İnşası
  const finalPortfolioItems: typeof candidates = [];
  const top3PowerScores = candidates.slice(0, 3).map((c) => c.score);

  if (absoluteTopScore && !top3PowerScores.includes(absoluteTopScore)) {
    finalPortfolioItems.push(candidates[0]);
    finalPortfolioItems.push(candidates[1]);
    const anchorItem = candidates.find((c) => c.score === absoluteTopScore);
    if (anchorItem) finalPortfolioItems.push(anchorItem);
  }

  if (finalPortfolioItems.length === 0) {
    finalPortfolioItems.push(...candidates.slice(0, 3));
  }

  const used = new Set(finalPortfolioItems.map((x) => x.score));
  const isSuperFav = pH >= 0.85 || pA >= 0.85;
  const isBalancedUnder = pOver25 <= 0.51 && pD >= 0.27 && Math.max(pH, pA) <= 0.55;

  if (isSuperFav) {
    const favIsHome = pH >= 0.85;
    const consolationCandidate = candidates.find((c) => {
      if (used.has(c.score)) return false;
      return favIsHome ? c.a === 1 && c.h >= 3 : c.h === 1 && c.a >= 3;
    });
    if (consolationCandidate) {
      finalPortfolioItems.push(consolationCandidate);
      used.add(consolationCandidate.score);
    }
  } else if (isBalancedUnder) {
    const zeroZeroCand = candidates.find((c) => c.score === "0:0" && !used.has(c.score));
    if (zeroZeroCand && zeroZeroCand.curOdd <= 11.0) {
      finalPortfolioItems.push(zeroZeroCand);
      used.add("0:0");
    }
  }

  if (finalPortfolioItems.length < 4) {
    const remaining = candidates.filter((c) => !used.has(c.score));
    if (remaining.length) finalPortfolioItems.push(remaining[0]);
  }

  const rankedScores = finalPortfolioItems.slice(0, 4);

  // Rejim Sınıflandırması
  const isHomeFav = pH >= 0.43 && pH > pA * 1.12;
  const isAwayFav = pA >= 0.43 && pA > pH * 1.12;

  let regimeCode = "OPEN";
  let regimeLabel = "Dengeli / Açık";
  let confidenceLabel = "STANDART";

  if (pH >= 0.85) {
    regimeCode = "DOM_H_SUPER";
    regimeLabel = "Ağır Baskılı Ev Favori";
    confidenceLabel = "ÇOK YÜKSEK (Tek Taraflı)";
  } else if (pA >= 0.85) {
    regimeCode = "DOM_A_SUPER";
    regimeLabel = "Ağır Baskılı Deplasman Favori";
    confidenceLabel = "ÇOK YÜKSEK (Tek Taraflı)";
  } else if (isHyperOver) {
    if (isHomeFav) {
      regimeCode = "DOM_H_HYPER";
      regimeLabel = "Yüksek Tempolu Ev Favori";
      confidenceLabel = "YÜKSEK (Gol Baskısı)";
    } else if (isAwayFav) {
      regimeCode = "DOM_A_HYPER";
      regimeLabel = "Yüksek Tempolu Deplasman Favori";
      confidenceLabel = "YÜKSEK (Gol Baskısı)";
    } else {
      regimeCode = "OPEN_HYPER";
      regimeLabel = "Yüksek Tempolu Açık Maç";
      confidenceLabel = "YÜKSEK (Açık Oyun)";
    }
  } else if (isHardUnder) {
    if (isHomeFav) {
      regimeCode = "DOM_H_UNDER";
      regimeLabel = "Kısır Ev Favori";
      confidenceLabel = "YÜKSEK (Alt Destekli)";
    } else if (isAwayFav) {
      regimeCode = "DOM_A_UNDER";
      regimeLabel = "Kısır Deplasman Favori";
      confidenceLabel = "YÜKSEK (Alt Destekli)";
    } else {
      regimeCode = "LOCK";
      regimeLabel = "Kilit Alt";
      confidenceLabel = "YÜKSEK (Piyasa Kilidi)";
    }
  } else {
    if (isHomeFav) {
      regimeCode = "DOM_H";
      regimeLabel = "Ev Favori";
      confidenceLabel = pH >= 0.58 ? "YÜKSEK (Ağır Favori)" : "STANDART";
    } else if (isAwayFav) {
      regimeCode = "DOM_A";
      regimeLabel = "Deplasman Favori";
      confidenceLabel = pA >= 0.58 ? "YÜKSEK (Ağır Favori)" : "STANDART";
    }
  }

  const hs = homeScore != null ? Number(homeScore) : null;
  const as_ = awayScore != null ? Number(awayScore) : null;
  const actualScore =
    hs != null && as_ != null && Number.isFinite(hs) && Number.isFinite(as_)
      ? `${hs}:${as_}`
      : null;

  const portfolio: ScoreConsensusSlot[] = rankedScores.map((item, i) => ({
    score: item.score,
    marketOdds: Math.round(item.curOdd * 100) / 100,
    openingOdds: item.opOdd ? Math.round(item.opOdd * 100) / 100 : null,
    driftVelocity: Math.round(item.drift * 100) / 100,
    power: Math.round(item.power * 100) / 100,
    tier: i < 3 ? "core" : "insurance",
    isActual: actualScore === item.score,
  }));

  void bookmakers;

  const top3Scores = rankedScores.slice(0, 3).map((x) => x.score);
  const top4Scores = rankedScores.map((x) => x.score);

  return {
    regimeCode,
    regimeLabel,
    confidenceLabel,
    homeProb: Math.round(pH * 1000) / 10,
    drawProb: Math.round(pD * 1000) / 10,
    awayProb: Math.round(pA * 1000) / 10,
    over25Prob: Math.round(pOver25 * 1000) / 10,
    under25Prob: Math.round(pUnder25 * 1000) / 10,
    bttsYesProb: Math.round(pBttsYes * 1000) / 10,
    portfolio,
    actualScore,
    hit3: actualScore ? top3Scores.includes(actualScore) : null,
    hit4: actualScore ? top4Scores.includes(actualScore) : null,
  };
}
