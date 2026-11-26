"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FixtureMatchStrip } from "@/components/FixtureMatchStrip";
import { SportSelect, type Sport } from "@/components/SportSelect";
import type { FixtureRow } from "@/lib/archiveCache";
import { bmHasCore, defaultBookmaker, marketSnapshot, type CompactOddsRow } from "@/lib/volleyballOdds";
import { buildSortedBmList } from "@/lib/bmList";
import { formatOdds } from "@/lib/format";
import { clockInTz, dayKeyInTz, todayInTz } from "@/lib/time";
import filterStyles from "@/components/AnalyzeFilters.module.css";
import saStyles from "./SmartAnalysisClient.module.css";
import styles from "./HandballPanel.module.css";

/** Tenis: fixturet'ten günlük maç + bookmaker bazlı ML / AH (oyun) / OU (oyun) oranları.
 *  Arşiv (benzer maç) henüz yok; arşiv eklenince Volleyball/Basketball paneli gibi alt bölüm eklenir. */
type TFixture = FixtureRow & {
  tour?: string | null;
  state?: string | null;
  status?: string | null;
  home_periods?: string | null;
  away_periods?: string | null;
  home_tb?: string | null;
  away_tb?: string | null;
};

type BmOption = { id: string; name: string };

const fmtOdd = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) || v < 1.01 ? "—" : formatOdds(v);

const fmtLine = (v: number | null | undefined) => (v == null ? "—" : v > 0 ? `+${v}` : String(v));

const pair = (o: number | null | undefined, c: number | null | undefined) =>
  o == null && c == null ? "—" : `${fmtOdd(o)} → ${fmtOdd(c)}`;

const STATUS: Record<string, string> = { "8": "RET", "9": "WO" };


