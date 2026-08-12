"use client";

import { useState } from "react";
import type { PlanId } from "@/lib/auth/subscription";
import styles from "./SubscribeButton.module.css";

type Props = {
  plan: PlanId;
  featured?: boolean;
  label?: string;
};

export function SubscribeButton({ plan, featured, label }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function checkout() {
    setPending(true);
    setError("");
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const json = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent("/#pricing")}`;
        return;
      }
      if (!res.ok || !json.url) {
        throw new Error(json.error || `Checkout failed (${res.status})`);
      }
      window.location.href = json.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed");
      setPending(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={`${styles.btn} ${featured ? styles.featured : ""}`}
        disabled={pending}
        onClick={() => void checkout()}
      >
        {pending ? "Redirecting…" : label || "Subscribe"}
      </button>
      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  );
}
