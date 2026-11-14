"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FixtureMatchStrip } from "@/components/FixtureMatchStrip";
import { SportSelect, type Sport } from "@/components/SportSelect";
import type { FixtureRow } from "@/lib/archiveCache";
import {
  bmHasCore,
  defaultBookmaker,
  marketSnapshot,
  type CompactOddsRow,
} from "@/lib/basketballOdds";
import { formatOdds } from "@/lib/format";
import { clockInTz, dayKeyInTz } from "@/lib/time";
import filterStyles from "@/components/AnalyzeFilters.module.css";
import saStyles from "./SmartAnalysisClient.module.css";
import styles from "./HandballPanel.module.css";

/** Basketbol: üstte fixtureb'den canlı/günlük maç + oranlar, altta R2 arşivinden benzer maçlar. */

type Similar = {
  id: string;
  season: string;
  league?: string;
  ts: number;
  home: string;
  away: string;
  hs: string | null;
  as: string | null;
  distance: number;
  tol?: number | null;
  ouLineTol?: number | null;
  probDiff?: number | null;
  date?: string;
  time?: string;
  ft?: string;
  ftRes?: string;
  hts?: string | null;
  ats?: string | null;
  periods?: string | null;
  total?: number | null;
  margin?: number | null;
  o1?: number | null;
  c1?: number | null;
  o2?: number | null;
  c2?: number | null;
  ahLine?: number | null;
  ahH_o?: number | null;
  ahH_c?: number | null;
  ahA_o?: number | null;
  ahA_c?: number | null;
  ouLine?: number | null;
  ouO_o?: number | null;
  ouO_c?: number | null;
  ouU_o?: number | null;
  ouU_c?: number | null;
  bmUsed?: string;
};

type SimState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; rows: Similar[] }
  | { status: "error"; message: string };

type BmOption = { id: string; name: string };

/** "all" = bookmaker medyanı (features.bin ile aynı uzay) */
const CONSENSUS = "all";

const fmtDate = (ts: number | undefined) => {
  if (ts == null) return "—";
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
};
const fmtTime = (ts: number | undefined) => {
  if (ts == null) return "—";
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(11, 16);
};

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function scorePair(a: unknown, b: unknown): string {
  if (a == null || b == null || a === "" || b === "") return "—";
  return `${a}-${b}`;
}

function fixtureTotalNum(fx: FixtureRow): number | null {
  const h = num(fx.home_score);
  const a = num(fx.away_score);
  return h != null && a != null ? h + a : null;
}

function ftResult(hs: unknown, as_: unknown): "Home" | "Away" | "Draw" | "" {
  const h = num(hs);
  const a = num(as_);
  if (h == null || a == null) return "";
  return h > a ? "Home" : h < a ? "Away" : "Draw";
}

function resClass(res: string): string {
  if (res === "Home") return styles.resHome;
  if (res === "Away") return styles.resAway;
  if (res === "Draw") return styles.resDraw;
  return "";
}

function fmtOdd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v < 1.01) return "—";
  return formatOdds(v);
}

type Outcome = "hit" | "miss" | "void" | null;

function oddClass(oc: Outcome): string {
  if (oc === "hit") return styles.outcomeWin;
  if (oc === "miss") return styles.outcomeLose;
  if (oc === "void") return styles.outcomeVoid;
  return "";
}

function settleMl(side: "H" | "A", hs: number | null, as_: number | null): Outcome {
  if (hs == null || as_ == null || hs === as_) return null;
  return (hs > as_ ? "H" : "A") === side ? "hit" : "miss";
}

function settleOu(side: "O" | "U", total: number | null, line: number | null): Outcome {
  if (total == null || line == null) return null;
  if (total === line) return "void";
  const over = total > line;
  return side === "O" ? (over ? "hit" : "miss") : over ? "miss" : "hit";
}

function settleAh(side: "H" | "A", hs: number | null, as_: number | null, line: number | null): Outcome {
  if (hs == null || as_ == null || line == null) return null;
  const adj = hs + line - as_;
  if (adj === 0) return "void";
  return side === "H" ? (adj > 0 ? "hit" : "miss") : adj < 0 ? "hit" : "miss";
}

function totalClass(total: number | null | undefined, line: number | null | undefined): string {
  if (total == null || line == null) return "";
  if (total === line) return styles.totalPush;
  return total > line ? styles.totalOver : styles.totalUnder;
}

