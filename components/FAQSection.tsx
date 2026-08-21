import styles from "./FAQSection.module.css";

const FAQS = [
  {
    q: "What does OddsVig actually compare?",
    a: "OddsVig takes a fixture's odds and matches it against a multi-season archive of past games, using the market profile (1X2, HT, O/U, BTTS) at opening or closing price to find historical matches with the same odds shape.",
  },
  {
    q: "What is closing price, and why does it matter here?",
    a: "Closing price is a bookmaker's final odds before kickoff. It reflects all information priced into the market. Filtering the archive by closing price instead of opening price shows you how games with a similar final market actually played out.",
  },
  {
    q: "How is this different from a regular odds comparison site?",
    a: "Odds comparison sites show you the best current price across bookmakers. OddsVig instead looks backward, finding historical matches whose odds moved and closed the same way, so you can see outcomes for that same market shape.",
  },
  {
    q: "Do I need to track my own bets to use this?",
    a: "No. OddsVig works from the fixture bulletin and season archive directly, no bet slip or tracking history required.",
  },
];

export function FAQSection() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQS.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: f.a,
      },
    })),
  };

  return (
    <section className={`shell ${styles.faq}`} id="faq">
      <span className={styles.kicker}>FAQ</span>
      <h2 className={styles.title}>Common questions</h2>
      <dl className={styles.list}>
        {FAQS.map((f) => (
          <div key={f.q} className={styles.item}>
            <dt>{f.q}</dt>
            <dd>{f.a}</dd>
          </div>
        ))}
      </dl>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </section>
  );
}
