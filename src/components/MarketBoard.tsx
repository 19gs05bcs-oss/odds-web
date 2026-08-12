import { prettySideName } from "@/lib/analysis/labels";
import { formatOdds } from "@/lib/format";
import type { MarketsBlob } from "@/lib/types";
import styles from "./MarketBoard.module.css";

type Props = {
  markets: MarketsBlob;
};

export function MarketBoard({ markets }: Props) {
  const list = markets.markets ?? [];
  if (!list.length) {
    return <p className={styles.empty}>No market data for this match yet.</p>;
  }

  return (
    <div className={styles.board}>
      {list.map((market, mi) => (
        <section
          key={market.key || market.name}
          className={styles.market}
          style={{ animationDelay: `${Math.min(mi, 10) * 0.05}s` }}
        >
          <h3 className={styles.title}>{market.name}</h3>
          <div className={styles.grid}>
            {(market.selections ?? []).map((sel) => {
              const hot = sel.odds != null && sel.odds >= 1.01 && sel.odds < 2.2;
              const open = sel.opening;
              const close = sel.odds;
              return (
                <div
                  key={sel.key || sel.name}
                  className={`${styles.sel} ${sel.suspended ? styles.selSuspended : ""}`}
                >
                  <span className={styles.name}>
                    {prettySideName(sel.key || "", sel.name, market.type)}
                  </span>
                  <div className={styles.prices}>
                    {open != null && (
                      <span className={styles.open} title="Opening">
                        {formatOdds(open)}
                      </span>
                    )}
                    <span className={`${styles.odds} ${hot ? styles.oddsHot : ""}`} title="Closing">
                      {formatOdds(close)}
                    </span>
                  </div>
                  {sel.bookmaker_name || sel.bookmaker_id ? (
                    <span className={styles.book}>
                      {sel.bookmaker_name || sel.bookmaker_id}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
