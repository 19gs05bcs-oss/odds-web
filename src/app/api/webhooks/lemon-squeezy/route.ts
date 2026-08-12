import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { mapLemonStatus, planFromVariantId } from "@/lib/auth/subscription";
import { upsertProfileFromWebhook } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type LemonWebhook = {
  meta?: {
    event_name?: string;
    custom_data?: { user_id?: string };
  };
  data?: {
    id?: string;
    attributes?: {
      status?: string;
      user_email?: string;
      customer_id?: number | string;
      variant_id?: number | string;
      renews_at?: string | null;
      ends_at?: string | null;
    };
  };
};

function verifySignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET?.trim();
  if (!secret || !signature) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(signature, "utf8"));
  } catch {
    return false;
  }
}

async function handleSubscriptionEvent(payload: LemonWebhook, eventName: string) {
  const attrs = payload.data?.attributes;
  if (!attrs) return;

  const userId =
    payload.meta?.custom_data?.user_id ||
    (typeof payload.meta?.custom_data === "object" &&
    payload.meta?.custom_data !== null &&
    "user_id" in payload.meta.custom_data
      ? String((payload.meta.custom_data as { user_id?: string }).user_id || "")
      : "");

  if (!userId) {
    console.warn("[lemon webhook] missing user_id in custom_data", eventName);
    return;
  }

  const variantId = attrs.variant_id != null ? String(attrs.variant_id) : null;
  const status =
    eventName === "subscription_expired" || eventName === "subscription_cancelled"
      ? eventName === "subscription_cancelled"
        ? "cancelled"
        : "expired"
      : mapLemonStatus(attrs.status || "active");

  const periodEnd = attrs.renews_at || attrs.ends_at || null;

  await upsertProfileFromWebhook({
    userId,
    email: attrs.user_email ?? null,
    planId: planFromVariantId(variantId),
    subscriptionStatus: status,
    lemonCustomerId: attrs.customer_id != null ? String(attrs.customer_id) : null,
    lemonSubscriptionId: payload.data?.id != null ? String(payload.data.id) : null,
    lemonVariantId: variantId,
    currentPeriodEnd: periodEnd,
  });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-signature");

  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: LemonWebhook;
  try {
    payload = JSON.parse(rawBody) as LemonWebhook;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const eventName = payload.meta?.event_name || "";

  try {
    switch (eventName) {
      case "subscription_created":
      case "subscription_updated":
      case "subscription_resumed":
      case "subscription_payment_success":
        await handleSubscriptionEvent(payload, eventName);
        break;
      case "subscription_cancelled":
      case "subscription_expired":
      case "subscription_paused":
      case "subscription_payment_failed":
        await handleSubscriptionEvent(payload, eventName);
        break;
      default:
        break;
    }
  } catch (e) {
    console.error("[lemon webhook]", eventName, e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Webhook handler failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true });
}
