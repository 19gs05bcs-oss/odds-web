import { matchDetail } from "@/lib/basketball";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  try {
    const r = await matchDetail(id);
    return r ? Response.json(r) : Response.json({ error: "match not found" }, { status: 404 });
  } catch {
    return Response.json({ error: "could not read data" }, { status: 500 });
  }
}
