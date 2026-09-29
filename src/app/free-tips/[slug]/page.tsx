import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { fmtKickoff, getTipBySlug } from "@/lib/freeTips";
import styles from "../page.module.css";

export const revalidate = 600;
const SITE = "https://oddsvig.com";

type Props = { params: { slug: string } };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const t = await getTipBySlug(params.slug);
  if (!t) return { title: "Tip not found", robots: { index: false } };
  const date = t.kickoff_at.slice(0, 10);
  const title = `${t.home_name} vs ${t.away_name} Prediction & Tip — ${date}`;
  const description = `${t.home_name} vs ${t.away_name} (${t.league ?? "football"}): free tip ${t.market} — ${t.pick}${
    t.odds != null ? ` @ ${t.odds.toFixed(2)}` : ""
  }. Odds movement analysis and historical pattern match.`;
  return {
    title,
    description,
    alternates: { canonical: `/free-tips/${t.slug}` },
    openGraph: { type: "article", title, description, url: `${SITE}/free-tips/${t.slug}` },
  };
}

export default async function TipPage({ params }: Props) {
  const t = await getTipBySlug(params.slug);
  if (!t) notFound();

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "SportsEvent",
      name: `${t.home_name} vs ${t.away_name}`,
      startDate: t.kickoff_at,
      sport: "Soccer",
      homeTeam: { "@type": "SportsTeam", name: t.home_name },
      awayTeam: { "@type": "SportsTeam", name: t.away_name },
      url: `${SITE}/free-tips/${t.slug}`,
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE },
        { "@type": "ListItem", position: 2, name: "Free tips", item: `${SITE}/free-tips` },
        {
          "@type": "ListItem",
          position: 3,
          name: `${t.home_name} vs ${t.away_name}`,
          item: `${SITE}/free-tips/${t.slug}`,
        },
      ],
    },
  ];

  const hit =
    t.similar_count && t.similar_hit != null
      ? `${t.similar_hit} of ${t.similar_count} similar archive matches (${Math.round(
          (t.similar_hit / t.similar_count) * 100,
        )}%)`
      : null;

  return (
    <>
      <SiteHeader active="tips" />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <main className={`shell ${styles.page}`}>
        <article className={styles.article}>
          <nav className={styles.crumbs} aria-label="Breadcrumb">
            <Link href="/">Home</Link> / <Link href="/free-tips">Free tips</Link> / {t.home_name} vs{" "}
            {t.away_name}
          </nav>
          <h1 className={styles.title}>
            {t.home_name} vs {t.away_name} — prediction &amp; free tip
          </h1>
          <p className={styles.lead}>
            {t.league ?? "Football"} · {fmtKickoff(t.kickoff_at)}
          </p>

          <div className={styles.box}>
            <dl>
              <dt>Market</dt>
              <dd>{t.market}</dd>
              <dt>Pick</dt>
              <dd>{t.pick}</dd>
              {t.odds != null && (
                <>
                  <dt>Odds</dt>
                  <dd>{t.odds.toFixed(2)}</dd>
                </>
              )}
              {t.confidence != null && (
                <>
                  <dt>Confidence</dt>
                  <dd>{t.confidence} / 5</dd>
                </>
              )}
              {hit && (
                <>
                  <dt>Pattern match</dt>
                  <dd>{hit}</dd>
                </>
              )}
              <dt>Result</dt>
              <dd>
                {t.result === "pending" ? "Pending" : t.result.toUpperCase()}
                {t.home_score != null && t.away_score != null
                  ? ` (${t.home_score}-${t.away_score})`
                  : ""}
              </dd>
            </dl>
          </div>

          <h2 className={styles.h2}>Why this pick</h2>
          {t.analysis.split(/\n{2,}/).map((p, i) => (
            <p key={i}>{p}</p>
          ))}

          <section className={styles.cta}>
            <p>
              More picks on the <Link href="/free-tips">free tips page</Link>. Learn how we read line
              movement in the <Link href="/odds-guide">odds guide</Link>.
            </p>
          </section>
          <p className={styles.disclaimer}>
            18+ only. Informational odds analysis, not financial advice or a guarantee. Gamble
            responsibly.
          </p>
        </article>
      </main>
    </>
  );
}
