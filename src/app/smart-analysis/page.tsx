import nextDynamic from "next/dynamic";
import { SiteHeader } from "@/components/SiteHeader";
import { listBookmakers } from "@/lib/fixtures";
import { listFixtureDates } from "@/lib/archiveCache";
import styles from "./page.module.css";

export const metadata = {
  title: "Smart Analysis",
  description: "Fixture-driven smart analysis from season json.gz archive.",
};

export const dynamic = "force-dynamic";

const SmartAnalysisClient = nextDynamic(
  () => import("@/components/SmartAnalysisClient").then((m) => m.SmartAnalysisClient),
  {
    ssr: false,
    loading: () => <p className={styles.loading}>Smart Analysis yükleniyor…</p>,
  },
);

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

export default async function SmartAnalysisPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const [bookmakers, fixtureDates] = await Promise.all([listBookmakers(), listFixtureDates()]);
  const defaultDate = first(searchParams.date) || fixtureDates[0] || "";

  return (
    <div className={styles.page}>
      <SiteHeader active="smart" />
      <main className={styles.main}>
        <SmartAnalysisClient
          bookmakers={bookmakers}
          fixtureDates={fixtureDates}
          initialBulletinDate={defaultDate}
        />
      </main>
    </div>
  );
}
