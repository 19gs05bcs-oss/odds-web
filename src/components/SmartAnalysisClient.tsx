"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnalyzeTable } from "@/components/AnalyzeTable";
import { FixtureMatchStrip } from "@/components/FixtureMatchStrip";
import type { SmartMatchReport } from "@/lib/analysis/smartMatchReport";
import { PREFERRED_BM } from "@/lib/analysis/tableRows";
import type { TableRow } from "@/lib/analysis/tableRows";
type SimilarityCardState = {
  status: "idle" | "loading" | "done" | "error";
  matchedCount?: number;
  usedCodes?: string[];
  tableRows?: (TableRow & { similarityScore?: number })[];
  cached?: boolean;
  computedAt?: string;
  durationMs?: number;
  error?: string;
};
import type { BookmakerOption } from "@/lib/types";
import type { FixtureRow } from "@/lib/fixtures";
import { formatCount, formatKickoff, formatOdds } from "@/lib/format";
import filterStyles from "./AnalyzeFilters.module.css";
import styles from "./SmartAnalysisClient.module.css";

type ArchiveWarm = {
  status: "idle" | "loading" | "ready" | "error";
  phase?: "idle" | "listing" | "downloading";
  files: number;
  filesDone: number;
  matches: number;
  error?: string;
};

type Props = {
  bookmakers: BookmakerOption[];
  fixtureDates: string[];
  initialBulletinDate: string;
};

function sideTr(s: string | null): string {
  if (s === "H") return "1 (Home)";
  if (s === "D") return "X (Draw)";
  if (s === "A") return "2 (Away)";
  return s || "—";
}

