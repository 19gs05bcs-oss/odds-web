/** Saf market string yardımcıları — DB/postgres bağımlılığı YOK. */

export function splitMarket(market: string | null): { marketType: string; marketScope: string } {
  if (!market) return { marketType: "UNKNOWN", marketScope: "FULL_TIME" };
  const idx = market.indexOf(":");
  if (idx === -1) return { marketType: market, marketScope: "FULL_TIME" };
  return { marketType: market.slice(0, idx), marketScope: market.slice(idx + 1) };
}
