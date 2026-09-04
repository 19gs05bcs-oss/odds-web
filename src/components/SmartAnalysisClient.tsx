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
  // Çoklu referans BM: kullanıcının tıklama sırası korunur, sıralı (ardı ardına)
  // hesaplama ve gösterim bu sırayla yapılır.
  const [referenceBms, setReferenceBms] = useState<string[]>([String(PREFERRED_BM)]);
  const [error, setError] = useState<string | undefined>();
  // Her referans BM için ayrı sonuç kartı — bm id -> durum.
  const [simResults, setSimResults] = useState<Record<string, SimilarityCardState>>({});

  const toggleBm = useCallback((id: string) => {
    setReferenceBms((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const primaryBm = referenceBms[0] ?? String(PREFERRED_BM);
  const bmNum = Number(primaryBm) || PREFERRED_BM;
  const selectedFixture = useMemo(
    () => fixtures.find((f) => f.match_id === selectedFixtureId) ?? null,
    [fixtures, selectedFixtureId],
  );

  // Sunucudan gelen sıra = benzerlik skoruna göre artan (en benzer önce; bkz.
  // similarityEngine.ts ranked.sort). "date" seçilince tarihe göre (eski→yeni)
  // yeniden sıralıyoruz; "similarity" seçilince sunucudan geldiği sırayı koruyoruz.
  const sortRows = useCallback(
    (rows: (TableRow & { similarityScore?: number })[] | undefined) => {
      if (!rows?.length) return rows;
      if (archiveSort === "similarity") return rows;
      return [...rows].sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
    },
    [archiveSort],
  );

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

  const runSimilarityForBm = useCallback(
    async (bmId: string, force = false) => {
      const bmNameStr = bookmakers.find((b) => b.id === bmId)?.name;
      if (!selectedFixture?.match_id || !selectedFixture.odds?.length || !bmNameStr) return;
      setSimResults((prev) => ({ ...prev, [bmId]: { status: "loading" } }));
      try {
        const res = await fetch("/api/smart-analysis/similarity", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            eventId: selectedFixture.match_id,
            bookmaker: bmNameStr,
            bookmakerId: Number(bmId) || PREFERRED_BM,
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
        setSimResults((prev) => ({
          ...prev,
          [bmId]: {
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
          },
        }));
      } catch (e) {
        setSimResults((prev) => ({
          ...prev,
          [bmId]: { status: "error", error: e instanceof Error ? e.message : String(e) },
        }));
      }
    },
    [selectedFixture?.match_id, selectedFixture?.odds, bookmakers],
  );

  // Maç veya seçili referans BM listesi değişince, seçilen bookmaker'ları
  // TEK TEK, sırayla (ardı ardına) hesaplıyoruz: her biri kendi kartında
  // "loading" gösterip bitince sıradakine geçiyoruz — hepsi aynı anda
  // paralel patlamıyor, kullanıcı sonuçları bet365 → altına bir sonraki →
  // şeklinde akarken izleyebiliyor.
  const bmsKey = referenceBms.join(",");
  useEffect(() => {
    if (!selectedFixture?.odds?.length || !referenceBms.length) {
      setSimResults({});
      return;
    }
    let cancelled = false;
    (async () => {
      for (const bmId of referenceBms) {
        if (cancelled) return;
        const bmNameStr = bookmakers.find((b) => b.id === bmId)?.name;
        if (!bmNameStr) continue;
        setSimResults((prev) => ({ ...prev, [bmId]: { status: "loading" } }));
        try {
          const res = await fetch("/api/smart-analysis/similarity", {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              eventId: selectedFixture.match_id,
              bookmaker: bmNameStr,
              bookmakerId: Number(bmId) || PREFERRED_BM,
              odds: selectedFixture.odds,
              force: false,
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
          if (cancelled) return;
          if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
          setSimResults((prev) => ({
            ...prev,
            [bmId]: {
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
            },
          }));
        } catch (e) {
          if (cancelled) return;
          setSimResults((prev) => ({
            ...prev,
            [bmId]: { status: "error", error: e instanceof Error ? e.message : String(e) },
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFixtureId, bmsKey, selectedFixture?.odds?.length]);

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

        <div className={filterStyles.filterSection}>
          <p className={filterStyles.filterSectionTitle}>
            Reference BMs ({referenceBms.length} selected)
          </p>
          <p className={filterStyles.hint}>
            Select one or more bookmakers — each runs one after another and its result appears
            in its own section below, in the order you picked them.
          </p>
          <div className={styles.tabs}>
            {bookmakers.map((b) => (
              <button
                key={b.id}
                type="button"
                className={referenceBms.includes(b.id) ? styles.tabActive : styles.tab}
                onClick={() => toggleBm(b.id)}
              >
                {b.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}

      {!selectedFixture && !fixturesLoading ? (
        <p className={styles.empty}>Select a match from the bulletin.</p>
      ) : null}

      {selectedFixture ? (
        <>
          {referenceBms.length ? (
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
          ) : null}

          {referenceBms.length === 0 ? (
            <p className={styles.empty}>Pick at least one reference bookmaker above.</p>
          ) : null}

          {referenceBms.map((bmId) => {
            const bmNameStr = bookmakers.find((b) => b.id === bmId)?.name || bmId;
            const simState: SimilarityCardState = simResults[bmId] ?? { status: "idle" };
            const rows = sortRows(simState.tableRows);
            // Her BM kendi açtığı oranı gösterir — eskiden tek bir global
            // satır (hep ilk seçili BM'in oranı, pratikte hep bet365) tüm
            // kartların üstünde tekrarlanıyordu. Artık her kart kendi
            // bookmakerId'siyle hesaplanmış satırını gösteriyor.
            const bmRow = fixtureToTableRow(selectedFixture, Number(bmId) || PREFERRED_BM);
            return (
              <section key={bmId} className={styles.card}>
                <h3>{bmNameStr} — similar matches (multi-market)</h3>
                {bmRow ? (
                  <div className={styles.bmOpenedOdds}>
                    <p className={styles.cardLead}>{bmNameStr} — odds for this match</p>
                    <AnalyzeTable rows={[bmRow]} mode="bulletin" compact />
                  </div>
                ) : null}
                <p className={styles.cardLead}>
                  Weighted similarity across every market {bmNameStr} quotes for this match (1X2,
                  O/U, AH, BTTS, HT/FT, DC).
                </p>

                {simState.status === "idle" ? (
                  <p className={styles.empty}>Waiting for this match&rsquo;s odds to load…</p>
                ) : null}

                {simState.status === "loading" ? (
                  <LoadingBanner
                    title={`Loading ${bmNameStr}`}
                    subtitle="Please wait — computing similarity across all markets."
                    long
                  />
                ) : null}

                {simState.status === "error" ? (
                  <>
                    <p className={styles.error}>{simState.error}</p>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={() => void runSimilarityForBm(bmId, false)}
                    >
                      Retry
                    </button>
                  </>
                ) : null}

                {simState.status === "done" ? (
                  <>
                    <p className={styles.cardLead}>
                      <strong>{simState.matchedCount}</strong> matched ·{" "}
                      {simState.usedCodes?.length ?? 0} active codes
                      {simState.durationMs != null
                        ? ` · ${(simState.durationMs / 1000).toFixed(1)}s`
                        : ""}
                      {simState.cached ? " · cached" : ""}
                      {simState.computedAt ? (
                        <span className={styles.muted}>
                          {" "}
                          · computed {new Date(simState.computedAt).toLocaleString()}
                        </span>
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
                    {rows?.length ? (
                      <AnalyzeTable rows={rows} mode="archive" compact />
                    ) : (
                      <p className={styles.empty}>No matches under the similarity threshold.</p>
                    )}
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => void runSimilarityForBm(bmId, true)}
                    >
                      Recompute
                    </button>
                  </>
                ) : null}
              </section>
            );
          })}
        </>
      ) : null}
    </div>
  );
}
