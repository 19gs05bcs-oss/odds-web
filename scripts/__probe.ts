// Gecici: asamali Supabase probe — her adimi zamanla logla.
import { readFileSync } from "fs";

async function main() {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
  console.log("A: env ok, url prefix:", (process.env.NEXT_PUBLIC_SUPABASE_URL || "").slice(0, 32));

  (globalThis as Record<string, unknown>).WebSocket = (await import("ws")).default;
  console.log("B: ws polyfill ok");

  const { getSupabase } = await import("@/lib/supabase");
  const sb = getSupabase();
  console.log("C: client:", sb ? "ok" : "null");

  const t1 = Date.now();
  const p1 = await sb!.from("seasons").select("id").limit(3);
  console.log("D: seasons sorgu", Date.now() - t1, "ms →", JSON.stringify(p1.data), p1.error?.message ?? "");

  const t2 = Date.now();
  const p2 = await sb!
    .from("events")
    .select("id")
    .eq("source", "flashscore")
    .eq("season_slug", "england/premier-league-2023-2024")
    .limit(3);
  console.log("E: events meta sorgu", Date.now() - t2, "ms →", (p2.data ?? []).length, "kayit", p2.error?.message ?? "");
  process.exit(0);
}

void main();
