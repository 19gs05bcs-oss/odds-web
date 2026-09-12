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
  LOW_BASELINE_TRAP: "Low Baseline Trap",
  BASELINE_FAV_BREAK: "Baseline Fav Break",
  PHANTOM_BLOWOUT: "Phantom Blowout Trap",
  SOLO_HOME_BLOWOUT: "Solo Home Blowout",
  REVERSE_TAKEOVER: "Reverse Market Takeover",
  SUPER_FAV_TRAP: "Super Favourite Resistance",
  AWAY_CONTROL_LOCK: "Away Control Lock",
  AWAY_SURGE_TRAP: "Away Surge Trap",
  COLLECTIVE_SURGE: "Collective Surge",
  // Case-memory library
  POLONIA_FAKE_DOG_TAKEOVER: "Polonia (Fake Under-Dog Takeover)",
  DROGHEDA_FAKEOUT_SURGE: "Drogheda (Fakeout Dog Surge)",
  SHELBOURNE_HOLLOW_SURGE_TRAP: "Shelbourne (Hollow Surge Trap)",
  PISA_SYSTEMIC_FLIP: "Pisa (Systemic Market Flip)",
  BENEVENTO_HOME_DOG_REVERSE: "Benevento (Home Dog Reverse Takeover)",
  GALWAY_SOLO_AWAY_BLOWOUT: "Galway (Solo Away Blowout)",
  CORK_CITY_UNDERDOG_TAKEOVER: "Cork City (Heavy Fav Underdog Takeover)",
  WEXFORD_SUPER_FAV_BLINDSPOT: "Wexford (Super Fav Blindspot)",
  QADSIAH_FIRE_CLASH: "Qadsiah (Super Fav Fire Clash)",
  AL_AHLI_SOLO_HOME_BLOWOUT: "Al-Ahli (Solo Home Blowout)",
  RAKOW_HIGH_CEILING_TAKEOVER: "Rakow (High Ceiling Fakeout Takeover)",
  WISLA_FAKE_COLLECTIVE_SURGE: "Wisla (Fake Collective Surge)",
  JAZZ_PORI_SUPER_FAKEOUT_BLOWOUT: "Jazz Pori (Super Fakeout Blowout)",
  NEPTUNAS_CLEAN_SHEET_SUFFOCATION: "Neptunas (Clean Sheet Home Suffocation)",
  PUSZCZA_LOW_BASELINE_ANCHOR: "Puszcza (Low Baseline Anchor Progression)",
  KERRY_AWAY_LOW_TEMPO_LOCK: "Kerry (Away Low-Tempo Lock)",
  CIENCIANO_HANDICAP_STEAMROLLER: "Cienciano (Heavy Fav Handicap Steamroller)",
  JAGUARES_LOW_BASELINE_DUEL: "Jaguares (Low Baseline Duel)",
  ATHLETICO_FAKE_UNDER_STORM: "Athletico (Fake Under Goal Storm)",
  HIDDEN_FIRE_LEAK: "Farul (Hidden Fire Infiltration)",
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
    teamGoalVerdict,
    moneyFlow1X2,
    ouFlow,
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
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>Team Goal Safety</span>
          <span className={styles.geVerdictText}>{teamGoalVerdict}</span>
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
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>1X2 Money Flow</span>
          <span className={styles.geStatValue}>{moneyFlow1X2}</span>
        </div>
        <div className={styles.geStat}>
          <span className={styles.geStatLabel}>2.5 Line Liquidity</span>
          <span className={styles.geStatValue}>{ouFlow}</span>
        </div>
      </div>
    </section>
  );
}
