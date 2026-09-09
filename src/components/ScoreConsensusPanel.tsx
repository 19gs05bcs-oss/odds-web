import { LOW_CONFIDENCE_BM_COUNT, type ScoreConsensus } from "@/lib/analysis/scoreConsensusEngine";
import styles from "./SmartAnalysisClient.module.css";

export function ScoreConsensusPanel({ consensus }: { consensus: ScoreConsensus | null }) {
  if (!consensus) {
    return (
      <section className={styles.card}>
        <h3>Score Consensus</h3>
        <p className={styles.empty}>
          Not enough Correct Score data for this match — at least 3 bookmakers with 8+ quoted
          scores each are needed.
        </p>
      </section>
    );
  }

  const { rankings, bookmakerCount, confidence, over25Prob, under25Prob, actualScore } = consensus;

  return (
    <section className={styles.card}>
      <h3>
        Score Consensus{" "}
        <span className={styles.muted}>
          · {bookmakerCount} bookmakers{confidence === "low" ? " · low confidence" : ""}
        </span>
      </h3>
      <p className={styles.cardLead}>
        Volume-weighted Correct Score ranking, cross-checked against the Over/Under 2.5 market —
        computed from this match&rsquo;s own odds. This is a consensus/volume snapshot, not a
        prediction.
      </p>

      {confidence === "low" ? (
        <p className={styles.hint}>
          Only {bookmakerCount} bookmakers quote enough Correct Score lines for this match
          (threshold: {LOW_CONFIDENCE_BM_COUNT}). A single outlier price can dominate the ranking
          below.
        </p>
      ) : null}

      <p className={styles.subHead}>
        Goal expectancy: Over 2.5 <strong>{over25Prob}%</strong> · Under 2.5{" "}
        <strong>{under25Prob}%</strong>
      </p>

      {rankings.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>#</th>
                <th>Score</th>
                <th>Value</th>
                <th>Median odds</th>
                <th>Min odds</th>
                <th>Drop %</th>
                <th>Bookmakers</th>
              </tr>
            </thead>
            <tbody>
              {rankings.map((r, i) => (
                <tr key={r.score}>
                  <td>{i + 1}</td>
                  <td>
                    {r.score}
                    {actualScore === r.score ? <span className={styles.pos}> ← actual</span> : null}
                  </td>
                  <td>{r.value}</td>
                  <td>{r.medianOdds}</td>
                  <td>{r.minOdds}</td>
                  <td>{r.dropPct}%</td>
                  <td>{r.bookmakerCount}</td>
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
