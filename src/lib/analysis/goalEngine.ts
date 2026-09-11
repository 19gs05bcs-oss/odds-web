import type { CompactOddsRow } from "@/lib/archiveCache";

export type GoalEngineMetrics = {
  // Dominance & Güç Dağılımı
  dominanceSide: "HOME" | "AWAY" | "NONE";
  isHeavyFavorite: boolean;
  isExtremeDominance: boolean;
  favoriteOdds: number | null;

  // İlk Yarı Hızı (HT Velocity)
  htVelocity: "HARD_LOCK" | "BALANCED" | "HIGH_VELOCITY";
  htVelocityLabel: string;
  htZeroZeroOdd: number | null;
  htZeroZeroDrift: number;

  // Barem Olasılıkları
  pOver15: number | null;
  pOver25: number;
  pOver35: number | null;
  pOver45: number | null;
  isUnderLeaking: boolean;

  // Karar Parametreleri
  fairGoalLine: number;
  bttsExpectancy: boolean;
  scoreProfile: "EXTREME_BLOWOUT" | "DOMINANT_WIN" | "CONTESTED_FAVORITE" | "OPEN_EXCHANGE" | "BALANCED" | "HARD_UNDER";

  // Skor Motoru Çarpan Fonksiyonu
  getScoreMultiplier: (homeGoals: number, awayGoals: number) => number;
};

function parseNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1.01 ? n : null;
}

