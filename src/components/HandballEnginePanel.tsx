import type { HandballEngineMetrics } from "@/lib/analysis/handballEngine";
import styles from "./EnginePanels.module.css";

const INFO =
  "Handball regime read built from this match's own median 1X2 / Asian Handicap / Over-Under odds (all bookmakers) and open→close drift, matched against rules mined from 34,932 archived matches (24,740 clean). Historical statistics, not a guaranteed prediction.";

const pc = (v: number | null | undefined): string => (v != null ? `${v}%` : "—");
const odd = (v: number | null | undefined): string => (v != null ? v.toFixed(2) : "—");

export function HandballEnginePanel({
  metrics,
  actualScore,
}: {
  metrics: HandballEngineMetrics | null;
  actualScore?: string | null;
}) {
  if (!metrics) {
    return (
      <section className={styles.card}>
        <div className={styles.head}>
          <h3 className={styles.title}>🤾 Handball Goal &amp; Market Anomaly</h3>
        </div>
        <p className={styles.empty}>Not enough 1X2 odds for this match.</p>
      </section>
    );
  }

  const {
    profile,
    leagueSlug,
    bookmakerCount,
    favoriteSide,
    favoriteOdds,
    tierLabel,
    drawProneBand,
    pHome,
    pDraw,
    pAway,
    cx,
    ouLine,
    pOver,
    pUnder,
    overOdds,
    underOdds,
    ahLine,
    ahHomeOdds,
    moneyFlow1X2,
    ouFlow,
    ftVerdict,
    totalVerdict,
    marketVerdict,
    signals,
    anomalies,
  } = metrics;

  return (
    <section className={styles.card}>
      <div className={styles.head}>
        <h3 className={styles.title}>🤾 Handball Goal &amp; Market Anomaly</h3>
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
          <span className={styles.label}>Total Goals</span>
          <span className={styles.verdictText}>{totalVerdict}</span>
        </div>
        <div className={styles.verdict}>
          <span className={styles.label}>Rule Check</span>
          <span className={styles.verdictText}>
            {signals.some((s) => s.id !== "OVER_STEAM") && anomalies.length === 0 ? "✅ " : ""}
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

      {signals.length > 0 ? (
        <>
          <p className={styles.sec}>Archive rule signals</p>
          <div className={styles.signals}>
            {signals.map((s, idx) => (
              <div
                key={`${s.id}-${idx}`}
                className={`${styles.signal} ${s.id === "OVER_STEAM" ? styles.signalContext : ""}`.trim()}
              >
                <span className={styles.signalName}>{s.name}</span>
                <span className={styles.signalPick}>
                  {s.pick}
                  {s.pickOdd != null ? <span className={styles.chipSub}>@{s.pickOdd.toFixed(2)}</span> : null}
                </span>
                <p className={styles.signalReason}>{s.reason}</p>
                {s.note ? <p className={styles.signalReason}>{s.note}</p> : null}
                <p className={styles.signalStats}>
                  {s.sample.toLocaleString("en-US")} matches · hit {s.hitRate}% · ROI {s.roi >= 0 ? "+" : ""}
                  {s.roi}%{s.positiveSeasons !== "n/a" ? ` · +seasons ${s.positiveSeasons}` : ""}
                  {s.maxDrawdown ? ` · max DD ${s.maxDrawdown}` : ""}
                </p>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className={styles.chips}>
        <div className={styles.chip}>
          <span className={styles.label}>Side Pressure</span>
          <span className={styles.chipValue}>
            {favoriteSide === "NONE" ? "Balanced" : tierLabel.replace(" Favourite", "")}
            {favoriteOdds != null ? <span className={styles.chipSub}>@{favoriteOdds.toFixed(2)}</span> : null}
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Home / Draw / Away</span>
          <span className={styles.chipValue}>
            {pc(pHome)} · {pc(pDraw)} · {pc(pAway)}
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Draw Odds</span>
          <span className={styles.chipValue}>{cx != null ? `@${odd(cx)}` : "—"}</span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Draw Band</span>
          <span className={`${styles.chipValue} ${drawProneBand ? styles.pos : ""}`.trim()}>
            {drawProneBand ? "Draw-prone" : "Normal"}
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>Total Line</span>
          <span className={styles.chipValue}>{ouLine ?? "—"}</span>
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
          <span className={styles.label}>Home AH</span>
          <span className={styles.chipValue}>
            {ahLine != null ? (ahLine > 0 ? `+${ahLine}` : ahLine) : "—"}
            {ahHomeOdds != null ? <span className={styles.chipSub}>@{odd(ahHomeOdds)}</span> : null}
          </span>
        </div>
        <div className={styles.chip}>
          <span className={styles.label}>1X2 Flow</span>
          <span className={styles.chipValue}>{moneyFlow1X2}</span>
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