function cellOdd(v: number | null | undefined, oc: Outcome) {
  return <td className={`${styles.num} ${oddClass(oc)}`.trim()}>{fmtOdd(v)}</td>;
}

/** Maçta ana marketleri (ML + AH/OU) veren bookmaker'lar; verisi olanlar önce. */
function bmOptionsFromFixture(fx: FixtureRow | null | undefined): BmOption[] {
  const odds = fx?.odds as CompactOddsRow[] | null | undefined;
  if (!odds?.length) return [];
  const names = (fx?.bookmakers ?? {}) as Record<string, string>;
  const counts = new Map<number, number>();
  for (const row of odds) {
    const bid = Number(row[0]);
    if (Number.isFinite(bid)) counts.set(bid, (counts.get(bid) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([id]) => bmHasCore(odds, id))
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => ({ id: String(id), name: names[String(id)] || `BM ${id}` }));
}

export function BasketballPanel({
  sport,
  onSportChange,
  bookmakers = [],
}: {
  sport: Sport;
  onSportChange: (s: Sport) => void;
  bookmakers?: BmOption[];
}) {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [fixtures, setFixtures] = useState<FixtureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refs, setRefs] = useState<string[]>([]);
  const [simResults, setSimResults] = useState<Record<string, SimState>>({});

  // 1) Gün listesi (fixtureb)
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const res = await fetch("/api/fixtureb?dates=1", { cache: "no-store" });
        const j = (await res.json()) as { dates?: string[]; error?: string };
        if (!res.ok) throw new Error(j.error || res.statusText);
        if (off) return;
        const ds = j.dates ?? [];
        setDates(ds);
        const today = new Date().toISOString().slice(0, 10);
        setDate(ds.includes(today) ? today : ds[0] ?? "");
        if (!ds.length) setLoading(false);
      } catch (e) {
        if (off) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
    return () => {
      off = true;
    };
  }, []);

  // 2) Seçili günün maçları
  useEffect(() => {
    if (!date) return;
    let off = false;
    setLoading(true);
    setSelectedId(null);
    setRefs([]);
    setSimResults({});
    setError(undefined);
    (async () => {
      try {
        const res = await fetch(`/api/fixtureb?date=${encodeURIComponent(date)}`, { cache: "no-store" });
        const j = (await res.json()) as { fixtures?: FixtureRow[]; error?: string };
        if (!res.ok) throw new Error(j.error || res.statusText);
        if (!off) setFixtures(j.fixtures ?? []);
      } catch (e) {
        if (!off) {
          setFixtures([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!off) setLoading(false);
      }
    })();
    return () => {
      off = true;
    };
  }, [date]);

  const selectedFixture = useMemo(
    () => fixtures.find((f) => f.match_id === selectedId) ?? null,
    [fixtures, selectedId],
  );
  const fixtureOdds = (selectedFixture?.odds ?? null) as CompactOddsRow[] | null;
  const hasOdds = !!fixtureOdds?.length;

  const fixtureBms = useMemo(() => bmOptionsFromFixture(selectedFixture), [selectedFixture]);
  const availableBms = useMemo(() => {
    const have = new Set(fixtureBms.map((b) => b.id));
    const rest = bookmakers
      .filter((b) => !have.has(String(b.id)))
      .map((b) => ({ id: String(b.id), name: b.name, noData: true }));
    return [...fixtureBms.map((b) => ({ ...b, noData: false })), ...rest];
  }, [fixtureBms, bookmakers]);

  // Maç değişince varsayılan: konsensüs (features.bin ile aynı uzay)
  useEffect(() => {
    setSimResults({});
    setRefs(selectedId && hasOdds ? [CONSENSUS] : []);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleRef = useCallback((id: string) => {
    setRefs((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const runSimilar = useCallback(
    async (refId: string) => {
      if (!selectedId) return;
      const fx = fixtures.find((f) => f.match_id === selectedId);
      const odds = fx?.odds ?? null;
      const isCons = refId === CONSENSUS;
      const bmName = isCons ? "" : bmOptionsFromFixture(fx).find((b) => b.id === refId)?.name || "";
      setSimResults((prev) => ({ ...prev, [refId]: { status: "loading" } }));
      try {
        const res = odds?.length
          ? await fetch("/api/basketball/similar", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              cache: "no-store",
              body: JSON.stringify({
                id: selectedId,
                odds,
                bookmakerId: isCons ? null : Number(refId),
                bm: bmName,
              }),
            })
          : await fetch(
              `/api/basketball/similar?id=${encodeURIComponent(selectedId)}` +
                (isCons ? "" : `&bookmakerId=${encodeURIComponent(refId)}&bm=${encodeURIComponent(bmName)}`),
              { cache: "no-store" },
            );
        const j = await res.json();
        if (!res.ok) {
          throw new Error(
            typeof j?.message === "string" ? j.message : j?.error || `HTTP ${res.status}`,
          );
        }
        const list = Array.isArray(j) ? j : Array.isArray(j?.matches) ? j.matches : null;
        if (!list) throw new Error(j?.message || "Unexpected response");
        setSimResults((prev) => ({ ...prev, [refId]: { status: "done", rows: list as Similar[] } }));
      } catch (e) {
        setSimResults((prev) => ({
          ...prev,
          [refId]: { status: "error", message: e instanceof Error ? e.message : String(e) },
        }));
      }
    },
    [selectedId, fixtures],
  );

  useEffect(() => {
    if (!selectedId || !refs.length) return;
    for (const id of refs) {
      const cur = simResults[id];
      if (!cur || cur.status === "idle") void runSimilar(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, refs.join(",")]);

  const statsFor = (rows: Similar[]) => {
    let h = 0,
      a = 0,
      n = 0,
      totalSum = 0,
      marginSum = 0,
      over = 0,
      under = 0,
      ahHome = 0,
      ahAway = 0;
    for (const r of rows) {
      const x = num(r.hs);
      const y = num(r.as);
      if (x == null || y == null) continue;
      n++;
      totalSum += x + y;
      marginSum += x - y;
      if (x > y) h++;
      else if (y > x) a++;
      if (r.ouLine != null) {
        if (x + y > r.ouLine) over++;
        else if (x + y < r.ouLine) under++;
      }
      if (r.ahLine != null) {
        const adj = x + r.ahLine - y;
        if (adj > 0) ahHome++;
        else if (adj < 0) ahAway++;
      }
    }
    return n ? { h, a, n, avg: totalSum / n, margin: marginSum / n, over, under, ahHome, ahAway } : null;
  };

  return (
    <div className={filterStyles.wrap}>
      <div className={filterStyles.topBar}>
        <div className={filterStyles.topBarRow}>
          <SportSelect value={sport} onChange={onSportChange} />
          <label className={filterStyles.field}>
            <span>Day</span>
            <select value={date} onChange={(e) => setDate(e.target.value)} disabled={loading}>
              {dates.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <FixtureMatchStrip
            fixtures={fixtures}
            selectedId={selectedId}
            bookmakerId={0}
            loading={loading}
            ignoreOdds
            onSelect={setSelectedId}
          />
        </div>
      </div>

      {selectedFixture && hasOdds ? (
        <div className={filterStyles.filterSection}>
          <p className={filterStyles.filterSectionTitle}>Reference ({refs.length} selected)</p>
          <p className={filterStyles.hint}>
            <b>Consensus</b> = median of all bookmakers (same space as the archive index). Pick a bookmaker to
            match on that BM&apos;s own ML / AH / O-U profile instead; each selection gets its own section below.
          </p>
          <div className={saStyles.tabs}>
            <button
              type="button"
              className={refs.includes(CONSENSUS) ? saStyles.tabActive : saStyles.tab}
              onClick={() => toggleRef(CONSENSUS)}
            >
              Consensus
            </button>
            {availableBms.map((b) => (
              <button
                key={b.id}
                type="button"
                className={refs.includes(b.id) ? saStyles.tabActive : saStyles.tab}
                onClick={() => toggleRef(b.id)}
                disabled={b.noData}
                title={b.noData ? "This bookmaker has no main-market odds (ML / AH / O-U) for this match" : undefined}
                style={b.noData ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
              >
                {b.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className={styles.panel}>
        {error && <p className={`${styles.msg} ${styles.err}`}>{error}</p>}
        {!loading && !error && !fixtures.length && <p className={styles.msg}>No basketball matches for this day.</p>}
        {!selectedId && fixtures.length > 0 && (
          <p className={styles.msg}>Select a match to list the most similar matches from the archive.</p>
        )}
        {selectedId && !hasOdds && (
          <p className={styles.msg}>
            This match has no bookmaker odds yet. Similarity needs odds (or an archive vector).
          </p>
        )}
        {selectedId && hasOdds && refs.length === 0 && (
          <p className={saStyles.empty}>Pick at least one reference above.</p>
        )}

        {refs.map((refId) => {
          const isCons = refId === CONSENSUS;
          const bmNum = isCons ? defaultBookmaker(fixtureOdds) : Number(refId);
          const label = isCons
            ? "Consensus"
            : availableBms.find((b) => b.id === refId)?.name || `BM ${refId}`;
          const shownBm = bmNum != null ? ((selectedFixture?.bookmakers ?? {}) as Record<string, string>)[String(bmNum)] : undefined;
          const sim = simResults[refId] ?? { status: "idle" as const };
          const mk = marketSnapshot(fixtureOdds, bmNum);
          const stats = sim.status === "done" ? statsFor(sim.rows) : null;
          const first = sim.status === "done" ? sim.rows[0] : undefined;

          return (
            <section key={refId} className={saStyles.card}>
              <h3>{label} — similar matches</h3>
              {first?.tol != null ? (
                <p className={filterStyles.hint}>
                  Win-prob tolerance: ±{Math.round((first.tol as number) * 100)} pts
                  {first.ouLineTol != null
                    ? ` · O/U line: ±${first.ouLineTol}${first.ouLineTol <= 0.5 ? " (same line)" : " (same line first)"}`
                    : ""}
                </p>
              ) : null}

              {selectedFixture ? (
                <div className={saStyles.bmOpenedOdds}>
                  <p className={saStyles.cardLead}>
                    {isCons ? `Odds shown from ${shownBm ?? "—"} (most complete BM)` : `${label} — odds for this match`}
                  </p>
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>SRC</th>
                          <th>DATE</th>
                          <th>TIME</th>
                          <th>LEAGUE</th>
                          <th>HOME</th>
                          <th>AWAY</th>
                          <th className={styles.num}>HT</th>
                          <th className={styles.num}>FT</th>
                          <th className={styles.num}>Total</th>
                          <th>RES</th>
                          <th className={styles.num}>1 O</th>
                          <th className={styles.num}>1 C</th>
                          <th className={styles.num}>2 O</th>
                          <th className={styles.num}>2 C</th>
                          <th className={styles.num}>AH</th>
                          <th className={styles.num}>AH H</th>
                          <th className={styles.num}>AH A</th>
                          <th className={styles.num}>OU</th>
                          <th className={styles.num}>O</th>
                          <th className={styles.num}>U</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>fixture</td>
                          <td>{dayKeyInTz(selectedFixture.kickoff_at) || date || "—"}</td>
                          <td>{clockInTz(selectedFixture.kickoff_at) || "—"}</td>
                          <td>{selectedFixture.league || "—"}</td>
                          <td>{selectedFixture.home_name || "—"}</td>
                          <td>{selectedFixture.away_name || "—"}</td>
                          <td className={styles.num}>
                            {scorePair(selectedFixture.home_ht_score, selectedFixture.away_ht_score)}
                          </td>
                          <td className={styles.num}>
                            {scorePair(selectedFixture.home_score, selectedFixture.away_score)}
                          </td>
                          <td className={`${styles.num} ${totalClass(fixtureTotalNum(selectedFixture), mk.ouLine)}`.trim()}>
                            {fixtureTotalNum(selectedFixture) ?? "—"}
                          </td>
                          <td>{ftResult(selectedFixture.home_score, selectedFixture.away_score) || "—"}</td>
                          <td className={styles.num}>{fmtOdd(mk.ml.ho)}</td>
                          <td className={styles.num}>{fmtOdd(mk.ml.hc)}</td>
                          <td className={styles.num}>{fmtOdd(mk.ml.ao)}</td>
                          <td className={styles.num}>{fmtOdd(mk.ml.ac)}</td>
                          <td className={styles.num}>{mk.ahLine ?? "—"}</td>
                          <td className={styles.num}>{fmtOdd(mk.ahH_c ?? mk.ahH_o)}</td>
                          <td className={styles.num}>{fmtOdd(mk.ahA_c ?? mk.ahA_o)}</td>
                          <td className={styles.num}>{mk.ouLine ?? "—"}</td>
                          <td className={styles.num}>{fmtOdd(mk.ouO_c ?? mk.ouO_o)}</td>
                          <td className={styles.num}>{fmtOdd(mk.ouU_c ?? mk.ouU_o)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              <p className={saStyles.cardLead}>
                Neighbours ranked by closing ML probability, main AH line &amp; probability, main total line &amp;
                over probability (bookmaker {isCons ? "median" : "profile"}).
              </p>

              {sim.status === "idle" || sim.status === "loading" ? <p className={styles.msg}>Loading archive…</p> : null}

              {sim.status === "error" ? (
                <>
                  <p className={`${styles.msg} ${styles.err}`}>{sim.message}</p>
                  <button type="button" className={saStyles.secondaryButton} onClick={() => void runSimilar(refId)}>
                    Retry
                  </button>
                </>
              ) : null}

              {sim.status === "done" ? (
                <>
                  {stats && (
                    <div className={styles.summary}>
                      <span>
                        Home {stats.h} · Away {stats.a} ({stats.n} matches)
                      </span>
                      <span>Avg total: {stats.avg.toFixed(1)}</span>
                      <span>
                        Avg margin: {stats.margin >= 0 ? "+" : ""}
                        {stats.margin.toFixed(1)}
                      </span>
                      <span>
                        Over {stats.over} · Under {stats.under}
                      </span>
                      <span>
                        AH Home {stats.ahHome} · Away {stats.ahAway}
                      </span>
                    </div>
                  )}
                  {sim.rows.length ? (
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>SRC</th>
                            <th>DATE</th>
                            <th>TIME</th>
                            <th>LEAGUE</th>
                            <th>HOME</th>
                            <th>AWAY</th>
                            <th className={styles.num}>HT</th>
                            <th className={styles.num}>FT</th>
                            <th className={styles.num}>Total</th>
                            <th>RES</th>
                            <th className={styles.num}>1 O</th>
                            <th className={styles.num}>1 C</th>
                            <th className={styles.num}>2 O</th>
                            <th className={styles.num}>2 C</th>
                            <th className={styles.num}>AH</th>
                            <th className={styles.num}>AH H</th>
                            <th className={styles.num}>AH A</th>
                            <th className={styles.num}>OU</th>
                            <th className={styles.num}>O</th>
                            <th className={styles.num}>U</th>
                            <th>BM</th>
                            <th className={styles.num}>Dist</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sim.rows.map((r) => {
                            const res = ftResult(r.hs, r.as);
                            const hsN = num(r.hs);
                            const asN = num(r.as);
                            const total = r.total ?? (hsN != null && asN != null ? hsN + asN : null);
                            const ht = r.hts != null && r.ats != null ? `${r.hts}-${r.ats}` : "—";
                            return (
                              <tr key={r.id} title={r.periods ? `Quarters: ${r.periods}` : undefined}>
                                <td>archive</td>
                                <td>{r.date || fmtDate(r.ts)}</td>
                                <td>{r.time || fmtTime(r.ts)}</td>
                                <td>{r.league || r.season}</td>
                                <td>{r.home}</td>
                                <td>{r.away}</td>
                                <td className={styles.num}>{ht}</td>
                                <td className={styles.num}>{r.ft || scorePair(r.hs, r.as)}</td>
                                <td className={`${styles.num} ${totalClass(total, r.ouLine)}`.trim()}>{total ?? "—"}</td>
                                <td>
                                  {res ? (
                                    <span className={`${styles.resBadge} ${resClass(res)}`}>{res}</span>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                                {cellOdd(r.o1, settleMl("H", hsN, asN))}
                                {cellOdd(r.c1, settleMl("H", hsN, asN))}
                                {cellOdd(r.o2, settleMl("A", hsN, asN))}
                                {cellOdd(r.c2, settleMl("A", hsN, asN))}
                                <td className={styles.num}>{r.ahLine ?? "—"}</td>
                                {cellOdd(r.ahH_c ?? r.ahH_o, settleAh("H", hsN, asN, r.ahLine ?? null))}
                                {cellOdd(r.ahA_c ?? r.ahA_o, settleAh("A", hsN, asN, r.ahLine ?? null))}
                                <td className={styles.num}>{r.ouLine ?? "—"}</td>
                                {cellOdd(r.ouO_c ?? r.ouO_o, settleOu("O", total, r.ouLine ?? null))}
                                {cellOdd(r.ouU_c ?? r.ouU_o, settleOu("U", total, r.ouLine ?? null))}
                                <td>{r.bmUsed ?? "—"}</td>
                                <td className={styles.num}>{r.distance != null ? r.distance.toFixed(2) : "—"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className={saStyles.empty}>No matches under the similarity threshold.</p>
                  )}
                  <button type="button" className={saStyles.secondaryButton} onClick={() => void runSimilar(refId)}>
                    Recompute
                  </button>
                </>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
