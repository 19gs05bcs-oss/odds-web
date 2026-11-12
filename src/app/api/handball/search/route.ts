import { searchMatches } from "@/lib/handball";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return Response.json([]);
  try {
    return Response.json(await searchMatches(q, 20));
  } catch (e) {
    return Response.json({ error: "veri okunamadı" }, { status: 500 });
  }
}
