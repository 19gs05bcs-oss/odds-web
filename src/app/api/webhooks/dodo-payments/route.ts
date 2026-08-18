import { NextResponse } from "next/server";
import { Webhook } from "standardwebhooks";
import { mapDodoStatus, planFromProductId } from "@/lib/auth/subscription";
import { upsertProfileFromWebhook } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DodoSubscriptionPayload = {
  subscription_id?: string;
  customer?: { customer_id?: string; email?: string };
  product_id?: string;
  status?: string;
  next_billing_date?: string | null;
  cancelled_at?: string | null;
  metadata?: { user_id?: string };
};

type DodoWebhook = {
  type?: string;
  data?: DodoSubscriptionPayload;
};

async function handleSubscriptionEvent(payload: DodoWebhook) {
  const data = payload.data;
  if (!data) return;

  const userId = data.metadata?.user_id;
  if (!userId) {
    console.warn("[dodo webhook] missing metadata.user_id", payload.type);
    return;
  }

  const eventName = payload.type || "";
  const status =
    eventName === "subscription.cancelled" || eventName === "subscription.canceled"
      ? "cancelled"
      : eventName === "subscription.expired"
        ? "expired"
        : mapDodoStatus(data.status || "active");

  await upsertProfileFromWebhook({
    userId,
    email: data.customer?.email ?? null,
    planId: planFromProductId(data.product_id),
    subscriptionStatus: status,
    dodoCustomerId: data.customer?.customer_id != null ? String(data.customer.customer_id) : null,
    dodoSubscriptionId: data.subscription_id != null ? String(data.subscription_id) : null,
    dodoProductId: data.product_id != null ? String(data.product_id) : null,
    currentPeriodEnd: data.next_billing_date || data.cancelled_at || null,
  });
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const secret = process.env.DODO_PAYMENTS_WEBHOOK_KEY?.trim();
  if (!secret) {
    console.error("[dodo webhook] DODO_PAYMENTS_WEBHOOK_KEY missing");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  let payload: DodoWebhook;
  try {
    const headers = {
      "webhook-id": request.headers.get("webhook-id") || "",
      "webhook-signature": request.headers.get("webhook-signature") || "",
      "webhook-timestamp": request.headers.get("webhook-timestamp") || "",
    };
    payload = (await new Webhook(secret).verify(rawBody, headers)) as DodoWebhook;
  } catch (e) {
    console.error("[dodo webhook] signature verification failed", e);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const eventName = payload.type || "";

  try {
    switch (eventName) {
      case "subscription.active":
      case "subscription.renewed":
      case "subscription.updated":
      case "subscription.on_hold":
      case "subscription.cancelled":
      case "subscription.canceled":
      case "subscription.expired":
      case "subscription.failed":
        await handleSubscriptionEvent(payload);
        break;
      default:
        break;
    }
  } catch (e) {
    console.error("[dodo webhook]", eventName, e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Webhook handler failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true });
}
