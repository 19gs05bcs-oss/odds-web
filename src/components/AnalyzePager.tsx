"use client";

import styles from "./AnalyzePager.module.css";

type Props = {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  /** Aday satır tavanına takıldı: gerçek toplam daha yüksek olabilir. */
  capped?: boolean;
  /** Oran filtresi geniş sette yalnızca ilk kısmı taradı. */
  filterScanCapped?: boolean;
  disabled?: boolean;
  onPage: (page: number) => void;
};

/** 1 … 4 5 [6] 7 8 … 20 biçiminde pencere. */
function pageWindow(page: number, count: number): (number | "gap")[] {
  const out: (number | "gap")[] = [];
  const add = (n: number) => {
    if (n >= 1 && n <= count && !out.includes(n)) out.push(n);
  };
  add(1);
  for (let n = page - 2; n <= page + 2; n++) add(n);
  add(count);
  const withGaps: (number | "gap")[] = [];
  for (let i = 0; i < out.length; i++) {
    const cur = out[i] as number;
    const prev = out[i - 1] as number | undefined;
    if (prev !== undefined && cur - prev > 1) withGaps.push("gap");
    withGaps.push(cur);
  }
  return withGaps;
}

export function AnalyzePager({
  page,
  pageCount,
  pageSize,
  total,
  capped,
  filterScanCapped,
  disabled,
  onPage,
}: Props) {
  if (total <= 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const fmt = (n: number) => n.toLocaleString("en-US");
  return (
    <nav className={styles.pager} aria-label="Archive pages">
      <span className={styles.info}>
        {fmt(from)}–{fmt(to)} of {fmt(total)}
        {capped ? "+" : ""} matches
      </span>
      {pageCount > 1 ? (
        <div className={styles.buttons}>
          <button
            type="button"
            className={styles.btn}
            disabled={disabled || page <= 1}
            onClick={() => onPage(page - 1)}
          >
            ‹ Prev
          </button>
          {pageWindow(page, pageCount).map((p, i) =>
            p === "gap" ? (
              <span key={`g${i}`} className={styles.gap}>
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                className={`${styles.btn} ${p === page ? styles.active : ""}`}
                disabled={disabled}
                aria-current={p === page ? "page" : undefined}
                onClick={() => onPage(p)}
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button"
            className={styles.btn}
            disabled={disabled || page >= pageCount}
            onClick={() => onPage(page + 1)}
          >
            Next ›
          </button>
        </div>
      ) : null}
      {capped ? (
        <span className={styles.note}>
          Very broad profile: showing the most recent 30,000 matches. Add a filter or lower the
          tolerance to narrow it down.
        </span>
      ) : null}
      {filterScanCapped ? (
        <span className={styles.note}>
          Odds-column filters were applied to the first 6,000 matches of this result. Add more
          criteria to search the rest.
        </span>
      ) : null}
    </nav>
  );
}
