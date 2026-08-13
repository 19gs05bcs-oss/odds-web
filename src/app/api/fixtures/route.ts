import { NextResponse } from "next/server";
import {
  fetchFixturesMeta,
  fetchFixturesOdds,
  fetchFixturesOddsByDate,
  listFixtures,
  type FixtureRow,
} from "@/lib/archiveCache";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * ?date=YYYY-MM-DD
 * ?phase=meta   → sadece isimler (hızlı)
 * ?phase=odds&date=YYYY-MM-DD → tüm gün odds (tek sorgu, hızlı)
 * ?phase=odds&ids=a,b,c → oran doldur (paralel chunk)
 * (phase yok) → meta+odds birleşik
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date")?.trim() || undefined;
  const phase = (searchParams.get("phase") || "").trim();

  try {
    if (phase === "meta") {
      if (!date) {
        return NextResponse.json({ fixtures: [], error: "date required" }, { status: 400 });
      }
      const fixtures = await fetchFixturesMeta(date);
      return NextResponse.json({ fixtures, phase: "meta" });
    }

    if (phase === "odds") {
      const dateOnly = searchParams.get("date")?.trim();
      if (dateOnly && !searchParams.get("ids")) {
        const map = await fetchFixturesOddsByDate(dateOnly);
        const fixtures: Partial<FixtureRow>[] = [];
        for (const [match_id, o] of map) {
          fixtures.push({ match_id, ...o });
        }
        return NextResponse.json({ fixtures, phase: "odds", date: dateOnly });
      }

      const ids = (searchParams.get("ids") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 200);
      const map = await fetchFixturesOdds(ids);
      const fixtures: Partial<FixtureRow>[] = [];
      for (const id of ids) {
        const o = map.get(id);
        if (o) fixtures.push({ match_id: id, ...o });
      }
      return NextResponse.json({ fixtures, phase: "odds" });
    }

    const fixtures = await listFixtures(date);
    return NextResponse.json({ fixtures });
  } catch (e) {
    return NextResponse.json(
      { fixtures: [], error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
