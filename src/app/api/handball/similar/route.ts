import { similar } from "@/lib/handball";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id gerekli" }, { status: 400 });
  try {
    const r = await similar(id, 10);
    return r ? Response.json(r) : Response.json({ error: "maç bulunamadı" }, { status: 404 });
  } catch (e) {
    console.error("handball similar:", e);
    return Response.json(
      { error: e instanceof Error ? `${e.name}: ${e.message}` : "veri okunamadı" },
      { status: 500 },
    );
  }
}
