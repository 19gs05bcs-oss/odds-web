export function formatKickoff(iso: string | null | undefined): string {
  if (!iso) return "No date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Istanbul",
  }).format(d);
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diffMs = d.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (mins < 60) return rtf.format(Math.sign(diffMs) * mins, "minute");
  const hours = Math.round(mins / 60);
  if (hours < 48) return rtf.format(Math.sign(diffMs) * hours, "hour");
  const days = Math.round(hours / 24);
  return rtf.format(Math.sign(diffMs) * days, "day");
}

export function formatOdds(odds: number | null | undefined): string {
  if (odds == null || Number.isNaN(odds)) return "—";
  return odds.toFixed(2);
}

/** SSR + client aynı çıktı — locale kaynaklı hydration hatasını önler. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return "Bookmaker";
  return source.charAt(0).toUpperCase() + source.slice(1);
}
