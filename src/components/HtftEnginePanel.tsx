import { HTFT_COMBO_LABEL, type HtftEngineResult } from "@/lib/analysis/htftEngine";
import styles from "./SmartAnalysisClient.module.css";

const RANK_ICON = ["🎯", "🛡️", "⚡"];

export function HtftEnginePanel({ result }: { result: HtftEngineResult | null }) {
  if (!result) {
    return (
      <section className={styles.card}>
        <h3>⏱️ HT/FT Engine</h3>
        <p className={styles.empty}>
          Not enough First Half / Full Time 1X2 odds data was found for this match to run the
          HT/FT matrix model.
        </p>
      </section>
    );
  }

  const { picks, favSide, favOdd, turnaroundAlert } = result;
  const top3 = picks.slice(0, 3);
  const rest = picks.slice(3);

  return (
    <section className={styles.card}>
      <h3>
        ⏱️ HT/FT Engine{" "}
        <span className={styles.muted}>
          · Favourite {favSide === "HOME" ? "Home" : "Away"} @{favOdd.toFixed(2)}
        </span>
      </h3>
      <p className={styles.cardLead}>
        A weighted probability distribution across all 9 HT/FT combinations, derived from this
        match&rsquo;s own First Half, Second Half, and Full Time 1X2 odds plus BTTS / Over 2.5.
        A probability model, not a guaranteed outcome.
      </p>

      {turnaroundAlert ? (
        <div className={styles.steamAlerts} role="status">
          <p className={styles.steamAlertItem}>
            <span className={styles.steamAlertIcon} aria-hidden="true">
              ⚡
            </span>
            {turnaroundAlert}
          </p>
        </div>
      ) : null}

      <p className={styles.subHead}>
        <strong>Top 3 Picks</strong>
      </p>
      <div className={styles.geStatsGrid}>
        {top3.map((p, i) => (
          <div className={styles.geStat} key={p.combo}>
            <span className={styles.geStatLabel}>
              {RANK_ICON[i]} {HTFT_COMBO_LABEL[p.combo]}
            </span>
            <span className={styles.geStatValue}>{p.combo}</span>
            <span className={styles.geStatSub}>%{p.prob.toFixed(1)}</span>
          </div>
        ))}
      </div>

      <p className={styles.subHead}>
        <strong>Full Matrix</strong>
      </p>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>HT/FT</th>
              <th>Meaning</th>
              <th>Probability</th>
            </tr>
          </thead>
          <tbody>
            {rest.map((p) => (
              <tr key={p.combo}>
                <td>{p.combo}</td>
                <td>{HTFT_COMBO_LABEL[p.combo]}</td>
                <td>%{p.prob.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
