import {
  DISPERSION_SIGNAL_THRESHOLD,
  SIDE_LABEL_TR,
  SKEW_SIGNAL_THRESHOLD,
  type MarketSignals,
  type Side,
} from "@/lib/analysis/marketSignals";
import styles from "./SmartAnalysisClient.module.css";

const SIDES: Side[] = ["H", "D", "A"];
const BAR_CLASS: Record<Side, string> = { H: styles.barH, D: styles.barD, A: styles.barA };

export function MarketSignalsPanel({ signals }: { signals: MarketSignals | null }) {
  if (!signals) {
    return (
      <section className={styles.card}>
        <h3>Piyasa Sinyalleri</h3>
        <p className={styles.empty}>
          Bu maç için en az 3 büroda tam 1X2 (H/D/A) oranı bulunmadığından piyasa sinyali
          hesaplanamadı.
        </p>
      </section>
    );
  }

  const { dispersion, avgDispersionPct, arbitrage, skew, protectedSide, protectedSkewPct, bmCount, confidence } =
    signals;
  const highDispersion = avgDispersionPct >= DISPERSION_SIGNAL_THRESHOLD;
  const highSkew = protectedSkewPct >= SKEW_SIGNAL_THRESHOLD;

  return (
    <section className={styles.card}>
      <h3>
        Piyasa Sinyalleri{" "}
        <span className={styles.muted}>
          · {bmCount} büro{confidence === "low" ? " · düşük güven" : ""}
        </span>
      </h3>
      <p className={styles.cardLead}>
        Similarity aramasından önce, bu maçın kendi 1X2 oranlarından hesaplanan büro saçılması,
        arbitraj ve marj dağılımı. Aşağıdaki sinyaller sadece piyasanın şu an nasıl fiyatlandığını
        özetler — tek başına kesin bir tahmin değildir.
      </p>

      {confidence === "low" ? (
        <p className={styles.hint}>
          Bu maçta yalnızca {bmCount} büro tam 1X2 veriyor (eşik: 10). Az sayıda büroda tek bir
          garip fiyat tüm sinyali domine edebilir — aşağıdaki sonuçları düşük güvenle
          değerlendirin.
        </p>
      ) : null}

      {arbitrage ? (
        <div className={styles.steamAlerts} role="status">
          <p className={styles.steamAlertItem}>
            <span className={styles.steamAlertIcon} aria-hidden="true">
              💰
            </span>
            Net arbitraj: <span className={styles.pos}>%{arbitrage.profitPct}</span>
          </p>
          <p className={styles.muted} style={{ fontSize: "0.8rem" }}>
            {arbitrage.legs
              .map((l) => `${SIDE_LABEL_TR[l.side]}: ${l.bookmaker} @ ${l.odds}`)
              .join(" · ")}
          </p>
        </div>
      ) : null}

      <p className={styles.subHead}>
        <strong>Büro Saçılması (Dispersion)</strong>{" "}
        <span className={highDispersion ? styles.neg : styles.muted}>
          ort. CV %{avgDispersionPct}
        </span>
      </p>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Taraf</th>
              <th>Min</th>
              <th>Ort.</th>
              <th>Max</th>
              <th>CV %</th>
              <th>En iyi oran</th>
            </tr>
          </thead>
          <tbody>
            {SIDES.map((side) => (
              <tr key={side}>
                <td>{SIDE_LABEL_TR[side]}</td>
                <td>{dispersion[side].min}</td>
                <td>{dispersion[side].mean}</td>
                <td>{dispersion[side].max}</td>
                <td>{dispersion[side].cv}</td>
                <td>{dispersion[side].bestBookmaker}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className={styles.subHead}>
        <strong>Marj Dağılımı (Margin Skew)</strong>
      </p>
      <div className={styles.outcomeBar} title={SIDES.map((s) => `${s}: %${skew[s]}`).join(" · ")}>
        {SIDES.map((side) => (
          <div
            key={side}
            className={BAR_CLASS[side]}
            style={{ width: `${Math.max(skew[side], 0)}%` }}
          />
        ))}
      </div>
      <p className={styles.cardLead}>
        Ev %{skew.H} · Beraberlik %{skew.D} · Deplasman %{skew.A}
        {highSkew ? (
          <>
            {" — "}
            <strong>marj en çok {SIDE_LABEL_TR[protectedSide]} tarafına yığılmış</strong>
          </>
        ) : null}
      </p>
    </section>
  );
}
