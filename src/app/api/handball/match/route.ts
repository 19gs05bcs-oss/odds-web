import { matchDetail } from "@/lib/handball";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id gerekli" }, { status: 400 });
  try {
    const r = await matchDetail(id);
    return r ? Response.json(r) : Response.json({ error: "maç bulunamadı" }, { status: 404 });
  } catch (e) {
    return Response.json({ error: "veri okunamadı" }, { status: 500 });
  }
}
