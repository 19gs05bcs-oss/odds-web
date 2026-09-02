"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnalyzeTable } from "@/components/AnalyzeTable";
import { FixtureMatchStrip } from "@/components/FixtureMatchStrip";
import { PREFERRED_BM, fixtureToTableRow } from "@/lib/analysis/tableRows";
import type { TableRow } from "@/lib/analysis/tableRows";
type SimilarityCardState = {
  status: "idle" | "loading" | "done" | "error";
  matchedCount?: number;
  usedCodes?: string[];
  tableRows?: (TableRow & { similarityScore?: number })[];
  cached?: boolean;
  computedAt?: string;
  durationMs?: number;
  family?: string;
  familyTitle?: string;
  familyNote?: string;
  prediction?: { primary: string; backup: string; reason: string } | null;
  error?: string;
};
import type { BookmakerOption } from "@/lib/types";
import type { FixtureRow } from "@/lib/fixtures";
import filterStyles from "./AnalyzeFilters.module.css";
import styles from "./SmartAnalysisClient.module.css";

type Props = {
  bookmakers: BookmakerOption[];
  fixtureDates: string[];
  initialBulletinDate: string;
};

function LoadingBanner({
  title,
  subtitle,
  long,
}: {
  title: string;
  subtitle?: string;
  long?: boolean;
}) {
  return (
    <div
      className={long ? `${styles.loadingBanner} ${styles.loadingBannerLong}` : styles.loadingBanner}
      role="status"
      aria-live="polite"
    >
      <span className={styles.spinner} aria-hidden="true" />
      <div className={styles.loadingText}>
        <p className={styles.loadingTitle}>
          {title}
          <span className={styles.loadingDots} aria-hidden="true">
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        </p>
        {subtitle ? <p className={styles.loadingSub}>{subtitle}</p> : null}
        {long ? (
          <div className={styles.progressTrack}>
            <div className={styles.progressBar} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** meta.yil/ay/gun/saat zaten sıfır-dolgulu (kickoffParts) — string birleştirip
 *  karşılaştırmak doğru kronolojik sırayı verir. meta.tarih (gg.ay.yy) sadece
 *  görüntü içindir, gün başta olduğu için string-sort ile kronolojik olmaz. */
function dateKey(r: TableRow): string {
  return `${r.meta.yil}${r.meta.ay}${r.meta.gun}${r.meta.saat}`;
}

type ArchiveSortMode = "date" | "similarity";

export function SmartAnalysisClient({
  bookmakers,
  fixtureDates,
  initialBulletinDate,
}: Props) {
  const [archiveSort, setArchiveSort] = useState<ArchiveSortMode>("date");
  const [bulletinDate, setBulletinDate] = useState(initialBulletinDate);
  const [fixtures, setFixtures] = useState<FixtureRow[]>([]);
  const [fixturesLoading, setFixturesLoading] = useState(!!initialBulletinDate);
  const [oddsLoading, setOddsLoading] = useState(false);
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(null);
  const [referenceBm, setReferenceBm] = useState(String(PREFERRED_BM));
  const [error, setError] = useState<string | undefined>();
  const [simState, setSimState] = useState<SimilarityCardState>({ status: "idle" });

  const bmNum = Number(referenceBm) || PREFERRED_BM;
  const bmName = bookmakers.find((b) => b.id === referenceBm)?.name || "";
  const selectedFixture = useMemo(
    () => fixtures.find((f) => f.match_id === selectedFixtureId) ?? null,
    [fixtures, selectedFixtureId],
  );
  const selectedRow = useMemo(
    () => (selectedFixture?.odds?.length ? fixtureToTableRow(selectedFixture, bmNum) : null),
    [selectedFixture, bmNum],
  );

  // Sunucudan gelen sıra = benzerlik skoruna göre artan (en benzer önce; bkz.
  // similarityEngine.ts ranked.sort). "date" seçilince tarihe göre (eski→yeni)
  // yeniden sıralıyoruz; "similarity" seçilince sunucudan geldiği sırayı koruyoruz.
  const sortedArchiveRows = useMemo(() => {
    const rows = simState.tableRows;
    if (!rows?.length) return rows;
    if (archiveSort === "similarity") return rows;
    return [...rows].sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
  }, [simState.tableRows, archiveSort]);

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

  useEffect(() => {
    if (!bulletinDate) return;
    void loadFixturesForDate(bulletinDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulletinDate]);

  const runSimilarity = useCallback(
    async (force = false) => {
      if (!selectedFixture?.match_id || !selectedFixture.odds?.length || !bmName) return;
      setSimState({ status: "loading" });
      try {
        const res = await fetch("/api/smart-analysis/similarity", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            eventId: selectedFixture.match_id,
            bookmaker: bmName,
            bookmakerId: bmNum,
            odds: selectedFixture.odds,
            force,
          }),
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
          family?: string;
          familyTitle?: string;
          familyNote?: string;
          prediction?: { primary: string; backup: string; reason: string } | null;
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
          family: j.family,
          familyTitle: j.familyTitle,
          familyNote: j.familyNote,
          prediction: j.prediction ?? null,
        });
      } catch (e) {
        setSimState({ status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    },
    [selectedFixture?.match_id, bmName],
  );

  // Maç veya referans bookmaker değişince otomatik hesapla — engine.ts artık
  // hızlı (~10sn), bu yüzden manuel butona gerek yok; sadece force/recompute
  // için buton kalıyor.
  useEffect(() => {
    if (!selectedFixture?.odds?.length || !bmName) {
      setSimState({ status: "idle" });
      return;
    }
    void runSimilarity(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFixtureId, referenceBm, selectedFixture?.odds?.length, bmName]);

  return (
    <div className={styles.wrap}>
      <header className={styles.hero}>
        <p className={styles.kicker}>Smart Analysis · Pro</p>
        <h1 className={styles.title}>Select match → similar matches</h1>
        <p className={styles.lead}>
          Select a match from the bulletin to compute weighted multi-market similarity against
          the historical archive.
        </p>
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

      {!selectedFixture && !fixturesLoading ? (
        <p className={styles.empty}>Select a match from the bulletin.</p>
      ) : null}

      {selectedFixture ? (
        <>
          {selectedRow ? (
            <section className={styles.card}>
              <h3>Selected match odds</h3>
              <AnalyzeTable rows={[selectedRow]} mode="bulletin" compact />
            </section>
          ) : null}

          <section className={styles.card}>
            <h3>Similar matches (multi-market)</h3>
            <p className={styles.cardLead}>
              Weighted similarity across every market this bookmaker quotes for this match (1X2,
              O/U, AH, BTTS, HT/FT, DC).
            </p>

            {simState.status === "idle" ? (
              <p className={styles.empty}>Waiting for this match's odds to load…</p>
            ) : null}

            {simState.status === "loading" ? (
              <LoadingBanner title="Loading match" subtitle="Please wait — computing similarity across all markets." long />
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
                {simState.familyTitle ? (
                  <div
                    className={
                      simState.family === "BASE"
                        ? `${styles.familyNote} ${styles.familyNoteBase}`
                        : styles.familyNote
                    }
                    role="status"
                  >
                    <p className={styles.familyTitle}>{simState.familyTitle}</p>
                    <p className={styles.familyBody}>{simState.familyNote}</p>
                    {simState.prediction?.primary ? (
                      <p className={styles.familyCall}>
                        Distance call <strong>{simState.prediction.primary}</strong>
                        {simState.prediction.backup ? (
                          <>
                            {" "}
                            · alt <strong>{simState.prediction.backup}</strong>
                          </>
                        ) : null}
                        {simState.prediction.reason ? (
                          <span className={styles.muted}> — {simState.prediction.reason}</span>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {simState.tableRows?.length ? (
                  <>
                    <div className={filterStyles.field} role="group" aria-label="Archive sort">
                      <span>Sort</span>
                      <select
                        value={archiveSort}
                        onChange={(e) => setArchiveSort(e.target.value as ArchiveSortMode)}
                      >
                        <option value="date">Date (oldest → newest)</option>
                        <option value="similarity">Similarity (best match first)</option>
                      </select>
                    </div>
                    <AnalyzeTable rows={sortedArchiveRows ?? []} mode="archive" compact />
                  </>
                ) : (
                  <p className={styles.empty}>No matches under the similarity threshold.</p>
                )}
                <button type="button" className={styles.secondaryButton} onClick={() => void runSimilarity(true)}>
                  Recompute
                </button>
              </>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
