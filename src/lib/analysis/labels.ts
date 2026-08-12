/** Human-readable selection labels (archive keys → UI). */

export function prettySideName(
  side: string,
  fallbackName: string | null | undefined,
  marketType?: string | null,
): string {
  const s = (side || "").trim();
  const mt = marketType || "";

  if (mt === "BOTH_TEAMS_TO_SCORE" || s.startsWith("btts:")) {
    if (/btts:(YES|True)$/i.test(s) || s === "True" || s === "YES") return "BTTS Yes";
    if (/btts:(NO|False)$/i.test(s) || s === "False" || s === "NO") return "BTTS No";
  }

  if (s === "DC:1X") return "1X";
  if (s === "DC:X2") return "X2";
  if (s === "DC:12") return "12";

  if (s.startsWith("OVER:")) return `Over ${s.slice(5)}`;
  if (s.startsWith("UNDER:")) return `Under ${s.slice(6)}`;

  const name = (fallbackName || "").trim();
  if (name && !/^no$/i.test(name)) return name;
  // Avoid bare "No"/"Yes" without BTTS context when key is clearer
  if (/^yes$/i.test(name) && s.startsWith("btts:")) return "BTTS Yes";
  if (/^no$/i.test(name)) {
    if (s.startsWith("btts:") || mt === "BOTH_TEAMS_TO_SCORE") return "BTTS No";
  }
  return name || s || "?";
}

export function marketTypeLabel(type: string, name?: string | null): string {
  if (name && name.trim() && name !== type) return name.trim();
  const map: Record<string, string> = {
    HOME_DRAW_AWAY: "1X2",
    DOUBLE_CHANCE: "Double Chance",
    BOTH_TEAMS_TO_SCORE: "BTTS",
    OVER_UNDER: "Over/Under",
    DRAW_NO_BET: "Draw No Bet",
    ASIAN_HANDICAP: "Asian Handicap",
    EUROPEAN_HANDICAP: "European Handicap",
    CORRECT_SCORE: "Correct Score",
    HALF_FULL_TIME: "HT/FT",
    ODD_OR_EVEN: "Odd/Even",
  };
  return map[type] || type.replace(/_/g, " ");
}

export function sideMatchesFilter(side: string, sideName: string, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  const s = (side || "").toLowerCase();
  const n = (sideName || "").toLowerCase();
  if (s === f || n === f) return true;
  if (s.endsWith(":" + f) || s.includes(f)) return true;
  if (f === "yes" || f === "var")
    return /btts:(yes|true)$/i.test(side) || /\b(yes|var)\b/i.test(sideName);
  if (f === "no" || f === "yok")
    return /btts:(no|false)$/i.test(side) || /\b(no|yok)\b/i.test(sideName);
  return false;
}
