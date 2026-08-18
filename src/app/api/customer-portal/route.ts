import { NextResponse } from "next/server";
import { getSessionUser, getProfile } from "@/lib/auth/session";
import { createCustomerPortalLink } from "@/lib/dodo-payments/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.redirect(
      new URL("/login", process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001"),
    );
  }

  const profile = await getProfile(user.id);
  if (!profile?.dodo_customer_id) {
    return NextResponse.json({ ok: false, error: "No billing account on file." }, { status: 404 });
  }

  try {
    const link = await createCustomerPortalLink(profile.dodo_customer_id);
    return NextResponse.redirect(link);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
