"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FixtureMatchStrip } from "@/components/FixtureMatchStrip";
import { SportSelect, type Sport } from "@/components/SportSelect";
import type { FixtureRow } from "@/lib/archiveCache";
import type { CompactOddsRow } from "@/lib/handball";
import { formatOdds } from "@/lib/format";
import filterStyles from "@/components/AnalyzeFilters.module.css";
import saStyles from "./SmartAnalysisClient.module.css";
import styles from "./HandballPanel.module.css";

type OddsPair = { o: number | null; c: number | null };

type Similar = {
  id: string;
  season: string;
  ts: number;
  home: string;
  away: string;
  hs: string | null;
  as: string | null;
  distance: number;
  odds1x2?: {
    home: OddsPair;
    draw: OddsPair;
    away: OddsPair;
  };
  o1?: number | null;
  c1?: number | null;
  ox?: number | null;
  cx?: number | null;
  o2?: number | null;
  c2?: number | null;
};

type SimState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; rows: Similar[] }
  | { status: "error"; message: string };

type BmOption = { id: string; name: string };

const fmtDate = (ts: number | string | undefined) => {
  if (ts == null || ts === "") return "—";
  if (typeof ts === "string" && /^\d{4}-\d{2}-\d{2}/.test(ts)) return ts.slice(0, 10);
  const n = Number(ts);
  const d = new Date(n < 1e12 ? n * 1000 : n);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
};

const fmtTime = (ts: number | string | undefined) => {
  if (ts == null || ts === "") return "—";
  if (typeof ts === "string" && ts.includes("T")) return ts.slice(11, 16);
  const n = Number(ts);
  const d = new Date(n < 1e12 ? n * 1000 : n);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(11, 16);
};

