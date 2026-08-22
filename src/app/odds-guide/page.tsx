import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import styles from "./page.module.css";

export const metadata = {
  title: "How Odds Comparison Works — Markets, Line Movement & Value | OddsVig",
  description:
    "A plain-language guide to reading football odds: opening vs. closing prices, line movement, and every market OddsVig tracks — 1X2, Asian Handicap, Over/Under, BTTS, Double Chance, HT/FT and more.",
};

const MARKETS = [
  {
    name: "1X2 (Match Result)",
    body: "The simplest market: will the match end in a Home win, a Draw, or an Away win. Every other market is built as a variation on this core three-way price.",
  },
  {
    name: "Double Chance",
    body: "Covers two of the three 1X2 outcomes in one bet — Home-or-Draw (1X), Draw-or-Away (X2), or Home-or-Away (12). Lower odds than 1X2 in exchange for a wider safety margin.",
  },
  {
    name: "Draw No Bet",
    body: "A two-way Home/Away price where a draw voids the bet and stakes are returned. Effectively 1X2 with the draw risk removed.",
  },
  {
    name: "Asian Handicap",
    body: "A goal handicap (e.g. -1, +0.5, -1.5) is applied to one side to level the match before it starts. Removes the draw as an outcome (or splits it across two half-lines) and is the market where sharp money tends to move fastest.",
  },
  {
    name: "European Handicap",
    body: "Similar idea to Asian Handicap but keeps a three-way Home/Draw/Away result after the handicap is applied, instead of a two-way price.",
  },
  {
    name: "Over/Under",
    body: "A bet on total goals in the match against a line (e.g. Over/Under 2.5). One of the most heavily traded markets, so its line movement is a strong signal for how bookmakers expect the game to open up.",
  },
  {
    name: "Both Teams to Score (BTTS)",
    body: "Yes/No on whether both sides find the net at least once, regardless of the final result.",
  },
  {
    name: "HT/FT (Half Time / Full Time)",
    body: "A combined result for both the half-time and full-time outcome (e.g. Draw/Home). Higher odds than a single 1X2 bet because two results have to land together.",
  },
  {
    name: "Odd/Even",
    body: "A bet on whether the total number of goals in the match will be an odd or even number.",
  },
  {
    name: "Correct Score",
    body: "The exact final scoreline. Long odds by nature, but useful as a sanity check against the implied probabilities from other markets.",
  },
];

const FAQS = [
  {
    q: "What's the difference between opening and closing odds?",
    a: "Opening odds are a bookmaker's first published price for a match, before any money has been staked on it. Closing odds are the price right before kickoff, after the market has absorbed betting volume, team news, and any other information. The gap between the two — the line movement — is one of the clearest public signals of where informed money went.",
  },
  {
    q: "Why do odds move before kickoff?",
    a: "Three main drivers: bookmakers adjusting for one-sided betting volume, new information (injuries, lineups, weather), and bookmakers copying each other's prices to stay competitive. Sharp, early movement on a specific market is usually the first two; a slow drift across every bookmaker close to kickoff is usually the third.",
  },
  {
    q: "Is a shorter closing price always the 'right' side?",
    a: "Not automatically — it means more money (weighted by stake size, not just bet count) went that way, which correlates with informed opinion but isn't proof by itself. Closing line value is a useful input, not a guarantee.",
  },
  {
    q: "What does OddsVig's Smart Analysis actually do?",
    a: "It takes a fixture's current odds profile across multiple markets and bookmakers and searches historical matches for the closest statistical match, weighting each market by how much signal it typically carries. The output is a set of comparable past matches, not a prediction.",
  },
];

export default function OddsGuidePage() {
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQS.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return (
    <>
      <SiteHeader active="guide" />
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <main className={`shell ${styles.page}`}>
        <header className={`${styles.intro} fade-up`}>
          <span className={styles.kicker}>Guide</span>
          <h1 className={styles.title}>How odds comparison works</h1>
          <p className={styles.lead}>
            A plain-language reference for reading football odds — what line movement means, and
            every market OddsVig tracks across bookmakers.
          </p>
        </header>

        <nav className={styles.toc} aria-label="On this page">
          <a href="#movement">Line movement</a>
          <a href="#markets">Markets glossary</a>
          <a href="#faq">FAQ</a>
        </nav>

        <section id="movement" className={styles.section}>
          <h2>Opening odds, closing odds, and why the gap matters</h2>
          <p>
            Every match starts with an <strong>opening price</strong> — a bookmaker&apos;s first
            estimate of the outcome probabilities, before any real money has touched the market.
            From there until kickoff, the price drifts as bets come in, team news lands, and
            bookmakers react to each other. The price right before kickoff is the{" "}
            <strong>closing price</strong>.
          </p>
          <p>
            The distance between the two — how far and how fast a price moved — is one of the few
            genuinely public signals in betting markets. A market that barely moves is one the
            market broadly agreed on from the start. A market that shortens sharply on one side,
            especially early and across several bookmakers at once, usually means informed money
            leaned that way before the public did.
          </p>
          <p>
            This is exactly what OddsVig tracks: opening vs. closing prices across up to 20
            bookmakers and ten-plus markets per match, so the movement itself — not just the final
            number — is visible.
          </p>
        </section>

        <section id="markets" className={styles.section}>
          <h2>Markets glossary</h2>
          <p>
            Every market below is one OddsVig tracks opening-to-closing across bookmakers. If
            you&apos;re new to a term, this is the short version.
          </p>
          <div className={styles.marketGrid}>
            {MARKETS.map((m) => (
              <div key={m.name} className={styles.marketCard}>
                <h3>{m.name}</h3>
                <p>{m.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="faq" className={styles.section}>
          <h2>Frequently asked questions</h2>
          <div className={styles.faqList}>
            {FAQS.map((f) => (
              <details key={f.q} className={styles.faqItem}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className={styles.cta}>
          <h2>See it on a live match</h2>
          <p>
            Open a fixture from today&apos;s bulletin to see the opening/closing gap and the full
            bookmaker board for yourself.
          </p>
          <Link href="/matches" className={styles.ctaButton}>
            Browse today&apos;s matches →
          </Link>
        </section>
      </main>
    </>
  );
}
