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
    loading: () => <p className={styles.loading}>Loading Smart Analysis…</p>,
  },
);

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

const MAX_PAST_DAYS = 3;

/** Europe/Istanbul takvim günü (YYYY-MM-DD). */
function todayIstanbul(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Seçilebilir günler: bugünden en fazla MAX_PAST_DAYS gün geriye + ileri tarihler.
 * Varsayılan her zaman bugün; bugün bültende yoksa en yakın uygun gün.
 * `dates` DESC sıralı gelir.
 */
function resolveDates(dates: string[], requested: string) {
  const today = todayIstanbul();
  const minDate = shiftDate(today, -MAX_PAST_DAYS);
  const allowed = dates.filter((d) => d >= minDate);

  let initial = "";
  if (requested && allowed.includes(requested)) {
    initial = requested;
  } else if (allowed.includes(today)) {
    initial = today;
  } else {
    // bugün yok: bugünden önceki en yakın gün, o da yoksa en yakın ileri gün
    initial =
      allowed.find((d) => d < today) ?? [...allowed].reverse().find((d) => d > today) ?? "";
  }
  return { allowed, initial };
}

export default async function SmartAnalysisPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const [bookmakers, fixtureDates] = await Promise.all([listBookmakers(), listFixtureDates()]);
  const { allowed: allowedDates, initial: defaultDate } = resolveDates(
    fixtureDates,
    first(searchParams.date),
  );

  return (
    <div className={styles.page}>
      <SiteHeader active="smart" />
      <main className={styles.main}>
        <SmartAnalysisClient
          bookmakers={bookmakers}
          fixtureDates={allowedDates}
          initialBulletinDate={defaultDate}
        />
      </main>
    </div>
  );
}
