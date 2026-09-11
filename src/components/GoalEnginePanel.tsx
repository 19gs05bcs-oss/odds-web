import type { GoalEngineMetrics } from "@/lib/analysis/goalEngine";
import styles from "./SmartAnalysisClient.module.css";

const SCORE_PROFILE_LABEL: Record<GoalEngineMetrics["scoreProfile"], string> = {
  EXTREME_BLOWOUT: "Extreme blowout",
  DOMINANT_WIN: "Dominant win",
  CONTESTED_FAVORITE: "Contested favourite",
  OPEN_EXCHANGE: "Open exchange",
  BALANCED: "Balanced",
  HARD_UNDER: "Hard under",
  LOCKED_CORRIDOR: "Locked corridor (false open)",
};

// getScoreMultiplier tüm (h,a) çiftleri için tanımlı — burada sadece küçük bir
// aday havuzu üzerinden en yüksek ağırlıklı skorları sıralayıp gösteriyoruz.
// Bu, motorun kendi karar mantığına dokunmadan salt bir sunum katmanı.
const MAX_GOALS_PER_SIDE = 4;
const TOP_N = 6;

function rankScorelines(metrics: GoalEngineMetrics): { score: string; multiplier: number }[] {
  const rows: { score: string; multiplier: number }[] = [];
  for (let h = 0; h <= MAX_GOALS_PER_SIDE; h++) {
    for (let a = 0; a <= MAX_GOALS_PER_SIDE; a++) {
      rows.push({
        score: `${h}:${a}`,
        multiplier: Math.round(metrics.getScoreMultiplier(h, a) * 100) / 100,
      });
    }
  }
  rows.sort((x, y) => y.multiplier - x.multiplier);
  return rows.slice(0, TOP_N);
}

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
        <h3>Goal Engine</h3>
        <p className={styles.empty}>
          Not enough 1X2 / Over-Under odds for this match to build a goal-expectancy profile.
        </p>
      </section>
    );
  }

  const {
    dominanceSide,
    isHeavyFavorite,
    isExtremeDominance,
    favoriteOdds,
    htVelocityLabel,
    pOver15,
    pOver25,
    pOver35,
    pOver45,
    isUnderLeaking,
    isFalseOpen,
    fairGoalLine,
    bttsExpectancy,
    scoreProfile,
  } = metrics;

  const ranked = rankScorelines(metrics);

  const favoriteLabel =
    dominanceSide === "NONE"
      ? "None"
      : `${dominanceSide === "HOME" ? "Home" : "Away"}${
          isExtremeDominance ? " (extreme)" : isHeavyFavorite ? " (heavy)" : ""
        }`;

  return (
    <section className={styles.card}>
      <h3>
        Goal Engine <span className={styles.muted}>· {SCORE_PROFILE_LABEL[scoreProfile]}</span>
      </h3>
      <p className={styles.cardLead}>
        Rule-based goal-expectancy profile from the 1X2, Draw-No-Bet, HT Correct Score and
        Over/Under markets — used to weight likely final scorelines. Not a prediction.
      </p>

      {isFalseOpen ? (
        <p className={styles.hint}>
          Over/Under 1.5 and 2.5 lines have barely moved since opening — this looks like a static,
          low-liquidity price rather than a real goal-expectancy signal. Classified as a locked
          corridor instead of Open Exchange; 0:0 and 1:1 are weighted up.
        </p>
      ) : null}

      {isUnderLeaking ? (
        <p className={styles.hint}>
          Under 2.5 price has drifted up since opening — possible late money moving away from a
          low-scoring outcome.
        </p>
      ) : null}

      <p className={styles.subHead}>
        Favourite: <strong>{favoriteLabel}</strong>
        {favoriteOdds != null ? <> · odds @{favoriteOdds}</> : null} · {htVelocityLabel}
      </p>

      <p className={styles.subHead}>
        Fair goal line <strong>{fairGoalLine}</strong> · BTTS expectancy{" "}
        <strong>{bttsExpectancy ? "Yes" : "No"}</strong>
      </p>

      <p className={styles.subHead}>
        Over 1.5 <strong>{pOver15 != null ? `${pOver15}%` : "—"}</strong> · Over 2.5{" "}
        <strong>{pOver25}%</strong> · Over 3.5{" "}
        <strong>{pOver35 != null ? `${pOver35}%` : "—"}</strong> · Over 4.5{" "}
        <strong>{pOver45 != null ? `${pOver45}%` : "—"}</strong>
      </p>

      <div
        className={styles.simGrid}
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(4.5rem, 5.5rem))", gap: "0.5rem" }}
      >
        {ranked.map((row) => (
          <div key={row.score} className={styles.simCard} style={{ padding: "0.55rem 0.65rem" }}>
            <div className={styles.simVal} style={{ fontSize: "1.05rem", margin: 0 }}>
              {row.score}
              {actualScore === row.score ? <span className={styles.pos}> ←</span> : null}
            </div>
          </div>
        ))}
      </div>
      <p className={styles.hint}>
        *Note: these are the scorelines favoured by the Goal Engine&rsquo;s goal-expectancy
        multipliers, not a prediction.
      </p>

      {actualScore ? (
        <p className={styles.cardLead}>
          Final score: <strong>{actualScore}</strong>
        </p>
      ) : null}
    </section>
  );
}
