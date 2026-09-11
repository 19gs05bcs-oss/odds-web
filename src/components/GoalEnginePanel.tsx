import type { GoalEngineMetrics } from "@/lib/analysis/goalEngine";
import styles from "./SmartAnalysisClient.module.css";

const SCORE_PROFILE_LABEL: Record<GoalEngineMetrics["scoreProfile"], string> = {
  EXTREME_BLOWOUT: "Extreme Blowout",
  DOMINANT_WIN: "Dominant Win",
  CONTESTED_FAVORITE: "Contested Favourite",
  OPEN_EXCHANGE: "Open Exchange",
  BALANCED: "Balanced",
  HARD_UNDER: "Hard Under",
  LOCKED_CORRIDOR: "Locked Corridor (False Open)",
};

export function GoalEnginePanel({
  metrics,
  actualScore,
}: {
  metrics: GoalEngineMetrics | null;
  actualScore?: string | null;
}) {
    if (!metrics) {
    return (
      <section className={styles.card}>
        <h3>🎯 Goal & Market Anomaly Engine</h3>
        <p className={styles.empty}>
          Not enough 1X2 / Over-Under / HT odds data was found for this match.
        </p>
      </section>
    );
  }

  const {
    dominanceSide,
    isHeavyFavorite,
    isExtremeDominance,
    favoriteOdds,
    htZeroZeroOdd,
    pOver25,
    pOver35,
    fairGoalLine,
    bttsExpectancy,
    scoreProfile,
    anomalies = [],
    htVerdict,
    ftVerdict,
  } = metrics;

    const favoriteLabel =
    dominanceSide === "NONE"
      ? "Balanced (No clear favourite)"
      : `${dominanceSide === "HOME" ? "Home" : "Away"}${
          isExtremeDominance ? " (Extreme Dominance)" : isHeavyFavorite ? " (Heavy Favourite)" : ""
        }`;

    return (
    <section className={styles.card}>
      <h3>
        🎯 Goal & Market Anomaly Engine{" "}
        <span className={styles.muted}>· {SCORE_PROFILE_LABEL[scoreProfile]}</span>
      </h3>
      <p className={styles.cardLead}>
        The score profile, HT-FT verdicts, and market anomalies derived from this match's own
        1X2 / Over-Under / First Half odds. Not a standalone guaranteed prediction.
      </p>

      {actualScore ? (
        <p className={styles.subHead}>
          Final score: <span className={styles.geScoreTag}>{actualScore}</span>
        </p>
      ) : null}

      <div className={styles.geVerdictGrid}>
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>First Half Verdict</span>
          <span className={styles.geVerdictText}>{htVerdict || "Balanced First Half"}</span>
        </div>
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>Full Time Verdict</span>
          <span className={styles.geVerdictText}>{ftVerdict || "Normal Tempo"}</span>
        </div>
      </div>

      <p className={styles.subHead}>
        <strong>Detected Market Anomalies</strong>
      </p>
      {anomalies.length > 0 ? (
        <div className={styles.steamAlerts} role="status">
          {anomalies.map((item, idx) => (
            <p key={idx} className={styles.steamAlertItem}>
              <span className={styles.steamAlertIcon} aria-hidden="true">
                🚨
              </span>
              {item}
            </p>
          ))}
        </div>
      ) : (
        <p className={styles.muted}>
          No significant odds anomaly or sharp liquidity shift detected.
        </p>
      )}

            <p className={styles.subHead}>
        <strong>Market Indicators</strong>
      </p>
      <div className={styles.geStatsGrid}>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>Side Pressure</span>
          <span className={styles.geStatValue}>{favoriteLabel}</span>
          {favoriteOdds != null ? (
            <span className={styles.geStatSub}>@{favoriteOdds.toFixed(2)}</span>
          ) : null}
        </div>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>HT 0:0 Odds</span>
          <span className={styles.geStatValue}>
            {htZeroZeroOdd != null ? `@${htZeroZeroOdd.toFixed(2)}` : "—"}
          </span>
        </div>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>BTTS Expectancy</span>
          <span className={bttsExpectancy ? styles.pos : styles.neg}>
            {bttsExpectancy ? "Yes (High)" : "No (Low)"}
          </span>
        </div>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>Fair Goal Line</span>
          <span className={styles.geStatValue}>{fairGoalLine}</span>
        </div>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>Over 2.5 Probability</span>
          <span className={styles.geStatValue}>{pOver25}%</span>
        </div>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>Over 3.5 Probability</span>
          <span className={styles.geStatValue}>{pOver35 != null ? `${pOver35}%` : "—"}</span>
        </div>
      </div>
    </section>
  );
}
