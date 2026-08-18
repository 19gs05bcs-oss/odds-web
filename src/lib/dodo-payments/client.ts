import DodoPayments from "dodopayments";
import type { PlanId } from "@/lib/auth/subscription";

let _client: DodoPayments | null = null;

function client(): DodoPayments {
  if (_client) return _client;
  const bearerToken = process.env.DODO_PAYMENTS_API_KEY?.trim();
  if (!bearerToken) throw new Error("DODO_PAYMENTS_API_KEY missing");
  const environment =
    process.env.DODO_PAYMENTS_ENVIRONMENT?.trim() === "live_mode" ? "live_mode" : "test_mode";
  _client = new DodoPayments({ bearerToken, environment });
  return _client;
}

export function productIdForPlan(plan: PlanId): string {
  const map: Record<PlanId, string | undefined> = {
    starter: process.env.DODO_PRODUCT_STARTER?.trim(),
    pro: process.env.DODO_PRODUCT_PRO?.trim(),
    analyst: process.env.DODO_PRODUCT_ANALYST?.trim(),
    team: process.env.DODO_PRODUCT_TEAM?.trim(),
  };
  const id = map[plan];
  if (!id) throw new Error(`Dodo Payments product not configured for plan: ${plan}`);
  return id;
}

export async function createCheckout(opts: {
  plan: PlanId;
  userId: string;
  userEmail: string;
}): Promise<string> {
  const productId = productIdForPlan(opts.plan);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3001";

  const session = await client().checkoutSessions.create({
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: { email: opts.userEmail },
    billing_currency: "USD",
    metadata: { user_id: opts.userId, plan: opts.plan },
    return_url: `${appUrl}/account?checkout=success`,
  });

  if (!session.checkout_url) {
    throw new Error("Checkout URL missing from Dodo Payments response");
  }
  return session.checkout_url;
}

export async function createCustomerPortalLink(customerId: string): Promise<string> {
  const session = await client().customers.customerPortal.create(customerId);
  if (!session.link) throw new Error("Portal link missing from Dodo Payments response");
  return session.link;
}
