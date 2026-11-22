/**
 * Football dışı sporlar (basketbol / hentbol / voleybol) için SABİT BM listesi.
 * - Listeyi seçili maça değil, o günün tüm maçlarına (+ global BM listesine) göre kurar,
 *   bu yüzden maç değiştikçe değişmez.
 * - Her zaman alfabetik (harf duyarsız) sıralanır.
 * Saf modül: hem istemci hem sunucuda kullanılabilir.
 */

export type BmOpt = { id: string; name: string };

type FxLike = { odds?: unknown; bookmakers?: unknown } | null | undefined;

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function buildSortedBmList(fixtures: FxLike[], globalBms: BmOpt[] = []): BmOpt[] {
  const ids = new Set<string>();
  const real = new Map<string, string>();
  const setName = (id: string, name: unknown) => {
    const n = typeof name === "string" ? name.trim() : "";
    if (n && !real.has(id)) real.set(id, n);
  };

  for (const fx of fixtures) {
    const odds = fx?.odds;
    if (!Array.isArray(odds) || !odds.length) continue;
    const names = (fx?.bookmakers ?? {}) as Record<string, string>;
    for (const row of odds as unknown[][]) {
      const bid = Number(row?.[0]);
      if (!Number.isFinite(bid)) continue;
      const id = String(bid);
      ids.add(id);
      setName(id, names[id]);
    }
  }
  for (const g of globalBms) {
    const id = String(g.id);
    ids.add(id);
    setName(id, g.name);
  }

  return [...ids]
    .map((id) => ({ id, name: real.get(id) ?? `BM ${id}` }))
    .sort((a, b) => collator.compare(a.name, b.name) || Number(a.id) - Number(b.id));
}