function isActive(active: unknown): boolean {
  return !(active === false || active === 0 || active === "0" || active === "false");
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

export function computeGoalEngine(odds: CompactOddsRow[] | null | undefined): GoalEngineMetrics | null {
  if (!odds?.length) return null;

  const msHome: number[] = [];
  const msAway: number[] = [];
  const dnbHome: number[] = [];
  const dnbAway: number[] = [];

  const ht00Current: number[] = [];
  const ht00Opening: number[] = [];

  const ou: Record<string, { o: number[]; u: number[]; o_op: number[]; u_op: number[] }> = {
    "1.5": { o: [], u: [], o_op: [], u_op: [] },
    "2.5": { o: [], u: [], o_op: [], u_op: [] },
    "3.5": { o: [], u: [], o_op: [], u_op: [] },
    "4.5": { o: [], u: [], o_op: [], u_op: [] },
  };

  const bttsYes: number[] = [];
  const bttsNo: number[] = [];

  for (const row of odds) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [, mtype, scope, sideTok, opening, current, active] = row;
    if (!isActive(active)) continue;

    const cur = parseNum(current);
    const op = parseNum(opening);
    const eff = cur ?? op;
    if (eff == null) continue;

    const type = String(mtype).toUpperCase();
    const scp = String(scope).toUpperCase();
    const side = String(sideTok).toUpperCase();

    // 1X2 Full Time
    if (type.includes("HOME_DRAW_AWAY") && (scp === "FULL_TIME" || !scp.includes("HALF"))) {
      if (side === "H") msHome.push(eff);
      else if (side === "A") msAway.push(eff);
    }

    // DNB
    if (type.includes("DRAW_NO_BET") && (scp === "FULL_TIME" || !scp.includes("HALF"))) {
      if (side === "H") dnbHome.push(eff);
      else if (side === "A") dnbAway.push(eff);
    }

    // HT 0:0
    if ((type.includes("CORRECT_SCORE") || type.includes("SCORE")) &&
        (scp.includes("FIRST_HALF") || scp.includes("1ST") || scp.includes("HT1"))) {
      if (side === "0:0" || side === "0-0" || side.endsWith(":0:0") || side.endsWith(":0-0")) {
        if (cur) ht00Current.push(cur);
        if (op) ht00Opening.push(op);
      }
    }

    // Over / Under
    if ((type.includes("OVER_UNDER") || type.includes("TOTAL")) && (scp === "FULL_TIME" || !scp.includes("HALF"))) {
      const isOver = side.includes("OVER") || side === "O";
      const isUnder = side.includes("UNDER") || side === "U";

      for (const line of ["1.5", "2.5", "3.5", "4.5"]) {
        if (side.includes(line) || type.includes(line)) {
          if (isOver) {
            ou[line].o.push(eff);
            if (op) ou[line].o_op.push(op);
          } else if (isUnder) {
            ou[line].u.push(eff);
            if (op) ou[line].u_op.push(op);
          }
        }
      }
    }

    // BTTS
    if (type.includes("BOTH_TEAMS_TO_SCORE") && (scp === "FULL_TIME" || !scp.includes("HALF"))) {
      if (side.includes("YES") || side === "Y") bttsYes.push(eff);
      else if (side.includes("NO") || side === "N") bttsNo.push(eff);
    }
  }

  // 1. Dominance / Asimetri Analizi
  const medH = msHome.length ? median(msHome) : null;
  const medA = msAway.length ? median(msAway) : null;
  const medDnbH = dnbHome.length ? median(dnbHome) : null;
  const medDnbA = dnbAway.length ? median(dnbAway) : null;

  let dominanceSide: GoalEngineMetrics["dominanceSide"] = "NONE";
  let favoriteOdds: number | null = null;
  let isHeavyFavorite = false;
  let isExtremeDominance = false;

  const minDnb = Math.min(medDnbH ?? 99, medDnbA ?? 99);
  const minMs = Math.min(medH ?? 99, medA ?? 99);

  if (medH && (!medA || medH < medA)) {
    dominanceSide = "HOME";
    favoriteOdds = medH;
  } else if (medA && (!medH || medA < medH)) {
    dominanceSide = "AWAY";
    favoriteOdds = medA;
  }

  if (minDnb <= 1.30 || minMs <= 1.65) isHeavyFavorite = true;
  if (minMs <= 1.20 || minDnb <= 1.08) isExtremeDominance = true;
  if (!isHeavyFavorite) dominanceSide = "NONE";

  // 2. İlk Yarı Hızı (HT Velocity)
  const medHt00Cur = ht00Current.length ? median(ht00Current) : null;
  const medHt00Op = ht00Opening.length ? median(ht00Opening) : medHt00Cur;
  const ht00Drift = medHt00Cur && medHt00Op ? medHt00Op / medHt00Cur : 1.0;

  let htVelocity: GoalEngineMetrics["htVelocity"] = "BALANCED";
  let htVelocityLabel = "Dengeli İlk Yarı";

  if (medHt00Cur != null) {
    if (medHt00Cur <= 2.30 && !isHeavyFavorite) {
      htVelocity = "HARD_LOCK";
      htVelocityLabel = "Sert Kilit (0:0 Beklentisi)";
    } else if (medHt00Cur >= 3.00 || (medHt00Cur >= 2.70 && isHeavyFavorite)) {
      htVelocity = "HIGH_VELOCITY";
      htVelocityLabel = "Yüksek Hız (Erken Gol)";
    }
  }

  // 3. Barem Olasılıkları
  const calcP = (line: string): number | null => {
    if (ou[line].o.length && ou[line].u.length) {
      const [po] = impliedTwo(median(ou[line].o), median(ou[line].u));
      return po;
    }
    return null;
  };

  const pOver15 = calcP("1.5");
  const pOver25 = calcP("2.5") ?? 0.5;
  const pOver35 = calcP("3.5");
  const pOver45 = calcP("4.5");

  // 4. Alt Kaçışı / Trap Under Tespiti (Botafogo / Stevenage Filtresi)
  let isUnderLeaking = false;
  if (ou["2.5"].u.length && ou["2.5"].u_op.length) {
    const uCur = median(ou["2.5"].u);
    const uOp = median(ou["2.5"].u_op);
    if (uCur / uOp >= 1.04) isUnderLeaking = true;
  }

  const medBttsYes = bttsYes.length ? median(bttsYes) : 2.0;
  const bttsExpectancy = medBttsYes <= 1.65;

  // 5. Profil Hiyerarşisi
  let fairGoalLine = 2.5;
  let scoreProfile: GoalEngineMetrics["scoreProfile"] = "BALANCED";

  if (isExtremeDominance && (pOver35 ?? 0) >= 0.50) {
    fairGoalLine = 4.5;
    scoreProfile = "EXTREME_BLOWOUT";
  } else if (isHeavyFavorite && bttsExpectancy) {
    fairGoalLine = 2.75;
    scoreProfile = "CONTESTED_FAVORITE";
  } else if (isHeavyFavorite && !bttsExpectancy) {
    fairGoalLine = pOver25 >= 0.55 ? 3.0 : 2.5;
    scoreProfile = "DOMINANT_WIN";
  } else if (!isHeavyFavorite && bttsExpectancy && pOver25 >= 0.525) {
    fairGoalLine = 2.75;
    scoreProfile = "OPEN_EXCHANGE";
  } else if (!isHeavyFavorite && (pOver15 ?? 1) < 0.70 && pOver25 < 0.48 && !isUnderLeaking && (medHt00Cur ?? 99) <= 2.40) {
    fairGoalLine = 1.5;
    scoreProfile = "HARD_UNDER";
  }

  // 6. Dinamik Skor Ağırlıklandırma
  const getScoreMultiplier = (hG: number, aG: number): number => {
    const totG = hG + aG;
    const isCleanSheet = (dominanceSide === "HOME" && aG === 0) || (dominanceSide === "AWAY" && hG === 0);
    const favGoals = dominanceSide === "HOME" ? hG : aG;
    const dogGoals = dominanceSide === "HOME" ? aG : hG;

    // A. Bayern / Man Utd Tipi Ekstrem Ezme
    if (scoreProfile === "EXTREME_BLOWOUT") {
      if (totG <= 2) return 0.25;
      if (totG === 3 && isCleanSheet) return 1.20;
      if (totG >= 4 && isCleanSheet) return 1.65;
      return 0.80;
    }

    // B. PSV - Shakhtar Tipi Karşılıklı Favori Maçı
    if (scoreProfile === "CONTESTED_FAVORITE") {
      if (hG === 1 && aG === 1) return 1.60;
      if (favGoals >= 2 && dogGoals >= 1 && totG <= 4) return 1.50;
      if (isCleanSheet) return 0.50;
      return 0.85;
    }

    // C. Sport Recife / Panathinaikos Tipi Tek Taraflı Üstünlük
    if (scoreProfile === "DOMINANT_WIN") {
      if (isCleanSheet && (totG === 2 || totG === 3)) return 1.45;
      if (isCleanSheet && totG >= 4) return 1.25;
      if (favGoals >= 2 && dogGoals === 1 && totG <= 4) return 1.35; // 2:1 ve 3:1 emniyeti
      if (!isCleanSheet && totG <= 2) return 0.50;
      return 0.90;
    }

    // D. Slavia - Lens / Como - Leipzig Tipi Karşılıklı Vuruşma
    if (scoreProfile === "OPEN_EXCHANGE") {
      if (hG > 0 && aG > 0) {
        if (totG >= 3) return 1.50;
        return 1.15;
      }
      return 0.40;
    }

    // E. Atlantico - Delfines Tipi Gerçek Kilit
    if (scoreProfile === "HARD_UNDER") {
      if (totG === 0) return 1.70;
      if (totG === 1) return 1.50;
      if (totG === 2) return 0.85;
      return 0.20;
    }

    // F. BALANCED (Stevenage, Botafogo Kırılmaları Dahil)
    if (totG === 2 || totG === 3 || totG === 4) return 1.25;
    return 0.85;
  };

  return {
    dominanceSide,
    isHeavyFavorite,
    isExtremeDominance,
    favoriteOdds,
    htVelocity,
    htVelocityLabel,
    htZeroZeroOdd: medHt00Cur ? Math.round(medHt00Cur * 100) / 100 : null,
    htZeroZeroDrift: Math.round(ht00Drift * 100) / 100,
    pOver15: pOver15 ? Math.round(pOver15 * 1000) / 10 : null,
    pOver25: Math.round(pOver25 * 1000) / 10,
    pOver35: pOver35 ? Math.round(pOver35 * 1000) / 10 : null,
    pOver45: pOver45 ? Math.round(pOver45 * 1000) / 10 : null,
    isUnderLeaking,
    fairGoalLine,
    bttsExpectancy,
    scoreProfile,
    getScoreMultiplier,
  };
}
