import type { PlanId } from "@/lib/auth/subscription";

const API_BASE = "https://api.lemonsqueezy.com/v1";

function apiKey(): string {
  const key = process.env.LEMONSQUEEZY_API_KEY?.trim();
  if (!key) throw new Error("LEMONSQUEEZY_API_KEY missing");
  return key;
}

function storeId(): string {
  const id = process.env.LEMONSQUEEZY_STORE_ID?.trim();
  if (!id) throw new Error("LEMONSQUEEZY_STORE_ID missing");
  return id;
}

export function variantIdForPlan(plan: PlanId): string {
  const map: Record<PlanId, string | undefined> = {
    starter: process.env.LEMONSQUEEZY_VARIANT_STARTER?.trim(),
    pro: process.env.LEMONSQUEEZY_VARIANT_PRO?.trim(),
    analyst: process.env.LEMONSQUEEZY_VARIANT_ANALYST?.trim(),
    team: process.env.LEMONSQUEEZY_VARIANT_TEAM?.trim(),
  };
  const id = map[plan];
  if (!id) throw new Error(`Lemon Squeezy variant not configured for plan: ${plan}`);
  return id;
}

export async function createCheckout(opts: {
  plan: PlanId;
  userId: string;
  userEmail: string;
}): Promise<string> {
  const variantId = variantIdForPlan(opts.plan);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://localhost:3001";

  const res = await fetch(`${API_BASE}/checkouts`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      data: {
        type: "checkouts",
        attributes: {
          checkout_options: {
            embed: false,
            media: false,
            logo: true,
          },
          checkout_data: {
            email: opts.userEmail,
            custom: {
              user_id: opts.userId,
            },
          },
          product_options: {
            redirect_url: `${appUrl}/account?checkout=success`,
          },
        },
        relationships: {
          store: {
            data: { type: "stores", id: storeId() },
          },
          variant: {
            data: { type: "variants", id: variantId },
          },
        },
      },
    }),
  });

  const json = (await res.json()) as {
    data?: { attributes?: { url?: string } };
    errors?: { detail?: string }[];
  };

  if (!res.ok) {
    const detail = json.errors?.[0]?.detail || res.statusText;
    throw new Error(`Lemon Squeezy checkout failed: ${detail}`);
  }

  const url = json.data?.attributes?.url;
  if (!url) throw new Error("Checkout URL missing from Lemon Squeezy response");
  return url;
}
