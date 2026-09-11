import type { CompactOddsRow } from "@/lib/archiveCache";

export type GoalEngineMetrics = {
  // 1. Dominance & Güç Dağılımı
  dominanceSide: "HOME" | "AWAY" | "NONE";
  isHeavyFavorite: boolean;
  isExtremeDominance: boolean;
  favoriteOdds: number | null;

  // 2. İlk Yarı Hızı (HT Velocity)
  htVelocity: "HARD_LOCK" | "BALANCED" | "HIGH_VELOCITY";
  htVelocityLabel: string;
  htZeroZeroOdd: number | null;
  htZeroZeroDrift: number;

  // 3. Barem Olasılıkları
  pOver15: number | null;
  pOver25: number;
  pOver35: number | null;
  pOver45: number | null;

  // 4. Piyasa Anomalileri & Likidite Sinyalleri
  isUnderLeaking: boolean;
  isFalseOpen: boolean;
  handicapSmashCount: number;
  anomalies: string[];

  // 5. Karar Parametreleri & Net Teşhisler
  fairGoalLine: number;
  bttsExpectancy: boolean;
  scoreProfile:
    | "EXTREME_BLOWOUT"
    | "DOMINANT_WIN"
    | "CONTESTED_FAVORITE"
    | "OPEN_EXCHANGE"
    | "BALANCED"
    | "HARD_UNDER"
    | "LOCKED_CORRIDOR";

  htVerdict: string;
  ftVerdict: string;

  // 6. Skor Motoru Çarpan Fonksiyonu
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

const STATIC_DRIFT_MAX = 0.025; // %2.5 altı değişim hareketsiz piyasadır

function driftRatio(current: number[], opening: number[]): number | null {
  if (!current.length || !opening.length) return null;
  const c = median(current);
  const o = median(opening);
  if (o <= 0) return null;
  return Math.abs(c - o) / o;
}

function isLineStatic(over: number[], overOp: number[], under: number[], underOp: number[]): boolean {
  const dOver = driftRatio(over, overOp);
  const dUnder = driftRatio(under, underOp);
  if (dOver == null || dUnder == null) return false;
  return dOver <= STATIC_DRIFT_MAX && dUnder <= STATIC_DRIFT_MAX;
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

  const htOu05: number[] = [];
  const bttsYes: number[] = [];
  const bttsNo: number[] = [];

  // Asya Handikap takibi (Botafogo, Como, Kyoto tipi sert likidite çöküşleri için)
  const asianMinusLines: Array<{ key: string; op: number; cur: number }> = [];

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

    // HT Over 0.5
    if ((type.includes("OVER_UNDER") || type.includes("TOTAL")) &&
        (scp.includes("FIRST_HALF") || scp.includes("1ST") || scp.includes("HT1"))) {
      if (side.includes("0.5") && (side.includes("OVER") || side === "O")) {
        htOu05.push(eff);
      }
    }

    // Over / Under Full Time
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

    // Asya Handikap Eksi Baremler (-0.75, -1.0, -1.25, -1.5)
    if (type.includes("ASIAN_HANDICAP") && (scp === "FULL_TIME" || !scp.includes("HALF"))) {
      if (op && cur && (side.includes("-0.75") || side.includes("-1.0") || side.includes("-1.25") || side.includes("-1.5"))) {
        asianMinusLines.push({ key: side, op, cur });
      }
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
  const medHtOu05 = htOu05.length ? median(htOu05) : null;

  let htVelocity: GoalEngineMetrics["htVelocity"] = "BALANCED";
  let htVelocityLabel = "Dengeli İlk Yarı";

  if (medHt00Cur != null) {
    if (medHt00Cur <= 2.35 && !isHeavyFavorite) {
      htVelocity = "HARD_LOCK";
      htVelocityLabel = "Sert Kilit (0:0 Beklentisi)";
    } else if (medHt00Cur >= 3.00 || (medHt00Cur >= 2.70 && isHeavyFavorite)) {
      htVelocity = "HIGH_VELOCITY";
      htVelocityLabel = "Yüksek Hız (Erken Gol Patlaması)";
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

  // 4. Anomaliler & Likidite Sinyalleri
  const anomalies: string[] = [];

  // 4a. Under Leakage (Alt Kaçışı)
  let isUnderLeaking = false;
  if (ou["2.5"].u.length && ou["2.5"].u_op.length) {
    const uCur = median(ou["2.5"].u);
    const uOp = median(ou["2.5"].u_op);
    if (uCur / uOp >= 1.04) {
      isUnderLeaking = true;
      anomalies.push(`UNDER LEAKAGE: 2.5 Alt oranı @${uOp.toFixed(2)} -> @${uCur.toFixed(2)} yükseldi. Para Üst baremine akıyor!`);
    }
  }

  // 4b. Asya Handikap Çöküşü (Handicap Smash)
  let handicapSmashCount = 0;
  for (const h of asianMinusLines) {
    if (h.cur / h.op <= 0.86) {
      handicapSmashCount++;
      anomalies.push(`HANDICAP SMASH: ${h.key} @${h.op.toFixed(2)} -> @${h.cur.toFixed(2)} seviyesine sert çöktü!`);
    }
  }

  // 4c. False Open (Estoril Koruması)
  const static15 = isLineStatic(ou["1.5"].o, ou["1.5"].o_op, ou["1.5"].u, ou["1.5"].u_op);
  const static25 = isLineStatic(ou["2.5"].o, ou["2.5"].o_op, ou["2.5"].u, ou["2.5"].u_op);
  const isFalseOpen = static15 && static25 && !isUnderLeaking && handicapSmashCount === 0;
  if (isFalseOpen) {
    anomalies.push("DEAD/STATIC MARKET: Barem oranlarında sıfır hareket var. Üst şablonu yanıltıcı, kilit riski tavan!");
  }

  const medBttsYes = bttsYes.length ? median(bttsYes) : 2.0;
  const bttsExpectancy = medBttsYes <= 1.68;

  // 5. Profil Hiyerarşisi (Tüm Uç Vakaların Sentezi)
  let fairGoalLine = 2.5;
  let scoreProfile: GoalEngineMetrics["scoreProfile"] = "BALANCED";

  // A. Ekstrem Ezme (Bayern Vakası)
  if (isExtremeDominance && (pOver35 ?? 0) >= 0.50) {
    fairGoalLine = 4.5;
    scoreProfile = "EXTREME_BLOWOUT";
  }
  // B. Ağır Favori ama Karşılıklı Gol Baskısı (PSV Vakası)
  else if (isHeavyFavorite && bttsExpectancy) {
    fairGoalLine = 2.75;
    scoreProfile = "CONTESTED_FAVORITE";
  }
  // C. Tek Taraflı Ağır Üstünlük (Sport Recife, Panathinaikos, Palermo)
  else if (isHeavyFavorite && !bttsExpectancy) {
    fairGoalLine = pOver25 >= 0.55 ? 3.0 : 2.5;
    scoreProfile = "DOMINANT_WIN";
  }
  // D. Botafogo Düzeltmesi (Fake Under / Anomalik Üst Patlaması)
  // Barem %42 gibi kısır görünse dahi alt kaçağı ve handikap çöküşü varsa maç patlar!
  else if (isUnderLeaking && handicapSmashCount >= 1) {
    fairGoalLine = 2.75;
    scoreProfile = "OPEN_EXCHANGE";
  }
  // E. Estoril Koruması (Hareketsiz Şablon Tuzağı)
  else if (!isHeavyFavorite && isFalseOpen) {
    fairGoalLine = 1.75;
    scoreProfile = "LOCKED_CORRIDOR";
  }
  // F. Karşılıklı Yangın / Yüksek Tempo (Como, Elche, Kyoto)
  else if (
    !isHeavyFavorite &&
    (
      (bttsExpectancy && pOver25 >= 0.51) ||
      (htVelocity === "HIGH_VELOCITY" && bttsExpectancy) ||
      (isUnderLeaking && pOver25 >= 0.48)
    )
  ) {
    fairGoalLine = 2.75;
    scoreProfile = "OPEN_EXCHANGE";
  }
  // G. Gerçek Kilit / Under Duvarı (Atlantico, Vila Nova)
  else if (
    !isHeavyFavorite &&
    (pOver15 ?? 1) < 0.70 &&
    pOver25 < 0.46 &&
    !isUnderLeaking &&
    medBttsYes >= 1.95 &&
    (medHt00Cur ?? 99) <= 2.40
  ) {
    fairGoalLine = 1.5;
    scoreProfile = "HARD_UNDER";
  }

  // 6. Net HT / FT Teşhis Metinleri
  let htVerdict = "DENGELİ İLK YARI (0-1 Gol Beklentisi)";
  if (htVelocity === "HIGH_VELOCITY" || (medHtOu05 != null && medHtOu05 <= 1.30)) {
    htVerdict = "🔥 İLK YARI TEMPO / ERKEN GOL (HT 0.5 & 1.5 Üst Potansiyeli Yüksek)";
  } else if (htVelocity === "HARD_LOCK" || (isFalseOpen && (medHtOu05 == null || medHtOu05 >= 1.35))) {
    htVerdict = "🔒 İLK YARI SERT KİLİT (0:0 Riski Tavan)";
  }

  let ftVerdict = "DENGELİ KORİDOR (2-3 Gol Beklentisi)";
  if (scoreProfile === "LOCKED_CORRIDOR") {
    ftVerdict = "🧊 SAHTE ÜST TUZAĞI (Ölü Piyasa / 0-0 veya 1-1 Kilit Skoru Riski)";
  } else if (isUnderLeaking && handicapSmashCount >= 1) {
    ftVerdict = "💣 ANOMALİK ÜST PATLAMASI (Baremler Kısır Görünse Bile Maç 3+ / 4+ Gole Patlayacak!)";
  } else if (scoreProfile === "OPEN_EXCHANGE") {
    ftVerdict = "💣 MAÇ SONU GOL YAĞMURU (Karşılıklı Vuruşma & 3+ / 4+ Gol)";
  } else if (scoreProfile === "EXTREME_BLOWOUT" || scoreProfile === "DOMINANT_WIN") {
    ftVerdict = "🚀 TEK TARAFLI EZME (Favori Takım Baremi Tek Başına Aşabilir)";
  } else if (scoreProfile === "HARD_UNDER") {
    ftVerdict = "🛡️ GERÇEK SERT KISIR DUVARI (Maksimum 1 Gol / 0-0, 1-0)";
  } else if (pOver25 < 0.45 && !isUnderLeaking) {
    ftVerdict = "⚖️ KONTROLLÜ DÜŞÜK TEMPO (Maksimum 2 Gol / 1-0, 0-1, 1-1)";
  }

  // 7. Dinamik Skor Ağırlıklandırma
  const getScoreMultiplier = (hG: number, aG: number): number => {
    const totG = hG + aG;
    const isCleanSheet = (dominanceSide === "HOME" && aG === 0) || (dominanceSide === "AWAY" && hG === 0);
    const favGoals = dominanceSide === "HOME" ? hG : aG;
    const dogGoals = dominanceSide === "HOME" ? aG : hG;

    // A. EXTREME_BLOWOUT
    if (scoreProfile === "EXTREME_BLOWOUT") {
      if (totG <= 2) return 0.20;
      if (totG === 3 && isCleanSheet) return 1.20;
      if (totG >= 4 && isCleanSheet) return 1.65;
      return 0.80;
    }

    // B. CONTESTED_FAVORITE
    if (scoreProfile === "CONTESTED_FAVORITE") {
      if (hG === 1 && aG === 1) return 1.60;
      if (favGoals >= 2 && dogGoals >= 1 && totG <= 4) return 1.50;
      if (isCleanSheet) return 0.50;
      return 0.85;
    }

    // C. DOMINANT_WIN (Panathinaikos / Palermo 3-1 emniyeti dahil)
    if (scoreProfile === "DOMINANT_WIN") {
      if (isCleanSheet && (totG === 2 || totG === 3)) return 1.45; // 2:0, 3:0
      if (isCleanSheet && totG >= 4) return 1.25;                  // 4:0
      if (favGoals >= 2 && dogGoals === 1 && totG <= 4) return 1.35; // 2:1, 3:1
      if (!isCleanSheet && totG <= 2) return 0.50;
      return 0.90;
    }

    // D. OPEN_EXCHANGE
    if (scoreProfile === "OPEN_EXCHANGE") {
      if (hG > 0 && aG > 0) {
        if (totG >= 3) return 1.55; // 2:1, 1:2, 2:2, 2:3, 3:2
        return 1.15; // 1:1
      }
      return 0.35; // Kısır tek taraflı skorlara blok
    }

    // E. HARD_UNDER
    if (scoreProfile === "HARD_UNDER") {
      if (totG === 0) return 1.70;
      if (totG === 1) return 1.50;
      if (totG === 2) return 0.85;
      return 0.20;
    }

    // E2. LOCKED_CORRIDOR (Estoril Koruması)
    if (scoreProfile === "LOCKED_CORRIDOR") {
      if (totG === 0) return 1.65; // 0:0
      if (hG === aG) return 1.50;  // 1:1
      if (totG === 1) return 1.15; // 1:0, 0:1
      if (totG === 2) return 0.70;
      return 0.20;
    }

    // F. BALANCED (Cagliari / Vila Nova Düzeltmesi)
    // KG Var ölü ise (@1.95+) ve barem düşükse 1:0 ve 2:0 favori skorlarına prim ver:
    if (medBttsYes >= 1.95 && pOver25 < 0.45) {
      if ((hG === 1 && aG === 0) || (hG === 2 && aG === 0)) return 1.35;
      if ((aG === 1 && hG === 0) || (aG === 2 && hG === 0)) return 1.35;
      if (totG <= 2) return 1.10;
      return 0.70;
    }

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
    isFalseOpen,
    handicapSmashCount,
    anomalies,
    fairGoalLine,
    bttsExpectancy,
    scoreProfile,
    htVerdict,
    ftVerdict,
    getScoreMultiplier,
  };
}
