import nextDynamic from "next/dynamic";
import { SiteHeader } from "@/components/SiteHeader";
import { decodeCriterion } from "@/lib/analysis/profile";
import { listBookmakers } from "@/lib/fixtures";
import { listFixtureDates } from "@/lib/archiveCache";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Odds Profile Search — Historical Pattern Matching",
  description:
    "Pick a fixture and bookmaker, filter by market at opening or closing price, and find every past game across the archive that traded the same odds profile.",
};

const AnalyzeClient = nextDynamic(() => import("@/components/AnalyzeClient"), {
  ssr: false,
  loading: () => <p className={styles.loading}>Loading analyze…</p>,
});

/** Next 14: searchParams is a plain object (not a Promise). */
type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

function all(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (v) return [v];
  return [];
}

export default async function AnalyzePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = searchParams;
  // Fixture odds SSR'da çekilmez (JSONB timeout) — client yükler.
  const [bookmakers, fixtureDates] = await Promise.all([
    listBookmakers(),
    listFixtureDates(),
  ]);
  const defaultDate = first(sp.date) || fixtureDates[0] || "";

  const initialCriteria = all(sp.c)
    .map((p) => decodeCriterion(p))
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  return (
    <div className={styles.page}>
      <SiteHeader active="analyze" />
      <main className={styles.main}>
        <header className={styles.hero}>
          <p className={styles.kicker}>Analyze</p>
          <h1>Odds profile search</h1>
          <p>
            Select a fixture and bookmaker, pick markets by opening or closing price, then
            explore matching archive rows across all seasons.
          </p>
        </header>

        <AnalyzeClient
          bookmakers={bookmakers}
          fixtures={[]}
          fixtureDates={fixtureDates}
          initialBulletinDate={defaultDate}
          initialCriteria={initialCriteria}
          initialBookmakerId={first(sp.bm) || "16"}
          initialTolerance={first(sp.tol) || "0"}
          autoRun={Boolean(initialCriteria.length)}
        />
      </main>
    </div>
  );
}
