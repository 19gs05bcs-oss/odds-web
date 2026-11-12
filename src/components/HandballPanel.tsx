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
};

type SimState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; rows: Similar[] }
  | { status: "error"; message: string };

type BmOption = { id: string; name: string };

const fmtDate = (ts: number) => {
  const d = new Date(ts < 1e12 ? ts * 1000 : ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
};

const fmtTime = (ts: number) => {
  const d = new Date(ts < 1e12 ? ts * 1000 : ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(11, 16);
};

function ftResult(hs: string | null, as_: string | null): "Home" | "Draw" | "Away" | "" {
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

function sideLabel(side: string): string {
  const s = String(side || "").toLowerCase();
  if (s === "home" || s === "1" || s === "h") return "Home";
  if (s === "draw" || s === "x" || s === "d") return "Draw";
  if (s === "away" || s === "2" || s === "a") return "Away";
  if (s.startsWith("over") || s === "o") return side.replace(/^o(ver)?:?/i, "Over ");
  if (s.startsWith("under") || s === "u") return side.replace(/^u(nder)?:?/i, "Under ");
  if (s.startsWith("h:")) return `Home ${s.slice(2)}`;
  if (s.startsWith("a:")) return `Away ${s.slice(2)}`;
  return side;
}

function marketTitle(type: string, scope: string): string {
  const t = String(type || "").toLowerCase();
  const sc = String(scope || "").toLowerCase();
  const scopeLabel =
    sc === "full_time" || sc === "ft" ? "FT" : sc === "1st_half" || sc === "1h" ? "1H" : sc;
  if (t === "1x2" || t === "match_odds") return `1X2 ${scopeLabel}`;
  if (t === "ou" || t === "over_under" || t === "totals") return `O/U ${scopeLabel}`;
  if (t === "ah" || t === "asian_handicap") return `AH ${scopeLabel}`;
  if (t === "dc" || t === "double_chance") return `DC ${scopeLabel}`;
  return `${type} ${scopeLabel}`.trim();
}

/** Compact odds → grouped display for one bookmaker. */
function groupOddsForBm(odds: CompactOddsRow[] | null | undefined, bmId: number) {
  if (!odds?.length) return [] as { title: string; selections: { name: string; open: number | null; close: number | null }[] }[];
  const rows = odds.filter((r) => Number(r[0]) === bmId);
  const map = new Map<string, { name: string; open: number | null; close: number | null }[]>();
  for (const row of rows) {
    const title = marketTitle(String(row[1]), String(row[2]));
    const list = map.get(title) ?? [];
    list.push({
      name: sideLabel(String(row[3])),
      open: row[4] != null && Number(row[4]) > 1 ? Number(row[4]) : null,
      close: row[5] != null && Number(row[5]) > 1 ? Number(row[5]) : null,
    });
    map.set(title, list);
  }
  // Prefer common markets first
  const order = ["1X2 FT", "O/U FT", "AH FT", "1X2 1H", "O/U 1H", "AH 1H"];
  return [...map.entries()]
    .sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a[0].localeCompare(b[0]);
    })
    .map(([title, selections]) => ({ title, selections }));
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
              }),
            })
          : await fetch(
              `/api/handball/similar?id=${encodeURIComponent(selectedId)}&bookmakerId=${encodeURIComponent(bmId)}`,
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
        if (!Array.isArray(j)) throw new Error(j?.message || "Beklenmeyen yanıt");
        setSimResults((prev) => ({
          ...prev,
          [bmId]: { status: "done", rows: j as Similar[] },
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
          const markets = groupOddsForBm(selectedFixture?.odds, Number(bmId));
          const stats = sim.status === "done" ? statsFor(sim.rows) : null;

          return (
            <section key={bmId} className={saStyles.card}>
              <h3>
                {bmName} — similar matches
              </h3>

              {markets.length > 0 ? (
                <div className={saStyles.bmOpenedOdds}>
                  <p className={saStyles.cardLead}>{bmName} — odds for this match</p>
                  <div className={styles.oddsGrid}>
                    {markets.map((m) => (
                      <div key={m.title} className={styles.oddsMarket}>
                        <div className={styles.oddsMarketTitle}>{m.title}</div>
                        <div className={styles.oddsSels}>
                          {m.selections.map((s, i) => (
                            <div key={`${s.name}-${i}`} className={styles.oddsSel}>
                              <span className={styles.oddsName}>{s.name}</span>
                              <span className={styles.oddsPrices}>
                                {s.open != null && (
                                  <span className={styles.oddsOpen} title="Opening">
                                    {formatOdds(s.open)}
                                  </span>
                                )}
                                <span className={styles.oddsClose} title="Current">
                                  {formatOdds(s.close)}
                                </span>
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className={saStyles.cardLead}>No odds rows for {bmName} on this match.</p>
              )}

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
                                <td className={styles.num}>{fmtOdd(o?.home?.o)}</td>
                                <td className={styles.num}>{fmtOdd(o?.home?.c)}</td>
                                <td className={styles.num}>{fmtOdd(o?.draw?.o)}</td>
                                <td className={styles.num}>{fmtOdd(o?.draw?.c)}</td>
                                <td className={styles.num}>{fmtOdd(o?.away?.o)}</td>
                                <td className={styles.num}>{fmtOdd(o?.away?.c)}</td>
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
