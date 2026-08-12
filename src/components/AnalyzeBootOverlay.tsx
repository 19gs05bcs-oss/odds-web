"use client";

import styles from "@/components/AnalyzeBootOverlay.module.css";

export type ArchiveWarmState = {
  status: "idle" | "loading" | "ready" | "error";
  seasonsDone: number;
  seasonsTotal: number;
  quotes: number;
  error?: string;
};

type Props = {
  visible: boolean;
  phase: "meta" | "odds" | "archive";
  bulletinDate: string;
  fixturesTotal: number;
  fixturesWithOdds: number;
  oddsChunksDone: number;
  oddsChunksTotal: number;
  archive: ArchiveWarmState;
};

function phaseTitle(phase: Props["phase"], archive: ArchiveWarmState): string {
  if (phase === "meta") return "Loading bulletin";
  if (phase === "odds") return "Uploading fixture odds";
  if (archive.status === "loading") return "Preparing archive index";
  if (archive.status === "ready") return "Almost ready";
  return "Starting up";
}

function phaseDetail(phase: Props["phase"], archive: ArchiveWarmState): string {
  if (phase === "meta") return "Fetching matches for the selected day…";
  if (phase === "odds") return "Pulling bookmaker prices into the match table…";
  if (archive.status === "loading") {
    return `Indexing historical seasons (${archive.seasonsDone}/${archive.seasonsTotal || "?"})…`;
  }
  if (archive.status === "ready") {
    return `${archive.quotes.toLocaleString()} archive quotes ready for search.`;
  }
  if (archive.status === "error") {
    return archive.error || "Archive warm failed — search may be slower.";
  }
  return "Warming archive cache in the background…";
}

export function AnalyzeBootOverlay({
  visible,
  phase,
  bulletinDate,
  fixturesTotal,
  fixturesWithOdds,
  oddsChunksDone,
  oddsChunksTotal,
  archive,
}: Props) {
  if (!visible) return null;

  const oddsPct =
    oddsChunksTotal > 0
      ? Math.min(100, Math.round((oddsChunksDone / oddsChunksTotal) * 100))
      : fixturesTotal > 0
        ? Math.min(100, Math.round((fixturesWithOdds / fixturesTotal) * 100))
        : 0;

  const archivePct =
    archive.seasonsTotal > 0
      ? Math.min(100, Math.round((archive.seasonsDone / archive.seasonsTotal) * 100))
      : archive.status === "ready"
        ? 100
        : 8;

  return (
    <div className={styles.backdrop} role="status" aria-live="polite" aria-busy="true">
      <div className={styles.card}>
        <div className={styles.brandRow}>
          <span className={styles.brandMark} aria-hidden />
          <div>
            <p className={styles.brandKicker}>OddsVig</p>
            <h3 className={styles.title}>{phaseTitle(phase, archive)}</h3>
          </div>
        </div>

        <p className={styles.detail}>{phaseDetail(phase, archive)}</p>

        <div className={styles.block}>
          <div className={styles.blockHead}>
            <span>Fixture odds</span>
            <span className={styles.mono}>
              {fixturesWithOdds}/{fixturesTotal || "—"} have odds
            </span>
          </div>
          <div className={styles.track}>
            <div className={styles.fillFixture} style={{ width: `${oddsPct}%` }} />
          </div>
          <p className={styles.sub}>
            {bulletinDate ? `Day ${bulletinDate}` : "Today"} · chunk{" "}
            {oddsChunksTotal ? `${oddsChunksDone}/${oddsChunksTotal}` : "—"}
          </p>
        </div>

        <div className={styles.block}>
          <div className={styles.blockHead}>
            <span>Archive index</span>
            <span className={styles.mono}>
              {archive.status === "ready"
                ? "ready"
                : archive.status === "error"
                  ? "error"
                  : `${archive.seasonsDone}/${archive.seasonsTotal || "?"}`}
            </span>
          </div>
          <div className={styles.track}>
            <div className={styles.fillArchive} style={{ width: `${archivePct}%` }} />
          </div>
          <p className={styles.sub}>
            {archive.status === "ready"
              ? `${archive.quotes.toLocaleString()} quotes indexed`
              : "Background load — filters work once ready"}
          </p>
        </div>

        <div className={styles.spinnerRow}>
          <span className={styles.spinner} aria-hidden />
          <span className={styles.spinnerText}>Please wait — table unlocks when odds finish loading</span>
        </div>
      </div>
    </div>
  );
}
