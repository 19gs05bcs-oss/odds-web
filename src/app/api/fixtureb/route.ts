import { NextResponse } from "next/server";
import { fetchFixtureBMeta, listFixtureBDates } from "@/lib/fixtureb";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** ?dates=1 → gün listesi · ?date=YYYY-MM-DD → o günün basketbol maçları */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  try {
    if (sp.get("dates")) return NextResponse.json({ dates: await listFixtureBDates() });
    const date = sp.get("date")?.trim();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ fixtures: [], error: "date required" }, { status: 400 });
    }
    return NextResponse.json({ fixtures: await fetchFixtureBMeta(date) });
  } catch (e) {
    return NextResponse.json(
      { fixtures: [], dates: [], error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
