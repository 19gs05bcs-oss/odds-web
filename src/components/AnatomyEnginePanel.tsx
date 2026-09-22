import type { AnatomyEngineResult, XraySide } from "@/lib/analysis/anatomyEngine";
import styles from "./SmartAnalysisClient.module.css";

const XRAY_LABEL: Record<XraySide, string> = {
  LOW: "Low scoring",
  DRAW: "Draw",
  OVER: "Over / goals",
  AWAY: "Away",
  HOME: "Home",
  NONE: "No clear signal",
};

const DIRECTION_ICON: Record<"UP" | "DOWN" | "FLAT", string> = {
  UP: "📈",
  DOWN: "📉",
  FLAT: "➡️",
};

function HitTag({ hit, label }: { hit: boolean; label: string }) {
  return (
    <span className={hit ? styles.pos : styles.neg}>
      {hit ? "✓" : "✗"} {label}
    </span>
  );
}

export function AnatomyEnginePanel({ result }: { result: AnatomyEngineResult | null }) {
  if (!result) {
    return (
      <section className={styles.card}>
        <h3>📡 Market Detect</h3>
        <p className={styles.empty}>
          Not enough FT 1X2 odds on this match yet to read the market.
        </p>
      </section>
    );
  }

  const {
    favSide,
    favOdd,
    homeDirection,
    awayDirection,
    xraySide,
    marginLabel,
    tempoLabel,
    isSuperExplosive,
    hotScores,
    topDrops,
    isMajorLeague,
    actual,
  } = result;

  return (
    <section className={styles.card}>
      <h3>
        📡 Market Detect{" "}
        <span className={styles.muted}>
          · Favourite {favSide === "HOME" ? "Home" : "Away"} @{favOdd.toFixed(2)}
        </span>
      </h3>
      <p className={styles.cardLead}>
        A liquidity-weighted read of how every quoted market moved between opening and current
        price across all bookmakers on this fixture — which side the sharpest money is leaning
        on, the expected goal-margin corridor, and the tempo/goal-count read. This is a market
        scan, not a guaranteed outcome.
      </p>

      <p className={styles.subHead}>
        Directions: Home {DIRECTION_ICON[homeDirection]} {homeDirection} · Away{" "}
        {DIRECTION_ICON[awayDirection]} {awayDirection}
        {isMajorLeague ? <span className={styles.geScoreTag}> Major League</span> : null}
      </p>

      <div className={styles.geVerdictGrid}>
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>X-ray side</span>
          <span className={styles.geVerdictText}>{XRAY_LABEL[xraySide]}</span>
        </div>
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>Margin corridor</span>
          <span className={styles.geVerdictText}>{marginLabel}</span>
        </div>
        <div className={styles.geVerdictBox}>
          <span className={styles.geVerdictLabel}>Tempo read</span>
          <span className={styles.geVerdictText}>
            {isSuperExplosive ? "🌋 " : ""}
            {tempoLabel}
          </span>
        </div>
      </div>

      {hotScores.length ? (
        <>
          <p className={styles.subHead}>
            <strong>Hot Correct Score prices</strong>
          </p>
          <p className={styles.cardLead}>
            {hotScores.map((s) => (
              <span key={s} className={styles.geScoreTag} style={{ marginRight: "0.4rem" }}>
                {s}
                {actual?.score === s ? " ←" : ""}
              </span>
            ))}
          </p>
        </>
      ) : null}

      {topDrops.length ? (
        <>
          <p className={styles.subHead}>
            <strong>Biggest liquidity-weighted drops</strong>
          </p>
          <ul className={styles.cardLead} style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {topDrops.slice(0, 5).map((m) => (
              <li key={m.label}>
                <span className={styles.muted}>{m.label}</span> {m.openOdd.toFixed(2)} →{" "}
                {m.currentOdd.toFixed(2)} ({m.pctMove.toFixed(1)}%, {m.bookCount} books)
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {actual ? (
        <>
          <p className={styles.subHead}>
            Final score: <span className={styles.geScoreTag}>{actual.score}</span>
            {actual.htScore ? <span className={styles.muted}> · HT {actual.htScore}</span> : null}
          </p>
          <div className={styles.geStatsGrid}>
            <div className={styles.geStat}>
              <HitTag hit={actual.scoreHit} label="Hot score" />
            </div>
            {actual.tempoHit != null ? (
              <div className={styles.geStat}>
                <HitTag hit={actual.tempoHit} label="Tempo read" />
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <p className={styles.muted}>Match not finished yet — read shown only.</p>
      )}
    </section>
  );
}
