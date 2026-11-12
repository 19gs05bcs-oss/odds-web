import { similar, type CompactOddsRow } from "@/lib/handball";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ error: "id gerekli" }, { status: 400 });
  const bmRaw = url.searchParams.get("bookmakerId");
  const bookmakerId = bmRaw != null && bmRaw !== "" ? Number(bmRaw) : null;
  try {
    const r = await similar(
      id,
      10,
      null,
      Number.isFinite(bookmakerId as number) ? bookmakerId : null,
    );
    if (r && !Array.isArray(r) && "error" in r) {
      return Response.json(r, { status: 404 });
    }
    return r ? Response.json(r) : Response.json({ error: "maç bulunamadı" }, { status: 404 });
  } catch (e) {
    console.error("handball similar:", e);
    return Response.json(
      { error: e instanceof Error ? `${e.name}: ${e.message}` : "veri okunamadı" },
      { status: 500 },
    );
  }
}

/** Client oranları body ile de gönderebilir (fixtureh.odds yüklüyse). */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      id?: string;
      odds?: CompactOddsRow[];
      bookmakerId?: number | null;
    };
    const id = body.id?.trim();
    if (!id) return Response.json({ error: "id gerekli" }, { status: 400 });
    const bm =
      body.bookmakerId != null && Number.isFinite(Number(body.bookmakerId))
        ? Number(body.bookmakerId)
        : null;
    const r = await similar(id, 10, Array.isArray(body.odds) ? body.odds : null, bm);
    if (r && !Array.isArray(r) && "error" in r) {
      return Response.json(r, { status: 404 });
    }
    return r ? Response.json(r) : Response.json({ error: "maç bulunamadı" }, { status: 404 });
  } catch (e) {
    console.error("handball similar POST:", e);
    return Response.json(
      { error: e instanceof Error ? `${e.name}: ${e.message}` : "veri okunamadı" },
      { status: 500 },
    );
  }
}