export function SmartAnalysisClient({
  bookmakers,
  fixtureDates,
  initialBulletinDate,
}: Props) {
  const [bulletinDate, setBulletinDate] = useState(initialBulletinDate);
  const [fixtures, setFixtures] = useState<FixtureRow[]>([]);
  const [fixturesLoading, setFixturesLoading] = useState(!!initialBulletinDate);
  const [oddsLoading, setOddsLoading] = useState(false);
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(null);
  const [referenceBm, setReferenceBm] = useState(String(PREFERRED_BM));
  const [tolerancePct, setTolerancePct] = useState("3");
  const [report, setReport] = useState<SmartMatchReport | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [simState, setSimState] = useState<SimilarityCardState>({ status: "idle" });
  const [archiveWarm, setArchiveWarm] = useState<ArchiveWarm>({
    status: "idle",
    phase: "idle",
    files: 0,
    filesDone: 0,
    matches: 0,
  });

  const bmNum = Number(referenceBm) || PREFERRED_BM;
  const bmName = bookmakers.find((b) => b.id === referenceBm)?.name || "";
  const selectedFixture = useMemo(
    () => fixtures.find((f) => f.match_id === selectedFixtureId) ?? null,
    [fixtures, selectedFixtureId],
  );

  const tolNum = Number(tolerancePct);
  const tolSafe = Number.isFinite(tolNum) && tolNum >= 0 ? tolNum / 100 : 0.03;

  async function applyOddsPatches(
    patches: Array<Pick<FixtureRow, "match_id" | "odds" | "bookmakers" | "odds_count">>,
  ) {
    if (!patches.length) return;
    const patch = new Map(patches.map((r) => [r.match_id, r] as const));
    setFixtures((prev) =>
      prev.map((f) => {
        const o = patch.get(f.match_id);
        return o
          ? { ...f, odds: o.odds, bookmakers: o.bookmakers, odds_count: o.odds_count ?? f.odds_count }
          : f;
      }),
    );
  }

  async function loadOddsShards(meta: FixtureRow[]) {
    const ids = meta.map((f) => f.match_id);
    const chunkSize = Math.ceil(ids.length / 8);
    const slices: string[][] = [];
    for (let i = 0; i < ids.length; i += chunkSize) slices.push(ids.slice(i, i + chunkSize));
    await Promise.all(
      slices.map(async (slice) => {
        const res = await fetch(
          `/api/fixtures?phase=odds&ids=${encodeURIComponent(slice.join(","))}`,
          { cache: "no-store" },
        );
        if (res.ok) {
          const j = (await res.json()) as {
            fixtures?: Array<Pick<FixtureRow, "match_id" | "odds" | "bookmakers" | "odds_count">>;
          };
          await applyOddsPatches(j.fixtures ?? []);
        }
      }),
    );
  }

  async function loadFixturesForDate(date: string) {
    setFixturesLoading(true);
    setOddsLoading(false);
    setSelectedFixtureId(null);
    setReport(null);
    setError(undefined);
    try {
      const metaRes = await fetch(`/api/fixtures?phase=meta&date=${encodeURIComponent(date)}`, {
        cache: "no-store",
      });
      const metaJson = (await metaRes.json()) as { fixtures?: FixtureRow[]; error?: string };
      if (!metaRes.ok) throw new Error(metaJson.error || metaRes.statusText);
      const meta = metaJson.fixtures ?? [];
      setFixtures(meta);
      setFixturesLoading(false);
      if (!meta.length) return;
      setOddsLoading(true);
      await loadOddsShards(meta);
    } catch (e) {
      setFixtures([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFixturesLoading(false);
      setOddsLoading(false);
    }
  }

  const runAnalysis = useCallback(async () => {
    if (!selectedFixture?.odds?.length) return;
    setPending(true);
    setError(undefined);
    try {
      const res = await fetch("/api/smart-analysis/match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fixture: selectedFixture,
          referenceBm: bmNum,
          tolerancePct: tolSafe,
        }),
      });
      const j = (await res.json()) as {
        ok?: boolean;
        error?: string;
        report?: SmartMatchReport;
        archiveStatus?: ArchiveWarm;
      };
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setReport(j.report ?? null);
      if (j.archiveStatus) {
        setArchiveWarm({
          status: j.archiveStatus.status ?? "idle",
          phase: j.archiveStatus.phase,
          files: j.archiveStatus.files ?? 0,
          filesDone: j.archiveStatus.filesDone ?? 0,
          matches: j.archiveStatus.matches ?? 0,
          error: j.archiveStatus.error,
        });
      }
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }, [selectedFixture, bmNum, tolSafe]);

  useEffect(() => {
    if (!bulletinDate) return;
    void loadFixturesForDate(bulletinDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulletinDate]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    function applyStatus(j: ArchiveWarm & { ok?: boolean; status?: ArchiveWarm["status"] }) {
      if (cancelled) return;
      setArchiveWarm({
        status: j.status ?? "idle",
        phase: j.phase,
        files: j.files ?? 0,
        filesDone: j.filesDone ?? 0,
        matches: j.matches ?? 0,
        error: j.error,
      });
    }

    async function poll() {
      try {
        const res = await fetch("/api/smart-analysis/warm", {
          cache: "no-store",
          credentials: "include",
          signal: AbortSignal.timeout(30_000),
        });
        const j = (await res.json()) as ArchiveWarm & { ok?: boolean; error?: string };
        if (!res.ok) {
          applyStatus({
            status: "error",
            files: j.files ?? 0,
            filesDone: j.filesDone ?? 0,
            matches: j.matches ?? 0,
            error: j.error || "Failed to load archive",
          });
          if (timer) clearInterval(timer);
          return;
        }
        applyStatus(j);
        if (j.status === "ready" || j.status === "error") {
          if (timer) clearInterval(timer);
        }
      } catch {
        /* sunucu meşgul — polling devam, son bilinen durum korunur */
      }
    }

    void poll();
    timer = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!selectedFixture?.odds?.length) return;
    if (archiveWarm.status !== "ready") return;
    void runAnalysis();
  }, [selectedFixtureId, selectedFixture?.odds?.length, referenceBm, tolerancePct, archiveWarm.status, runAnalysis]);

  // Maç veya referans bookmaker değiştiğinde önceki similarity sonucu artık
  // geçersiz — kart "idle"a dönsün, otomatik yeniden hesaplamıyoruz (bkz.
  // runSimilarity: ~2-3 dk sürebiliyor, kullanıcı butona basınca çalışır).
  useEffect(() => {
    setSimState({ status: "idle" });
  }, [selectedFixtureId, referenceBm]);

  const runSimilarity = useCallback(
    async (force = false) => {
      if (!selectedFixture?.match_id || !bmName) return;
      setSimState({ status: "loading" });
      try {
        const res = await fetch("/api/smart-analysis/similarity", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ eventId: selectedFixture.match_id, bookmaker: bmName, force }),
        });
        const j = (await res.json()) as {
          ok?: boolean;
          error?: string;
          cached?: boolean;
          computedAt?: string;
          matchedCount?: number;
          usedCodes?: string[];
          durationMs?: number;
          tableRows?: (TableRow & { similarityScore?: number })[];
        };
        if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setSimState({
          status: "done",
          matchedCount: j.matchedCount,
          usedCodes: j.usedCodes,
          tableRows: j.tableRows,
          cached: j.cached,
          computedAt: j.computedAt,
          durationMs: j.durationMs,
        });
      } catch (e) {
        setSimState({ status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    },
    [selectedFixture?.match_id, bmName],
  );

  const archiveLabel =
    archiveWarm.status === "ready"
      ? `${formatCount(archiveWarm.matches)} matches · ${archiveWarm.files} seasons`
      : archiveWarm.status === "loading"
        ? archiveWarm.phase === "listing"
          ? "Fetching archive season list…"
          : `Loading archive ${archiveWarm.filesDone}/${archiveWarm.files || "…"} seasons…`
        : archiveWarm.status === "error"
          ? archiveWarm.error || "Archive error"
          : "Preparing archive…";

  return (
    <div className={styles.wrap}>
      <header className={styles.hero}>
        <p className={styles.kicker}>Smart Analysis · Pro</p>
        <h1 className={styles.title}>Select match → archive breakdown</h1>
        <p className={styles.lead}>
          Select a match from the bulletin; similar odds history, odds movement (steam/drift) and
          bookmaker comparison are shown.
        </p>
        <p className={styles.meta}>Archive: {archiveLabel}</p>
      </header>

      <div className={filterStyles.wrap}>
        <div className={filterStyles.topBar}>
          <div className={filterStyles.topBarRow}>
            <label className={filterStyles.field}>
              <span>Day</span>
              <select
                value={bulletinDate}
                onChange={(e) => setBulletinDate(e.target.value)}
                disabled={fixturesLoading}
              >
                {fixtureDates.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>

            <label className={filterStyles.field}>
              <span>Reference BM</span>
              <select value={referenceBm} onChange={(e) => setReferenceBm(e.target.value)}>
                {bookmakers.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>

            <label className={filterStyles.field}>
              <span>Tolerance %</span>
              <input
                type="number"
                min={0}
                max={15}
                step={0.5}
                value={tolerancePct}
                onChange={(e) => setTolerancePct(e.target.value)}
                className={styles.tolInput}
              />
            </label>

            <FixtureMatchStrip
              fixtures={fixtures}
              selectedId={selectedFixtureId}
              bookmakerId={bmNum}
              loading={fixturesLoading}
              oddsLoading={oddsLoading}
              onSelect={setSelectedFixtureId}
            />
          </div>
        </div>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}
      {archiveWarm.status === "loading" ? (
        <p className={styles.loading}>{archiveLabel}</p>
      ) : null}
      {pending ? <p className={styles.loading}>Calculating analysis…</p> : null}

      {!selectedFixture && !fixturesLoading ? (
        <p className={styles.empty}>Select a match from the bulletin.</p>
      ) : null}

      {report ? (
        <>
          <section className={styles.card}>
            <h2>
              {report.home} – {report.away}
            </h2>
            <p className={styles.cardLead}>
              {report.league} · {report.kickoff ? formatKickoff(report.kickoff) : "—"}
              {report.profile1x2 ? (
                <>
                  {" "}
                  · 1X2 (BM #{report.referenceBm}):{" "}
                  <strong>
                    {formatOdds(report.profile1x2.H)} / {formatOdds(report.profile1x2.D)} /{" "}
                    {formatOdds(report.profile1x2.A)}
                  </strong>
                </>
              ) : null}
            </p>
            <ul className={styles.summaryList}>
              {report.summary.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </section>

          {report.selectedRow ? (
            <section className={styles.card}>
              <h3>Selected match odds</h3>
              <AnalyzeTable rows={[report.selectedRow]} mode="bulletin" compact />
            </section>
          ) : null}

          <section className={styles.card}>
            <h3>Similar odds history (1X2)</h3>
            <p className={styles.cardLead}>
              ±{(report.tolerancePct * 100).toFixed(0)}% band,{" "}
              <strong>{report.similar1x2.n}</strong> finished matches.
              {report.similar1x2.n >= 5 ? (
                <>
                  {" "}
                  Most frequent: <strong>{sideTr(report.similar1x2.top)}</strong> (
                  {report.similar1x2.topPct.toFixed(0)}%)
                </>
              ) : (
                " Not enough samples — increase tolerance."
              )}
            </p>
            {report.similar1x2.n >= 5 ? (
              <div className={styles.outcomeBar}>
                <div className={styles.barH} style={{ width: `${(report.similar1x2.H / report.similar1x2.n) * 100}%` }} title="1" />
                <div className={styles.barD} style={{ width: `${(report.similar1x2.D / report.similar1x2.n) * 100}%` }} title="X" />
                <div className={styles.barA} style={{ width: `${(report.similar1x2.A / report.similar1x2.n) * 100}%` }} title="2" />
              </div>
            ) : null}
            {report.similarTableRows.length ? (
              <>
                <h4 className={styles.subHead}>Similar matches</h4>
                <AnalyzeTable rows={report.similarTableRows} mode="archive" compact />
              </>
            ) : null}
          </section>

          <section className={styles.card}>
            <h3>Similar matches (advanced, multi-market)</h3>
            <p className={styles.cardLead}>
              Weighted similarity across every market this bookmaker quotes for this match (1X2,
              O/U, AH, BTTS, HT/FT, DC) instead of just 1X2. Can take a few minutes to compute the
              first time — cached afterwards.
            </p>

            {simState.status === "idle" ? (
              <button type="button" className={styles.primaryButton} onClick={() => void runSimilarity(false)}>
                Compute similar matches
              </button>
            ) : null}

            {simState.status === "loading" ? (
              <p className={styles.loading}>Computing… this can take a few minutes, please wait.</p>
            ) : null}

            {simState.status === "error" ? (
              <>
                <p className={styles.error}>{simState.error}</p>
                <button type="button" className={styles.primaryButton} onClick={() => void runSimilarity(false)}>
                  Retry
                </button>
              </>
            ) : null}

            {simState.status === "done" ? (
              <>
                <p className={styles.cardLead}>
                  <strong>{simState.matchedCount}</strong> matched ·{" "}
                  {simState.usedCodes?.length ?? 0} active codes
                  {simState.durationMs != null ? ` · ${(simState.durationMs / 1000).toFixed(1)}s` : ""}
                  {simState.cached ? " · cached" : ""}
                  {simState.computedAt ? (
                    <span className={styles.muted}> · computed {new Date(simState.computedAt).toLocaleString()}</span>
                  ) : null}
                </p>
                {simState.tableRows?.length ? (
                  <AnalyzeTable rows={simState.tableRows} mode="archive" compact />
                ) : (
                  <p className={styles.empty}>No matches under the similarity threshold.</p>
                )}
                <button type="button" className={styles.secondaryButton} onClick={() => void runSimilarity(true)}>
                  Recompute
                </button>
              </>
            ) : null}
          </section>

          <section className={styles.card}>
            <h3>20 bookmakers · 1X2 comparison</h3>
            <p className={styles.cardLead}>
              {report.consensus.aligned ? (
                <>
                  <strong>{report.consensus.alignedPct.toFixed(0)}%</strong> of bookmakers show the
                  same favorite ({sideTr(report.consensus.favorite)}).
                </>
              ) : (
                <>Bookmakers are scattered — one-way consensus is weak.</>
              )}
            </p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>BM</th>
                    <th>1</th>
                    <th>X</th>
                    <th>2</th>
                    <th>Favorite</th>
                    <th>Movement</th>
                  </tr>
                </thead>
                <tbody>
                  {report.bookmakerGrid.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.name} <span className={styles.muted}>#{r.id}</span>
                      </td>
                      <td>{r.H != null ? formatOdds(r.H) : "—"}</td>
                      <td>{r.D != null ? formatOdds(r.D) : "—"}</td>
                      <td>{r.A != null ? formatOdds(r.A) : "—"}</td>
                      <td>{sideTr(r.favorite)}</td>
                      <td className={styles.muted}>
                        {[r.moveH, r.moveD, r.moveA]
                          .filter((m) => m && m !== "stable")
                          .map((m) => (m === "shortened" ? "▼" : "▲"))
                          .join(" ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.consensus.historical ? (
              <p className={styles.hint}>
                Historically, when all BMs aligned in the same direction (similar profile): 1X2{" "}
                {sideTr(report.consensus.historical.top)} {report.consensus.historical.topPct.toFixed(0)}%
                {" "}
                (n={report.consensus.historical.n})
              </p>
            ) : null}
          </section>

          <section className={styles.card}>
            <h3>Odds movement → historical outcome</h3>
            <p className={styles.cardLead}>
              Opening → closing movement (≥2%). Steam (▼) = odds shortened; drift (▲) = odds
              drifted. What happened in the archive under the same movement + similar odds band?
            </p>
            {!report.movements.length ? (
              <p className={styles.empty}>No notable movement in this match (reference BM).</p>
            ) : (
              <ul className={styles.moveList}>
                {report.movements.map((m, i) => (
                  <li key={i} className={styles.moveItem}>
                    <span className={m.move === "shortened" ? styles.pos : styles.neg}>
                      {m.move === "shortened" ? "▼ Steam" : "▲ Drift"} {Math.abs(m.changePct)}%
                    </span>{" "}
                    {m.marketLabel} {m.sideLabel}: {formatOdds(m.opening)} → {formatOdds(m.closing)}
                    {m.historical ? (
                      <span className={styles.hint}> · {m.historical.note} (n={m.historical.n})</span>
                    ) : (
                      <span className={styles.muted}> · not enough archive samples</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
