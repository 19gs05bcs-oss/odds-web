import Link from "next/link";
import { AnalyzePreview } from "@/components/AnalyzePreview";
import styles from "./Hero.module.css";

const FEATURES = [
  {
    title: "Fixture bulletin",
    text: "Pick a day and bookmaker — browse matches with live odds in one place.",
  },
  {
    title: "Market profile",
    text: "Select MS, HT, O/U or BTTS by opening or closing price. Filters follow the active match.",
  },
  {
    title: "Season archive",
    text: "Instantly surface historical games with the same odds shape across Flashscore seasons.",
  },
];

export function Hero() {
  return (
    <section className={styles.hero}>
      <div className={styles.wash} aria-hidden />
      <div className={`shell ${styles.grid}`}>
        <div className={styles.copy}>
          <p className={`${styles.kicker} fade-up`}>Odds intelligence</p>
          <h1 className={`${styles.title} fade-up`}>
            Find matches that <span className={styles.accent}>move like yours</span>
          </h1>
          <p className={`${styles.lead} fade-up-delay`}>
            OddsVig compares today&apos;s bulletin against a multi-season archive. Choose a
            fixture, pick a market (1X2 · O/C, totals, BTTS), and see every past game that traded
            the same profile.
          </p>
          <div className={`${styles.ctaRow} fade-up-delay`}>
            <Link href="#pricing" className={styles.cta}>
              View pricing
            </Link>
            <Link href="#demo" className={styles.ctaSecondary}>
              Try demo
            </Link>
          </div>
          <ul className={`${styles.features} fade-up-delay`}>
            {FEATURES.map((f) => (
              <li key={f.title}>
                <strong>{f.title}</strong>
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className={`${styles.preview} fade-up-delay`}>
          <AnalyzePreview />
          <p className={styles.previewCaption}>
            Static preview — use the interactive demo below for a hands-on walkthrough (sample data
            only).
          </p>
        </div>
      </div>
    </section>
  );
}
