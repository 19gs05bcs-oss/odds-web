import { NextResponse } from "next/server";
import type { PlanId } from "@/lib/auth/subscription";
import { getSessionUser } from "@/lib/auth/session";
import { createCheckout } from "@/lib/lemon-squeezy/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PLANS = new Set<PlanId>(["starter", "pro", "analyst"]);

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Sign in required." }, { status: 401 });
  }

  let body: { plan?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const plan = body.plan as PlanId;
  if (!plan || !PLANS.has(plan)) {
    return NextResponse.json({ ok: false, error: "Invalid plan." }, { status: 400 });
  }

  try {
    const url = await createCheckout({
      plan,
      userId: user.id,
      userEmail: user.email || "",
    });
    return NextResponse.json({ ok: true, url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
