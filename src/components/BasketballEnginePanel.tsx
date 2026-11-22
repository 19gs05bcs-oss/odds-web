import type { BasketballEngineMetrics } from "@/lib/analysis/basketballEngine";
import styles from "./EnginePanels.module.css";

const INFO =
  "Basketball regime read built from this match's own median 2-way moneyline / spread / total odds (all bookmakers, overtime-inclusive where available) and open→close drift, matched against rules mined from the basketball archive backtest (29,641 played matches). Historical statistics, not a guaranteed prediction.";

const pc = (v: number | null | undefined): string => (v != null ? `${v}%` : "—");
const odd = (v: number | null | undefined): string => (v != null ? v.toFixed(2) : "—");

export function BasketballEnginePanel({
  metrics,
  actualScore,
}: {
  metrics: BasketballEngineMetrics | null;
  actualScore?: string | null;
}) {
  if (!metrics) {
    return (
      <section className={styles.card}>
        <div className={styles.head}>
          <h3 className={styles.title}>🏀 Basketball Market &amp; Tempo Anomaly</h3>
        </div>
        <p className={styles.empty}>Not enough moneyline odds for this match.</p>
      </section>
    );
  }

  const {
    profile,
    leagueSlug,
    ecosystemLabel,
    bookmakerCount,
    favoriteSide,
    favoriteOdds,
    tierLabel,
    pHome,
    pAway,
    c1,
    c2,
    ouLine,
    pOver,
    pUnder,
    overOdds,
    underOdds,
    ahLine,
    ahHomeOdds,
    archiveTotalAnchor,
    moneyFlow,
    ouFlow,
    halftime,
    ftVerdict,
    totalVerdict,
    marketVerdict,
    signals,
    anomalies,
  } = metrics;

  const ruleSignals = signals.filter((s) => !s.context);
  const contextSignals = signals.filter((s) => s.context);

  const renderSignal = (s: (typeof signals)[number], idx: number) => (
    <div key={`${s.id}-${idx}`} className={`${styles.signal} ${s.context ? styles.signalContext : ""}`.trim()}>
      <span className={styles.signalName}>{s.name}</span>
      <span className={styles.signalPick}>
        {s.pick}
        {s.pickOdd != null ? <span className={styles.chipSub}>@{s.pickOdd.toFixed(2)}</span> : null}
      </span>
      <p className={styles.signalReason}>{s.reason}</p>
      {s.note ? <p className={styles.signalReason}>{s.note}</p> : null}
      <p className={styles.signalStats}>{s.statsLine}</p>
    </div>
  );

  return (
    <section className={styles.card}>
      <div className={styles.head}>
        <h3 className={styles.title}>🏀 Basketball Market &amp; Tempo Anomaly</h3>
        <span className={styles.tag}>{profile}</span>
        {actualScore ? <span className={styles.tag}>FT {actualScore}</span> : null}
        <span className={styles.meta} title="League key used for rule matching">
          {leagueSlug}
        </span>
        <span className={styles.info} title={INFO} aria-label={INFO}>
          i
        </span>
      </div>

      <div className={styles.verdicts}>
        <div className={styles.verdict}>
          <span className={styles.label}>Full Time</span>
          <span className={styles.verdictText}>{ftVerdict}</span>
        </div>
        <div className={styles.verdict}>
          <span className={styles.label}>Total Points</span>
          <span className={styles.verdictText}>{totalVerdict}</span>
        </div>
        {halftime ? (
          <div className={styles.verdict}>
            <span className={styles.label}>Half-Time Regime</span>
            <span className={styles.verdictText}>{halftime.label}</span>
          </div>
        ) : null}
        <div className={styles.verdict}>
          <span className={styles.label}>Rule Check</span>
          <span className={styles.verdictText}>
            {ruleSignals.length > 0 && anomalies.length === 0 ? "✅ " : ""}
            {marketVerdict}
          </span>
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

      {ruleSignals.length > 0 ? (
        <>
          <p className={styles.sec}>Archive rule signals</p>
          <div className={styles.signals}>{ruleSignals.map(renderSignal)}</div>
        </>
      ) : null}

      {contextSignals.length > 0 ? (
        <>
          <p className={styles.sec}>Context &amp; live signals</p>
          <div className={styles.signals}>{contextSignals.map(renderSignal)}</div>
        </>
      ) : null}

      <div className={styles.chips}>
        <div className={styles.chip}>
          <span className={styles.label}>Ecosystem</span>
          <span className={styles.chipValue}>{ecosystemLabel}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Side Pressure</span>
          <span className={styles.chipValue}>
            {favoriteSide === "NONE" ? "Balanced" : tierLabel.replace(" Favourite", "")}
            {favoriteOdds != null ? <span className={styles.chipSub}>@{favoriteOdds.toFixed(2)}</span> : null}
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Home / Away</span>
          <span className={styles.chipValue}>
            {pc(pHome)} · {pc(pAway)}
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Moneyline</span>
          <span className={styles.chipValue}>
            {odd(c1)} / {odd(c2)}
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Total Line</span>
          <span className={styles.chipValue}>
            {ouLine ?? "—"}
            <span className={styles.chipSub}>anchor ≈ {archiveTotalAnchor}</span>
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Over</span>
          <span className={styles.chipValue}>
            {pc(pOver)}
            {overOdds != null ? <span className={styles.chipSub}>@{odd(overOdds)}</span> : null}
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Under</span>
          <span className={styles.chipValue}>
            {pc(pUnder)}
            {underOdds != null ? <span className={styles.chipSub}>@{odd(underOdds)}</span> : null}
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Home Spread</span>
          <span className={styles.chipValue}>
            {ahLine != null ? (ahLine > 0 ? `+${ahLine}` : ahLine) : "—"}
            {ahHomeOdds != null ? <span className={styles.chipSub}>@{odd(ahHomeOdds)}</span> : null}
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>ML Flow</span>
          <span className={styles.chipValue}>{moneyFlow}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>O/U Flow</span>
          <span className={styles.chipValue}>{ouFlow}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Bookmakers</span>
          <span className={styles.chipValue}>{bookmakerCount}</span>
        </div>
      </div>
    </section>
  );
}