const CONSENSUS = "all";
const MAX_SETS = 5;

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function setCells(h: unknown, a: unknown): (string | null)[] {
  const hs = String(h ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const as_ = String(a ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const ok = hs.length > 0 && hs.length === as_.length;
  return Array.from({ length: MAX_SETS }, (_, i) => (ok && i < hs.length ? `${hs[i]}-${as_[i]}` : null));
}

/** Toplam oyun sayısı (tüm setlerin oyunları toplamı). */
function totalGames(fx: TFixture): number | null {
  const h = String(fx.home_periods ?? "").split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
  const a = String(fx.away_periods ?? "").split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
  if (!h.length || h.length !== a.length) return null;
  return [...h, ...a].reduce((p, c) => p + c, 0);
}

function ftResult(hs: unknown, as_: unknown): "Home" | "Away" | "" {
  const h = num(hs);
  const a = num(as_);
  if (h == null || a == null || h === a) return "";
  return h > a ? "Home" : "Away";
}

function totalClass(total: number | null, line: number | null): string {
  if (total == null || line == null) return "";
  if (total === line) return styles.totalPush;
  return total > line ? styles.totalOver : styles.totalUnder;
}

/** Maçta ana marketleri (ML + AH/OU) veren bookmaker'lar. */
function bmOptionsFromFixture(fx: TFixture | null | undefined): BmOption[] {
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

export function TennisPanel({
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
  const [fixtures, setFixtures] = useState<TFixture[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refs, setRefs] = useState<string[]>([]);

  // 1) Gün listesi: bugün-3 ve sonrası, tabloda olan tüm günler
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const res = await fetch("/api/fixturet?dates=1", { cache: "no-store" });
        const j = (await res.json()) as { dates?: string[]; error?: string };
        if (!res.ok) throw new Error(j.error || res.statusText);
        if (off) return;
        const ds = j.dates ?? [];
        setDates(ds);
        const today = todayInTz();
        setDate(ds.includes(today) ? today : ds.find((d) => d > today) ?? ds[ds.length - 1] ?? "");
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
    setError(undefined);
    (async () => {
      try {
        const res = await fetch(`/api/fixturet?date=${encodeURIComponent(date)}`, { cache: "no-store" });
        const j = (await res.json()) as { fixtures?: TFixture[]; error?: string };
        if (!res.ok) throw new Error(j.error || res.statusText);
        if (!off) setFixtures((j.fixtures ?? []).filter((f) => Array.isArray(f.odds) && f.odds.length > 0));
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
  // Sabit, alfabetik BM listesi (maç değişince yerinden oynamaz)
  const allBms = useMemo(() => buildSortedBmList(fixtures, bookmakers), [fixtures, bookmakers]);
  const availableBms = useMemo(() => {
    const have = new Set(fixtureBms.map((b) => b.id));
    return allBms.map((b) => ({ ...b, noData: selectedId ? !have.has(b.id) : false }));
  }, [allBms, fixtureBms, selectedId]);

  const activeRefs = useMemo(() => {
    if (!selectedId) return refs;
    const ok = new Set(fixtureBms.map((b) => b.id));
    return refs.filter((id) => id === CONSENSUS || ok.has(id));
  }, [refs, selectedId, fixtureBms]);

  const selRef = useRef<string | null>(selectedId);
  selRef.current = selectedId;

  // Maç değişince varsayılan: konsensüs; önceki BM seçimleri korunur
  useEffect(() => {
    if (!selectedId || !hasOdds) return;
    setRefs((prev) => {
      const ok = new Set(fixtureBms.map((b) => b.id));
      const kept = prev.filter((id) => id === CONSENSUS || ok.has(id));
      return kept.length ? prev : [CONSENSUS];
    });
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleRef = useCallback((id: string) => {
    setRefs((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

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

      {availableBms.length > 0 ? (
        <div className={filterStyles.filterSection}>
          <p className={filterStyles.filterSectionTitle}>Reference ({activeRefs.length} selected)</p>
          <p className={filterStyles.hint}>
            <b>Consensus</b> = median of all bookmakers (same space as the archive index). Pick a bookmaker to
            match on that BM&apos;s own match-winner / handicap / total profile instead; each selection gets its own
            section below.
          </p>
          <div className={saStyles.tabs}>
            <button
              type="button"
              className={activeRefs.includes(CONSENSUS) ? saStyles.tabActive : saStyles.tab}
              onClick={() => toggleRef(CONSENSUS)}
              disabled={!!selectedId && !hasOdds}
            >
              Consensus
            </button>
            {availableBms.map((b) => (
              <button
                key={b.id}
                type="button"
                className={activeRefs.includes(b.id) ? saStyles.tabActive : saStyles.tab}
                onClick={() => toggleRef(b.id)}
                disabled={b.noData}
                title={b.noData ? "This bookmaker has no match-winner odds for this match" : undefined}
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
        {!loading && !error && !fixtures.length && <p className={styles.msg}>No tennis matches with odds for this day.</p>}
        {!selectedId && fixtures.length > 0 && (
          <p className={styles.msg}>Select a match to see odds by reference bookmaker.</p>
        )}
        {selectedId && hasOdds && activeRefs.length === 0 && (
          <p className={saStyles.empty}>Pick at least one reference above.</p>
        )}

        {selectedFixture &&
          hasOdds &&
          activeRefs.map((refId) => {
            const isCons = refId === CONSENSUS;
            const bmNum = isCons ? defaultBookmaker(fixtureOdds) : Number(refId);
            const label = isCons ? "Consensus" : availableBms.find((b) => b.id === refId)?.name || `BM ${refId}`;
            const shownBm =
              bmNum != null
                ? ((selectedFixture.bookmakers ?? {}) as Record<string, string>)[String(bmNum)]
                : undefined;
            const mk = marketSnapshot(fixtureOdds, bmNum);
            const total = totalGames(selectedFixture);
            const finished = selectedFixture.state === "finished" || selectedFixture.state === "live";
            const st = STATUS[String(selectedFixture.status)];

            return (
              <section key={refId} className={saStyles.card}>
                <h3>{label} — similar matches</h3>
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
                          <th className={styles.num}>Set 1</th>
                          <th className={styles.num}>Set 2</th>
                          <th className={styles.num}>Set 3</th>
                          <th className={styles.num}>Set 4</th>
                          <th className={styles.num}>Set 5</th>
                          <th className={styles.num}>Sets</th>
                          <th className={styles.num}>Total games</th>
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
                          <td>{selectedFixture.league || selectedFixture.tour || "—"}</td>
                          <td>{selectedFixture.home_name || "—"}</td>
                          <td>{selectedFixture.away_name || "—"}</td>
                          {setCells(selectedFixture.home_periods, selectedFixture.away_periods).map((c, i) => (
                            <td key={i} className={styles.num}>{c ?? "—"}</td>
                          ))}
                          <td className={styles.num}>
                            {finished ? `${selectedFixture.home_score ?? "–"}-${selectedFixture.away_score ?? "–"}` : "—"}
                          </td>
                          <td className={`${styles.num} ${totalClass(total, mk.ouLine)}`.trim()}>{total ?? "—"}</td>
                          <td>{st ?? (finished ? ftResult(selectedFixture.home_score, selectedFixture.away_score) || "—" : "—")}</td>
                          <td className={styles.num}>{fmtOdd(mk.ml.ho)}</td>
                          <td className={styles.num}>{fmtOdd(mk.ml.hc)}</td>
                          <td className={styles.num}>{fmtOdd(mk.ml.ao)}</td>
                          <td className={styles.num}>{fmtOdd(mk.ml.ac)}</td>
                          <td className={styles.num}>{fmtLine(mk.ahLine)}</td>
                          <td className={styles.num}>{pair(mk.ahH_o, mk.ahH_c)}</td>
                          <td className={styles.num}>{pair(mk.ahA_o, mk.ahA_c)}</td>
                          <td className={styles.num}>{mk.ouLine ?? "—"}</td>
                          <td className={styles.num}>{pair(mk.ouO_o, mk.ouO_c)}</td>
                          <td className={styles.num}>{pair(mk.ouU_o, mk.ouU_c)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
                <p className={saStyles.empty}>
                  Similar-match archive for tennis is not built yet — neighbours will appear here once the archive exists.
                </p>
              </section>
            );
          })}
      </div>
    </div>
  );
}
