import Link from "next/link";
import { SubscribeButton } from "@/components/SubscribeButton";
import styles from "./PricingSection.module.css";

const PLANS = [
  {
    id: "starter" as const,
    name: "Starter",
    price: 9,
    period: "7 days",
    desc: "Solo use — get started with daily profile checks.",
    features: [
      "Live fixture bulletin",
      "Up to 3 combined criteria / search",
      "20 searches / day",
      "MS, HT, O/U, BTTS filters",
    ],
  },
  {
    id: "pro" as const,
    name: "Pro",
    price: 19,
    period: "14 days",
    desc: "Regular use — most popular for individual analysts.",
    featured: true,
    features: [
      "Everything in Starter",
      "Smart Analysis page",
      "Bookmaker & tolerance guide",
      "Up to 8 combined criteria / search",
      "100 searches / day",
    ],
  },
  {
    id: "analyst" as const,
    name: "Analyst",
    price: 39,
    period: "month",
    yearly: 390,
    desc: "Heavy daily use and deeper archive limits.",
    features: [
      "Everything in Pro",
      "Up to 15 combined criteria / search",
      "500 searches / day",
    ],
  },
];

export function PricingSection() {
  return (
    <section id="pricing" className={styles.section}>
      <div className="shell">
        <header className={styles.head}>
          <span className={styles.kicker}>Pricing</span>
          <h2 className={styles.title}>Paid access only</h2>
          <p className={styles.lead}>
            No free tier. No trial. Subscribe via Dodo Payments to unlock live fixtures and
            the full archive. Try the{" "}
            <Link href="#demo" className={styles.inlineLink}>
              interactive demo
            </Link>{" "}
            first — sample data only.
          </p>
        </header>

        <div className={styles.grid}>
          {PLANS.map((plan) => (
            <article
              key={plan.id}
              className={`${styles.card} ${plan.featured ? styles.featured : ""}`}
            >
              {plan.featured ? <span className={styles.ribbon}>Popular</span> : null}
              <h3 className={styles.planName}>{plan.name}</h3>
              <p className={styles.planDesc}>{plan.desc}</p>
              <div className={styles.priceRow}>
                <span className={styles.price}>
                  <span className={styles.currency}>$</span>
                  {plan.price}
                </span>
                <span className={styles.per}>/ {plan.period}</span>
              </div>
              {plan.yearly ? (
                <p className={styles.yearly}>or ${plan.yearly} / year</p>
              ) : (
                <p className={styles.yearly}>renews every {plan.period}</p>
              )}
              <ul className={styles.features}>
                {plan.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <SubscribeButton plan={plan.id} featured={plan.featured} />
            </article>
          ))}
        </div>

        <div className={styles.team}>
          <div>
            <h3 className={styles.teamTitle}>Team</h3>
            <p className={styles.teamDesc}>
              Custom limits, invoicing, and API access from $79 / month. Contact for a quote.
            </p>
          </div>
          <a href="mailto:hello@oddsvig.com" className={styles.teamLink}>
            Contact sales
          </a>
        </div>

        <ul className={styles.notes}>
                    <li>Secure checkout powered by Dodo Payments · cancel anytime</li>
          <li>Archive served only through secured API — not via browser console or direct DB</li>
          <li>Prices in USD</li>
        </ul>
      </div>
    </section>
  );
}
