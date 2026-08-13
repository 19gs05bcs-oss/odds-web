// Gecici smoke test: Supabase arşiv yükleyicisini dogrular.
import { readFileSync } from "fs";

async function main() {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }

  const { startSeasonGzWarm, ensureSeasonGzCache } = await import(
    "@/lib/analysis/seasonGzCache"
  );

  const { getSupabase } = await import("@/lib/supabase");
  (globalThis as Record<string, unknown>).WebSocket = (await import("ws")).default;
  const sb = getSupabase();
  const probe = await sb!.from("seasons").select("id").limit(3);
  console.log("PROBE seasons:", JSON.stringify(probe.data), probe.error?.message ?? "hata yok");

  const t0 = Date.now();
  startSeasonGzWarm();
  const { matches, status } = await ensureSeasonGzCache(3_600_000);
  console.log(
    `SONUC status=${status.status} matches=${matches.length} seasons=${status.filesDone}/${status.files} sure=${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
  if (status.error) console.log("HATA:", status.error);
  console.log("env URL var mi:", Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL));
  const sample = matches[Math.floor(matches.length / 2)];
  console.log("ornek mac:", sample?.home, "-", sample?.away, "odds satiri:", sample?.odds?.length);
  console.log("ornek odds[0..2]:", JSON.stringify(sample?.odds?.slice(0, 3)));
  process.exit(status.status === "ready" ? 0 : 1);
}

void main();