function ftResult(hs: string | null, as_: string | null): "Home" | "Draw" | "Away" | "" {
  if (hs == null || as_ == null || hs === "" || as_ === "") return "";
  const h = Number(hs);
  const a = Number(as_);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return "";
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

/** Seçili bookmaker için 1X2 açılış/kapanış oranlarını çıkarır (tek satırlık fikstür tablosu için). */
function extractFixture1x2ForBm(odds: CompactOddsRow[] | null | undefined, bmId: number) {
  const out = {
    home: { o: null as number | null, c: null as number | null },
    draw: { o: null as number | null, c: null as number | null },
    away: { o: null as number | null, c: null as number | null },
  };
  if (!odds?.length) return out;

  for (const row of odds) {
    if (Number(row[0]) !== bmId) continue;
    const t = String(row[1] || "").toLowerCase();
    const sc = String(row[2] || "").toLowerCase();
    const side = String(row[3] || "").toLowerCase();

    if ((t !== "1x2" && t !== "home_draw_away" && t !== "match_odds") || (sc !== "full_time" && sc !== "ft")) {
      continue;
    }

    const op = row[4] != null && Number(row[4]) > 1 ? Number(row[4]) : null;
    const cl = row[5] != null && Number(row[5]) > 1 ? Number(row[5]) : null;

    if (side === "home" || side === "1" || side === "h") {
      if (out.home.o == null) out.home.o = op ?? cl;
      if (out.home.c == null) out.home.c = cl ?? op;
    } else if (side === "draw" || side === "x" || side === "d") {
      if (out.draw.o == null) out.draw.o = op ?? cl;
      if (out.draw.c == null) out.draw.c = cl ?? op;
    } else if (side === "away" || side === "2" || side === "a") {
      if (out.away.o == null) out.away.o = op ?? cl;
      if (out.away.c == null) out.away.c = cl ?? op;
    }
  }
  return out;
}

function bmOptionsFromFixture(fx: FixtureRow | null | undefined): BmOption[] {
  if (!fx?.odds?.length) return [];
  const names = (fx.bookmakers ?? {}) as Record<string, string>;
  const counts = new Map<number, number>();
  for (const row of fx.odds) {
    const bid = Number(row[0]);
    if (!Number.isFinite(bid)) continue;
    counts.set(bid, (counts.get(bid) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => ({
      id: String(id),
      name: names[String(id)] || names[id] || `BM ${id}`,
    }));
}

export function HandballPanel({
  sport,
  onSportChange,
}: {
  sport: Sport;
  onSportChange: (s: Sport) => void;
}) {
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [fixtures, setFixtures] = useState<FixtureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [referenceBms, setReferenceBms] = useState<string[]>([]);
  const [simResults, setSimResults] = useState<Record<string, SimState>>({});

  // 1) Gün listesi (fixtureh)
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const res = await fetch("/api/fixtureh?dates=1", { cache: "no-store" });
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
    setReferenceBms([]);
    setSimResults({});
    setError(undefined);
    (async () => {
      try {
        const res = await fetch(`/api/fixtureh?date=${encodeURIComponent(date)}`, {
          cache: "no-store",
        });
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

  const availableBms = useMemo(() => bmOptionsFromFixture(selectedFixture), [selectedFixture]);

  // Maç değişince varsayılan BM: en çok satırlı (liste zaten sıralı)
  useEffect(() => {
    if (!selectedId) {
      setReferenceBms([]);
      setSimResults({});
      return;
    }
    const opts = bmOptionsFromFixture(selectedFixture);
    setReferenceBms(opts.length ? [opts[0].id] : []);
    setSimResults({});
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleBm = useCallback((id: string) => {
    setReferenceBms((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const runSimilar = useCallback(
    async (bmId: string) => {
      if (!selectedId) return;
      const fx = fixtures.find((f) => f.match_id === selectedId);
      const odds = fx?.odds ?? null;
      const bmName = bmOptionsFromFixture(fx).find((b) => b.id === bmId)?.name || "";
      setSimResults((prev) => ({ ...prev, [bmId]: { status: "loading" } }));
      try {
        const res = odds?.length
          ? await fetch("/api/handball/similar", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              cache: "no-store",
              body: JSON.stringify({
                id: selectedId,
                odds,
                bookmakerId: Number(bmId),
                bm: bmName,
              }),
            })
          : await fetch(
              `/api/handball/similar?id=${encodeURIComponent(selectedId)}&bookmakerId=${encodeURIComponent(bmId)}&bm=${encodeURIComponent(bmName)}`,
              { cache: "no-store" },
            );
        const j = await res.json();
        if (res.status === 404) {
          const msg =
            typeof j?.message === "string"
              ? j.message
              : "Benzer maç hesaplanamadı (arşivde yok veya oran yok).";
          setSimResults((prev) => ({ ...prev, [bmId]: { status: "error", message: msg } }));
          return;
        }
        if (!res.ok) throw new Error(j?.error || j?.message || `HTTP ${res.status}`);

        // Hem düz dizi [...] hem { matches: [...] } yanıtlarını destekle
        const list = Array.isArray(j) ? j : Array.isArray(j?.matches) ? j.matches : null;
        if (!list) throw new Error(j?.message || "Beklenmeyen yanıt");

        setSimResults((prev) => ({
          ...prev,
          [bmId]: { status: "done", rows: list as Similar[] },
        }));
      } catch (e) {
        setSimResults((prev) => ({
          ...prev,
          [bmId]: {
            status: "error",
            message: e instanceof Error ? e.message : String(e),
          },
        }));
      }
    },
    [selectedId, fixtures],
  );

  // Seçili BM'ler için sırayla benzerlik çalıştır
  useEffect(() => {
    if (!selectedId || !referenceBms.length) return;
    for (const bmId of referenceBms) {
      const cur = simResults[bmId];
      if (!cur || cur.status === "idle") void runSimilar(bmId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, referenceBms.join(",")]);

  const statsFor = (rows: Similar[]) => {
    let h = 0,
      d = 0,
      a = 0,
      goals = 0,
      n = 0;
    for (const r of rows) {
      const x = Number(r.hs),
        y = Number(r.as);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      n++;
      goals += x + y;
      if (x > y) h++;
      else if (x < y) a++;
      else d++;
    }
    return n ? { h, d, a, n, avg: goals / n } : null;
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
            bookmakerId={Number(referenceBms[0]) || 0}
            loading={loading}
            ignoreOdds
            onSelect={setSelectedId}
          />
        </div>
      </div>

      {selectedFixture && availableBms.length > 0 ? (
        <div className={filterStyles.filterSection}>
          <p className={filterStyles.filterSectionTitle}>
            Reference BMs ({referenceBms.length} selected)
          </p>
          <p className={filterStyles.hint}>
            Select one or more bookmakers — each runs similarity on that BM&apos;s odds profile
            and shows its own section below, in the order you picked them.
          </p>
          <div className={saStyles.tabs}>
            {availableBms.map((b) => (
              <button
                key={b.id}
                type="button"
                className={referenceBms.includes(b.id) ? saStyles.tabActive : saStyles.tab}
                onClick={() => toggleBm(b.id)}
              >
                {b.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className={styles.panel}>
        {error && <p className={`${styles.msg} ${styles.err}`}>{error}</p>}
        {!loading && !error && !fixtures.length && (
          <p className={styles.msg}>No handball matches for this day.</p>
        )}
        {!selectedId && fixtures.length > 0 && (
          <p className={styles.msg}>Select a match to list the most similar matches from the archive.</p>
        )}
        {selectedId && availableBms.length === 0 && (
          <p className={styles.msg}>
            This match has no bookmaker odds yet. Similarity needs odds (or an archive vector).
          </p>
        )}
        {selectedId && availableBms.length > 0 && referenceBms.length === 0 && (
          <p className={saStyles.empty}>Pick at least one reference bookmaker above.</p>
        )}

        {referenceBms.map((bmId) => {
          const bmName = availableBms.find((b) => b.id === bmId)?.name || `BM ${bmId}`;
          const sim = simResults[bmId] ?? { status: "idle" as const };
          const fx1x2 = extractFixture1x2ForBm(selectedFixture?.odds, Number(bmId));
          const stats = sim.status === "done" ? statsFor(sim.rows) : null;

          return (
            <section key={bmId} className={saStyles.card}>
              <h3>{bmName} — similar matches</h3>

              {selectedFixture ? (
                <div className={saStyles.bmOpenedOdds}>
                  <p className={saStyles.cardLead}>{bmName} — odds for this match</p>
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
                          <th className={styles.num}>FT</th>
                          <th>FT RES</th>
                          <th className={styles.num}>1 O</th>
                          <th className={styles.num}>1 C</th>
                          <th className={styles.num}>X O</th>
                          <th className={styles.num}>X C</th>
                          <th className={styles.num}>2 O</th>
                          <th className={styles.num}>2 C</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>fixture</td>
                          <td>{fmtDate((selectedFixture as any).match_time ?? (selectedFixture as any).ts ?? date)}</td>
                          <td>{fmtTime((selectedFixture as any).match_time ?? (selectedFixture as any).ts)}</td>
                          <td>{(selectedFixture as any).league || (selectedFixture as any).season || "—"}</td>
                          <td>{(selectedFixture as any).home_team || (selectedFixture as any).home || "—"}</td>
                          <td>{(selectedFixture as any).away_team || (selectedFixture as any).away || "—"}</td>
                          <td className={styles.num}>—</td>
                          <td>—</td>
                          <td className={styles.num}>{fmtOdd(fx1x2.home.o)}</td>
                          <td className={styles.num}>{fmtOdd(fx1x2.home.c)}</td>
                          <td className={styles.num}>{fmtOdd(fx1x2.draw.o)}</td>
                          <td className={styles.num}>{fmtOdd(fx1x2.draw.c)}</td>
                          <td className={styles.num}>{fmtOdd(fx1x2.away.o)}</td>
                          <td className={styles.num}>{fmtOdd(fx1x2.away.c)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}

              <p className={saStyles.cardLead}>
                Weighted similarity across markets this BM quotes for the match (1X2, O/U, …). Neighbours ranked by odds profile.
              </p>

              {sim.status === "idle" || sim.status === "loading" ? (
                <p className={styles.msg}>Loading archive…</p>
              ) : null}

              {sim.status === "error" ? (
                <>
                  <p className={`${styles.msg} ${styles.err}`}>{sim.message}</p>
                  <button
                    type="button"
                    className={saStyles.secondaryButton}
                    onClick={() => void runSimilar(bmId)}
                  >
                    Retry
                  </button>
                </>
              ) : null}

              {sim.status === "done" ? (
                <>
                  {stats && (
                    <div className={styles.summary}>
                      <span>
                        Home {stats.h} · Draw {stats.d} · Away {stats.a} ({stats.n} matches)
                      </span>
                      <span>Avg total goals: {stats.avg.toFixed(1)}</span>
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
                            <th>SEASON</th>
                            <th>HOME</th>
                            <th>AWAY</th>
                            <th className={styles.num}>FT</th>
                            <th>FT RES</th>
                            <th className={styles.num}>1 O</th>
                            <th className={styles.num}>1 C</th>
                            <th className={styles.num}>X O</th>
                            <th className={styles.num}>X C</th>
                            <th className={styles.num}>2 O</th>
                            <th className={styles.num}>2 C</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sim.rows.map((r) => {
                            const res = ftResult(r.hs, r.as);
                            const o = r.odds1x2;
                            const o1 = o?.home?.o ?? r.o1;
                            const c1 = o?.home?.c ?? r.c1;
                            const ox = o?.draw?.o ?? r.ox;
                            const cx = o?.draw?.c ?? r.cx;
                            const o2 = o?.away?.o ?? r.o2;
                            const c2 = o?.away?.c ?? r.c2;
                            return (
                              <tr key={r.id}>
                                <td>archive</td>
                                <td>{fmtDate(r.ts)}</td>
                                <td>{fmtTime(r.ts)}</td>
                                <td>{r.season}</td>
                                <td>{r.home}</td>
                                <td>{r.away}</td>
                                <td className={styles.num}>
                                  {r.hs != null && r.as != null ? `${r.hs}-${r.as}` : "—"}
                                </td>
                                <td>
                                  {res ? (
                                    <span className={`${styles.resBadge} ${resClass(res)}`}>
                                      {res}
                                    </span>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                                <td className={styles.num}>{fmtOdd(o1)}</td>
                                <td className={styles.num}>{fmtOdd(c1)}</td>
                                <td className={styles.num}>{fmtOdd(ox)}</td>
                                <td className={styles.num}>{fmtOdd(cx)}</td>
                                <td className={styles.num}>{fmtOdd(o2)}</td>
                                <td className={styles.num}>{fmtOdd(c2)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className={saStyles.empty}>No matches under the similarity threshold.</p>
                  )}
                  <button
                    type="button"
                    className={saStyles.secondaryButton}
                    onClick={() => void runSimilar(bmId)}
                  >
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
