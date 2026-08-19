/**
 * similarityCodes.ts — odds-agent/src/similarity_features_v4.py'deki
 * build_code_whens() ile BİREBİR AYNI üretim mantığı. Kod isimleri
 * similarityStats.json'daki anahtarlarla tam eşleşmeli — biri değişirse
 * diğeri de değişmeli, yoksa stats lookup'ı sessizce boş döner.
 *
 * match_odds tablosundaki gerçek encoding (memory/raw/*.parquet ile
 * doğrulandı, odds-web'in kendi match_odds şemasının da aynı writer'dan
 * geldiği varsayımıyla):
 *   market    = "{market_type}:{market_scope}"   (örn. "HOME_DRAW_AWAY:FULL_TIME")
 *   selection = side (örn. "H", "OVER:2.5", "H:1.25", "DC:1X", "sel:ODD", "htft:1/X")
 *
 * VARSAYIM İŞARETİ: match_odds'un gerçek "market"/"selection" kolon
 * formatının bu şekilde olduğu marketQuoteCriteria.ts'teki mevcut sorgu
 * kalıplarından çıkarıldı — canlıya almadan ÖNCE tek bir event_id ile
 * (similarityEngine.ts'teki test adımı) doğrula.
 */

export type SimilarityCode = {
  code: string; // similarityStats.json anahtarıyla birebir aynı
  group: string; // similarityWeights.json'daki ağırlık grubu
  market: string; // match_odds.market ile birebir eşleşecek değer
  side: string; // match_odds.selection ile birebir eşleşecek değer (tam eşleşme, prefix değil)
};

const SCOPES = ["FULL_TIME", "FIRST_HALF", "SECOND_HALF"] as const;
const SCOPE_TAG: Record<(typeof SCOPES)[number], string> = {
  FULL_TIME: "FT",
  FIRST_HALF: "HT",
  SECOND_HALF: "2H",
};

// Python'daki OU_LINES = [round(0.25 + 0.25*i, 2) for i in range(28)] -> 0.25..7.0
const OU_LINES: number[] = Array.from({ length: 28 }, (_, i) => round2(0.25 + 0.25 * i));
// Python'daki AH_LINES = [round(-3 + 0.25*i, 2) for i in range(25)] -> -3.0..3.0
const AH_LINES: number[] = Array.from({ length: 25 }, (_, i) => round2(-3 + 0.25 * i));

const HTFT_COMBOS = ["1/1", "1/X", "1/2", "X/1", "X/X", "X/2", "2/1", "2/X", "2/2"];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Python'un f"{x:g}" davranışının bu sınırlı değer kümesi (çeyrek adımlı,
 * en fazla 2 ondalık) için birebir karşılığı: sondaki sıfırları ve varsa
 * noktayı at. */
function trimG(absValue: number): string {
  let s = absValue.toFixed(2); // "0.25", "0.50", "1.00", "2.75", "7.00"
  if (s.includes(".")) {
    s = s.replace(/0+$/, ""); // "0.50" -> "0.5", "1.00" -> "1."
    s = s.replace(/\.$/, ""); // "1." -> "1"
  }
  return s;
}

/** Python'daki _line_tag: 0.5 -> '05', 2.5 -> '25', -0.75 -> 'M075', 0.0 -> '0'. */
function lineTag(line: number): string {
  const sign = line < 0 ? "M" : "";
  return `${sign}${trimG(Math.abs(line)).replace(".", "")}`;
}

function htftTag(combo: string): string {
  return "HTFT_" + combo.replace("/", "");
}

function buildCodes(): SimilarityCode[] {
  const items: SimilarityCode[] = [];

  for (const scope of SCOPES) {
    const st = SCOPE_TAG[scope];
    for (const side of ["H", "D", "A"]) {
      items.push({
        code: `X12_${st}_${side}`,
        group: "X12",
        market: `HOME_DRAW_AWAY:${scope}`,
        side,
      });
    }
  }

  for (const scope of SCOPES) {
    const st = SCOPE_TAG[scope];
    for (const line of OU_LINES) {
      const tag = lineTag(line);
      const lineStr = trimG(line); // side string'inde de aynı format kullanılıyor ("OVER:2.5")
      items.push({
        code: `OU_${st}_OVER${tag}`,
        group: "OU",
        market: `OVER_UNDER:${scope}`,
        side: `OVER:${lineStr}`,
      });
      items.push({
        code: `OU_${st}_UNDER${tag}`,
        group: "OU",
        market: `OVER_UNDER:${scope}`,
        side: `UNDER:${lineStr}`,
      });
    }
  }

  for (const scope of SCOPES) {
    const st = SCOPE_TAG[scope];
    items.push({
      code: `BTTS_${st}_YES`,
      group: "BTTS",
      market: `BOTH_TEAMS_TO_SCORE:${scope}`,
      side: "YES", // ek varyantlar (True/btts:YES) engine tarafında ayrıca denenir
    });
    items.push({
      code: `BTTS_${st}_NO`,
      group: "BTTS",
      market: `BOTH_TEAMS_TO_SCORE:${scope}`,
      side: "NO",
    });
  }

  // HT/FT — scope kavramı yok (doğası gereği tam maç)
  for (const combo of HTFT_COMBOS) {
    items.push({
      code: htftTag(combo),
      group: "HTFT",
      market: `HALF_FULL_TIME:FULL_TIME`,
      side: `htft:${combo}`, // engine tarafında bare 'combo' da fallback olarak denenir
    });
  }

  for (const scope of SCOPES) {
    const st = SCOPE_TAG[scope];
    for (const [dcCode, dcSide] of [
      ["1X", "DC:1X"],
      ["12", "DC:12"],
      ["X2", "DC:X2"],
    ] as const) {
      items.push({
        code: `DC_${st}_${dcCode}`,
        group: "DC",
        market: `DOUBLE_CHANCE:${scope}`,
        side: dcSide,
      });
    }
  }

  for (const scope of SCOPES) {
    const st = SCOPE_TAG[scope];
    items.push({
      code: `ODDEVEN_${st}_ODD`,
      group: "ODDEVEN",
      market: `ODD_OR_EVEN:${scope}`,
      side: "sel:ODD",
    });
    items.push({
      code: `ODDEVEN_${st}_EVEN`,
      group: "ODDEVEN",
      market: `ODD_OR_EVEN:${scope}`,
      side: "sel:EVEN",
    });
  }

  for (const scope of SCOPES) {
    const st = SCOPE_TAG[scope];
    for (const line of AH_LINES) {
      const tag = lineTag(line);
      const lineStr = trimG(Math.abs(line));
      const signedLineStr = line < 0 ? `-${lineStr}` : lineStr;
      items.push({
        code: `AH_${st}_HOME${tag}`,
        group: "AH",
        market: `ASIAN_HANDICAP:${scope}`,
        side: `H:${signedLineStr}`,
      });
      items.push({
        code: `AH_${st}_AWAY${tag}`,
        group: "AH",
        market: `ASIAN_HANDICAP:${scope}`,
        side: `A:${signedLineStr}`,
      });
    }
  }

  return items;
}

export const SIMILARITY_CODES: SimilarityCode[] = buildCodes();
export const CODE_BY_NAME: Map<string, SimilarityCode> = new Map(
  SIMILARITY_CODES.map((c) => [c.code, c]),
);
export const GROUPS: string[] = [...new Set(SIMILARITY_CODES.map((c) => c.group))];
