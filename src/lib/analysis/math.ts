/** Pure odds math — no I/O. */

export function impliedProb(odds: number | null | undefined): number | null {
  if (odds == null || !Number.isFinite(odds) || odds <= 1) return null;
  return 1 / odds;
}

/** Multiplicative de-vig across outcomes in one market (same book). */
export function devigMultiplicative(probs: Array<number | null | undefined>): Array<number | null> {
  const valid = probs.map((p) => (p != null && p > 0 ? p : null));
  const sum = valid.reduce<number>((acc, p) => acc + (p ?? 0), 0);
  if (sum <= 0) return probs.map(() => null);
  return valid.map((p) => (p == null ? null : p / sum));
}

/** Edge %: how much closing odds beat fair probability. Positive = +EV vs model. */
export function edgePct(odds: number | null | undefined, fairProb: number | null | undefined): number | null {
  if (odds == null || fairProb == null || odds <= 1 || fairProb <= 0 || fairProb >= 1) {
    return null;
  }
  const implied = 1 / odds;
  return ((fairProb - implied) / fairProb) * 100;
}

/** Odds-relative drift %: (closing - opening) / opening * 100 */
export function driftOddsPct(opening: number | null | undefined, closing: number | null | undefined): number | null {
  if (opening == null || closing == null || opening <= 0) return null;
  return ((closing - opening) / opening) * 100;
}

/** Implied-prob drift in percentage points * 100 scale as % of open prob. */
export function driftProbPct(opening: number | null | undefined, closing: number | null | undefined): number | null {
  const po = impliedProb(opening ?? null);
  const pc = impliedProb(closing ?? null);
  if (po == null || pc == null || po <= 0) return null;
  return ((pc - po) / po) * 100;
}

export function clvPct(takenOdds: number | null | undefined, closingOdds: number | null | undefined): number | null {
  // Closing line value vs closing price: positive if you beat the close
  return driftOddsPct(closingOdds, takenOdds);
}

export function bestClosing(
  quotes: Array<{ closing: number | null; bookmakerId: string | null; bookmakerName: string | null }>,
): { closing: number; bookmakerId: string | null; bookmakerName: string | null } | null {
  let best: { closing: number; bookmakerId: string | null; bookmakerName: string | null } | null = null;
  for (const q of quotes) {
    if (q.closing == null || q.closing <= 1) continue;
    if (!best || q.closing > best.closing) {
      best = {
        closing: q.closing,
        bookmakerId: q.bookmakerId,
        bookmakerName: q.bookmakerName,
      };
    }
  }
  return best;
}
