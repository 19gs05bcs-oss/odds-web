import { searchMatches } from "@/lib/basketball";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return Response.json([]);
  try {
    return Response.json(await searchMatches(q, 20));
  } catch {
    return Response.json({ error: "could not read data" }, { status: 500 });
  }
}
