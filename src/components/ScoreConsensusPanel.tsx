import type { ScoreConsensus } from "@/lib/analysis/scoreConsensusEngine";
import styles from "./SmartAnalysisClient.module.css";

export function ScoreConsensusPanel({ consensus }: { consensus: ScoreConsensus | null }) {
  if (!consensus) {
    return (
      <section className={styles.card}>
        <h3>Score Consensus</h3>
        <p className={styles.empty}>
          Not enough 1X2 / Over-Under 2.5 quotes for this match to classify a regime.
        </p>
      </section>
    );
  }

  const {
    regimeLabel,
    confidenceLabel,
    homeProb,
    drawProb,
    awayProb,
    over25Prob,
    under25Prob,
    portfolio,
    actualScore,
    hit3,
    hit4,
  } = consensus;

  return (
    <section className={styles.card}>
      <h3>
        Score Consensus <span className={styles.muted}>· V54 regime engine</span>
      </h3>
      <p className={styles.cardLead}>
        Rule-based Correct Score portfolio derived from this match&rsquo;s own 1X2 and Over/Under
        2.5 markets. This is a regime classification, not a prediction.
      </p>

      <p className={styles.subHead}>
        Regime: <strong>{regimeLabel}</strong> · Confidence: <strong>{confidenceLabel}</strong>
      </p>

      <p className={styles.subHead}>
        1X2: Home <strong>{homeProb}%</strong> · Draw <strong>{drawProb}%</strong> · Away{" "}
        <strong>{awayProb}%</strong>
      </p>
      <p className={styles.subHead}>
        Goal expectancy: Over 2.5 <strong>{over25Prob}%</strong> · Under 2.5{" "}
        <strong>{under25Prob}%</strong>
      </p>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th>
              <th>Score</th>
              <th>Tier</th>
              <th>Market odds</th>
            </tr>
          </thead>
          <tbody>
            {portfolio.map((slot, i) => (
              <tr key={slot.score}>
                <td>{i + 1}</td>
                <td>
                  {slot.score}
                  {slot.isActual ? <span className={styles.pos}> ← actual</span> : null}
                </td>
                <td>{slot.tier === "core" ? "Core (Hit@3)" : "Insurance (Hit@4)"}</td>
                <td>{slot.marketOdds ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {actualScore ? (
        <p className={styles.cardLead}>
          Final score: <strong>{actualScore}</strong> · Hit@3:{" "}
          <strong>{hit3 ? "✅" : "❌"}</strong> · Hit@4: <strong>{hit4 ? "✅" : "❌"}</strong>
        </p>
      ) : null}
    </section>
  );
}
