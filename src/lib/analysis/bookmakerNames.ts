import { sql } from "@/lib/db";

let bmNamesCache: { at: number; map: Map<string, string> } | null = null;
const BM_NAMES_TTL_MS = 10 * 60_000;

/**
 * quotes_flat (Koyeb'den gelen quotes tablosu) sadece bookmaker_id taşıyor,
 * isim taşımıyor — bu yüzden isimleri fixture.bookmakers jsonb map'inden
 * (hafif, LIMIT 30) ayrıca çözüyoruz.
 *
 * ÖNEMLİ: sırasız LIMIT 30 eski/boş bültenlerden satır çekebiliyordu —
 * bulletin_date + kickoff_at DESC ile EN GÜNCEL bültenden başlıyoruz, ki
 * dropdown günün 20 bookmaker'ını gerçekten göstersin. Boş harita da artık
 * cache'lenmiyor (aksi halde bir kerelik boş dönüş 10dk "Any" takılı bırakırdı).
 */
export async function loadBookmakerNames(): Promise<Map<string, string>> {
  if (bmNamesCache && Date.now() - bmNamesCache.at < BM_NAMES_TTL_MS) {
    return bmNamesCache.map;
  }
  const map = new Map<string, string>();
  try {
    const rows = await sql.unsafe<{ bookmakers: Record<string, string> | null }[]>(
      `SELECT bookmakers FROM fixture
       WHERE bookmakers IS NOT NULL
       ORDER BY bulletin_date DESC, kickoff_at DESC
       LIMIT 30`,
    );
    for (const row of rows) {
      const bms = row.bookmakers;
      if (!bms || typeof bms !== "object") continue;
      for (const [id, name] of Object.entries(bms)) {
        if (id && !map.has(id)) map.set(id, String(name || id));
      }
    }
  } catch {
    // isim çözemezsek id'yi gösteririz — kritik değil
  }
  if (map.size > 0) {
    bmNamesCache = { at: Date.now(), map };
  }
  return map;
}
