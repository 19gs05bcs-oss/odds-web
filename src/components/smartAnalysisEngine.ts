import memory from "./smartAnalysisMemory.json";

export type CalibrationRow = {
  bookmakerId: string;
  bookmakerName: string;
  market: string;
  n: number;
  winPct: number;
  impliedOpenPct: number;
  impliedClosePct: number;
  edgeClosePp: number;
};

export type DriftRow = {
  market: string;
  move: "shortened" | "lengthened" | "stable";
  n: number;
  winPct: number;
  impliedOpenPct: number;
  impliedClosePct: number;
  edgeClosePp: number;
};

export type SimilarOddsMemory = {
  avgClusterSize: number;
  byOutcome: Record<string, { anchors: number; avgSameOutcomePct: number }>;
  baselineRandom1x2: number;
};

export type OddsSignal = {
  market: string;
  scope: string;
  side: string;
  opening: number;
  closing: number;
  changePct: number;
  move: string;
  bookmakerId: string | number | null;
  bookmakerName: string | null;
};

export type UpcomingInsight = {
  id: string;
  home: string | null;
  away: string | null;
  kickoff: string | null;
  league?: string | null;
  signals: OddsSignal[];
  memoryHint?: string;
};

export type SmartMemory = {
  generatedAt: string;
  sampleFinished: number;
  sample1x2Profiles: number;
  similarOddsTolerance: number;
  pillar1_bookmakerCalibration: CalibrationRow[];
  pillar2_marketDrift: DriftRow[];
  pillar3_similarOdds: SimilarOddsMemory;
  pillar4_upcomingSample: UpcomingInsight[];
  bookmakersSeen: Record<string, string>;
  note: string;
};

export function getSmartMemory(): SmartMemory {
  return memory as SmartMemory;
}

export function fmtPct(v: number, d = 1): string {
  return `${(v * 100).toFixed(d)}%`;
}

export function fmtPp(v: number): string {
  const pp = v * 100;
  return `${pp >= 0 ? "+" : ""}${pp.toFixed(1)} pp`;
}

/** Group pillar-1 rows by bookmaker (top markets). */
export function bookmakersSummary(rows: CalibrationRow[], limit = 20) {
  const byBm = new Map<
    string,
    { name: string; markets: CalibrationRow[]; totalN: number; avgEdge: number }
  >();
  for (const r of rows) {
    let g = byBm.get(r.bookmakerId);
    if (!g) {
      g = { name: r.bookmakerName, markets: [], totalN: 0, avgEdge: 0 };
      byBm.set(r.bookmakerId, g);
    }
    g.markets.push(r);
    g.totalN += r.n;
  }
  for (const g of byBm.values()) {
    g.markets.sort((a, b) => b.edgeClosePp - a.edgeClosePp);
    g.avgEdge = g.markets.reduce((s, m) => s + m.edgeClosePp * m.n, 0) / Math.max(g.totalN, 1);
  }
  return [...byBm.entries()]
    .map(([id, g]) => ({ id, ...g }))
    .sort((a, b) => b.avgEdge - a.avgEdge)
    .slice(0, limit);
}

/** Key insight lines from memory for UI. */
export function buildSmartInsights(m: SmartMemory): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  out.push({
    title: "Veri seti",
    body: `${m.sampleFinished.toLocaleString()} bitmiş maç · ${Object.keys(m.bookmakersSeen).length} bookmaker · 1X2 profil ${m.sample1x2Profiles.toLocaleString()}`,
  });

  const drift1x2 = m.pillar2_marketDrift.filter((r) => r.market === "HOME_DRAW_AWAY:FULL_TIME");
  for (const row of drift1x2) {
    const label =
      row.move === "shortened"
        ? "Kısalan oran (steam)"
        : row.move === "lengthened"
          ? "Uzayan oran (drift)"
          : "Stabil";
    out.push({
      title: `MS 1X2 · ${label}`,
      body: `n=${row.n} · gerçek ${fmtPct(row.winPct)} vs kapanış implied ${fmtPct(row.impliedClosePct)} (${fmtPp(row.edgeClosePp)})`,
    });
  }

  for (const [key, v] of Object.entries(m.pillar3_similarOdds.byOutcome)) {
    const side = key.replace("1X2:", "");
    const lift = v.avgSameOutcomePct - m.pillar3_similarOdds.baselineRandom1x2;
    out.push({
      title: `Benzer oran kümesi · MS ${side}`,
      body: `±${(m.similarOddsTolerance * 100).toFixed(0)}% bandında ortalama %${v.avgSameOutcomePct.toFixed(1)} aynı sonuç (n=${v.anchors}, baseline +${lift.toFixed(1)} pp)`,
    });
  }

  return out;
}

/** Analyze live fixture compact odds for pillar 4. */
export function signalsFromCompactOdds(
  odds: Array<[number, string, string, string, number | null, number | null, boolean]> | null,
  bookmakers: Record<string, string> | null,
): OddsSignal[] {
  if (!odds?.length) return [];
  const out: OddsSignal[] = [];
  for (const row of odds) {
    const [bm, mtype, scope, side, opening, current, active] = row;
    if (!active || opening == null || current == null || current < 1.01 || opening < 1.01) continue;
    const ch = (current - opening) / opening;
    if (Math.abs(ch) < 0.02) continue;
    out.push({
      market: mtype,
      scope,
      side,
      opening,
      closing: current,
      changePct: Math.round(ch * 1000) / 10,
      move: ch <= -0.02 ? "shortened" : "lengthened",
      bookmakerId: bm,
      bookmakerName: bookmakers?.[String(bm)] ?? null,
    });
  }
  return out.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 10);
}

export function hintForSignal(sig: OddsSignal, m: SmartMemory): string {
  const mkey = `${sig.market}:${sig.scope}`;
  const drift = m.pillar2_marketDrift.find((r) => r.market === mkey && r.move === sig.move);
  if (!drift) return "Arşivde bu market/hareket için yeterli örnek yok.";
  return `Arşiv (${drift.n} seçim): ${sig.move === "shortened" ? "kısalma" : "uzama"} sonrası isabet ${fmtPct(drift.winPct)} · implied ${fmtPct(drift.impliedClosePct)}`;
}
