import type { GoalEngineMetrics } from "@/lib/analysis/goalEngine";
import styles from "./EnginePanels.module.css";

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
  POLONIA_CLEAN_DOG_LOCK: "Polonia-Clean (Away Takeover & Clean-Sheet Lock)",
  BILBAO_HOME_BALLOON_TRAP: "Bilbao (Home Public Balloon Trap)",
  DINAMO_ZAGREB_AWAY_BALLOON_TRAP: "Dinamo Zagreb (Away Public Balloon Trap)",
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
  // CLI Modelleri
  UNDERDOG_MIRAGE: "Underdog Mirage (Pachuca / Vålerenga Model)",
  FAKE_HOME_PUSZCZA: "Zeledon Model (Barren False Home Trap)",
  REAL_POTOSI_TEMPO: "Real Potosi (Heavy Fav Natural Baseline)",
  STATIC_OVER_TRAP: "Tijuana Model (Static Retail Bait)",
  UNDER_INFLOW_TRAP: "Under Inflow Trap (Bochum / Necaxa Model)",
  HIGH_TOTAL_LADDER: "High Total Ladder (6+ / HT Over 2.5 family)",
  SOLO_HOLLOW_TRAP: "Heerenveen (Asymmetric Hollow Solo Surge Trap)",
  ASYMMETRIC_CHOKE: "Asymmetric Choke Trap",
  STATIC_RETAIL_BAIT: "Static Retail Bait",
  ELITE_BLOWOUT: "Elite Blowout",
  ASYMMETRIC_BARREN_TRAP: "Asymmetric Barren Trap",
};

const INFO =
  "Score profile, HT-FT verdicts and market anomalies derived from this match's own 1X2 / Over-Under / First Half odds. Not a standalone guaranteed prediction.";

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
        <div className={styles.head}>
          <h3 className={styles.title}>🎯 Goal &amp; Market Anomaly</h3>
        </div>
        <p className={styles.empty}>Not enough 1X2 / Over-Under / HT odds for this match.</p>
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
    pOver45,
    pOver55,
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
      ? "Balanced"
      : `${dominanceSide === "HOME" ? "Home" : "Away"}${
          isExtremeDominance ? " (Extreme)" : isHeavyFavorite ? " (Heavy)" : ""
        }`;

  const pc = (v: number | null | undefined): string => (v != null ? `${v}%` : "—");

  return (
    <section className={styles.card}>
      <div className={styles.head}>
        <h3 className={styles.title}>🎯 Goal &amp; Market Anomaly</h3>
        <span className={styles.tag}>{SCORE_PROFILE_LABEL[scoreProfile]}</span>
        {actualScore ? <span className={styles.tag}>FT {actualScore}</span> : null}
        <span className={styles.info} title={INFO} aria-label={INFO}>
          i
        </span>
      </div>

      <div className={styles.verdicts}>
        <div className={styles.verdict}>
          <span className={styles.label}>First Half</span>
          <span className={styles.verdictText}>{htVerdict || "Balanced First Half"}</span>
        </div>
        <div className={styles.verdict}>
          <span className={styles.label}>Full Time</span>
          <span className={styles.verdictText}>{ftVerdict || "Normal Tempo"}</span>
        </div>
        <div className={styles.verdict}>
          <span className={styles.label}>Team Goal Safety</span>
          <span className={styles.verdictText}>{teamGoalVerdict}</span>
        </div>
      </div>

      {anomalies.length > 0 ? (
        <div className={styles.alerts} role="status">
          {anomalies.map((item, idx) => (
            <p key={idx} className={styles.alert}>
              🚨 {item}
            </p>
          ))}
        </div>
      ) : (
        <p className={styles.muted} style={{ margin: "0 0 0.5rem", fontSize: "0.76rem" }}>
          No significant odds anomaly detected.
        </p>
      )}

      <div className={styles.chips}>
        <div className={styles.chip}>
          <span className={styles.label}>Side Pressure</span>
          <span className={styles.chipValue}>
            {favoriteLabel}
            {favoriteOdds != null ? <span className={styles.chipSub}>@{favoriteOdds.toFixed(2)}</span> : null}
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>HT 0:0</span>
          <span className={styles.chipValue}>{htZeroZeroOdd != null ? `@${htZeroZeroOdd.toFixed(2)}` : "—"}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>BTTS</span>
          <span className={`${styles.chipValue} ${bttsExpectancy ? styles.pos : styles.neg}`}>
            {bttsExpectancy ? "Yes (High)" : "No (Low)"}
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Fair Goal Line</span>
          <span className={styles.chipValue}>{fairGoalLine}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Over 2.5</span>
          <span className={styles.chipValue}>{pc(pOver25)}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Over 3.5</span>
          <span className={styles.chipValue}>{pc(pOver35)}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Over 4.5</span>
          <span className={styles.chipValue}>{pc(pOver45)}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Over 5.5</span>
          <span className={styles.chipValue}>{pc(pOver55)}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>1X2 Flow</span>
          <span className={styles.chipValue}>{moneyFlow1X2}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>2.5 Liquidity</span>
          <span className={styles.chipValue}>{ouFlow}</span>
        </div>
      </div>
    </section>
  );
}
