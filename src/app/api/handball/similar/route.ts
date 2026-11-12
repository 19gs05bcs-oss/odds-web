import { similar, type CompactOddsRow } from "@/lib/handball";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id gerekli" }, { status: 400 });
  try {
    const r = await similar(id, 10);
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
    const body = (await req.json()) as { id?: string; odds?: CompactOddsRow[] };
    const id = body.id?.trim();
    if (!id) return Response.json({ error: "id gerekli" }, { status: 400 });
    const r = await similar(id, 10, Array.isArray(body.odds) ? body.odds : null);
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
