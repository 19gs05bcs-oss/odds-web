"use client";

/**
 * Legacy results list — AnalyzeClient now uses AnalyzeTable for archive rows.
 * Kept as a thin empty-state helper for any residual imports.
 */
import type { ProfileResult } from "@/lib/analysis/profile";
import styles from "./AnalyzeResults.module.css";

type Props = {
  result: ProfileResult | null;
  error?: string;
  idle?: boolean;
};

export function AnalyzeResults({ result, error, idle }: Props) {
  if (error) return <p className={styles.empty}>{error}</p>;
  if (idle || !result) {
    return (
      <p className={styles.empty}>
        Bülten tablosunda bir oran hücresine tıkla.
      </p>
    );
  }
  if (!result.matches.length) {
    return (
      <p className={styles.empty}>
        Bu oran profiline uyan maç yok. ({result.tookMs} ms)
      </p>
    );
  }
  return (
    <p className={styles.meta}>
      {result.totalMatched} maç · {result.tookMs} ms
    </p>
  );
}
