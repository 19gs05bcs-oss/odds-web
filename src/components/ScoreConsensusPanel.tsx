import {
  LOW_CONFIDENCE_BM_COUNT,
  type ScoreConsensus,
  type ScoreConsensusPick,
  type ScoreConsensusPickRole,
} from "@/lib/analysis/scoreConsensusEngine";
import styles from "./SmartAnalysisClient.module.css";

const ROLE_LABELS: Record<ScoreConsensusPickRole, string> = {
  favorite: "Consensus / Favorite",
  tempo: "Market Tempo (BTTS synthesis)",
  hedge: "Derivative Break / Hedge Anomaly",
};

export function ScoreConsensusPanel({ consensus }: { consensus: ScoreConsensus | null }) {
  if (!consensus) {
    return (
      <section className={styles.card}>
        <h3>Score Consensus</h3>
        <p className={styles.empty}>
          Not enough Correct Score data for this match — at least 4 bookmakers need to agree on a
          score, each quoting 8+ Correct Score lines.
        </p>
      </section>
    );
  }

  const {
    picks,
    bookmakerCount,
    confidence,
    home1x2Prob,
    draw1x2Prob,
    away1x2Prob,
    over25Prob,
    under25Prob,
    bttsYesOdds,
    bttsNoOdds,
    isBttsHeavy,
    actualScore,
  } = consensus;

  return (
    <section className={styles.card}>
      <h3>
        Score Consensus{" "}
        <span className={styles.muted}>
          · {bookmakerCount} bookmakers{confidence === "low" ? " · low confidence" : ""}
        </span>
      </h3>
      <p className={styles.cardLead}>
        A 3-slot Correct Score portfolio (favorite / tempo / hedge), built from this
        match&rsquo;s own 1X2, Over/Under 2.5, BTTS and Correct Score odds. Consensus/volume
        snapshot, not a prediction.
      </p>

      {confidence === "low" ? (
        <p className={styles.hint}>
          Only {bookmakerCount} bookmakers quote enough Correct Score lines for this match
          (threshold: {LOW_CONFIDENCE_BM_COUNT}). The picks below may be driven by thin data.
        </p>
      ) : null}

      <p className={styles.subHead}>
        1X2: Home <strong>{home1x2Prob}%</strong> · Draw <strong>{draw1x2Prob}%</strong> · Away{" "}
        <strong>{away1x2Prob}%</strong>
        <br />
        Over 2.5 <strong>{over25Prob}%</strong> · Under 2.5 <strong>{under25Prob}%</strong>
        <br />
        BTTS Yes <strong>{bttsYesOdds}</strong> · BTTS No <strong>{bttsNoOdds}</strong>
        {isBttsHeavy ? <span className={styles.muted}> · BTTS-heavy market</span> : null}
      </p>

      {picks.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Slot</th>
                <th>Score</th>
                <th>Median odds</th>
                <th>Drop %</th>
                <th>Prob %</th>
                <th>Power</th>
                <th>Bookmakers</th>
              </tr>
            </thead>
            <tbody>
              {picks.map((p: ScoreConsensusPick) => (
                <tr key={p.role}>
                  <td>{ROLE_LABELS[p.role]}</td>
                  <td>
                    {p.score}
                    {actualScore === p.score ? (
                      <span className={styles.pos}> ← actual</span>
                    ) : null}
                  </td>
                  <td>{p.medianOdds}</td>
                  <td>{p.dropPct}%</td>
                  <td>{p.probPct}%</td>
                  <td>{p.powerScore}</td>
                  <td>{p.bookmakerCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className={styles.empty}>No score cleared the minimum bookmaker-coverage threshold.</p>
      )}

      {actualScore ? (
        <p className={styles.cardLead}>
          Final score: <strong>{actualScore}</strong>
        </p>
      ) : null}
    </section>
  );
}
