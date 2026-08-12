import Link from "next/link";
import { LoginForm } from "@/components/LoginForm";
import { SiteHeader } from "@/components/SiteHeader";
import styles from "./page.module.css";

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

export default function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const nextPath = first(searchParams.next) || "/account";
  const modeRaw = first(searchParams.mode);
  const initialMode =
    modeRaw === "signup" || modeRaw === "magic" ? modeRaw : ("signin" as const);
  const error =
    first(searchParams.error) === "auth"
      ? "Sign-in link expired or invalid. Try password sign-in or request a new link."
      : first(searchParams.error) === "config"
        ? "Auth is not configured on the server."
        : "";

  return (
    <>
      <SiteHeader />
      <main className={`shell ${styles.main}`}>
        <p className={styles.kicker}>Sign in</p>
        <h1 className={styles.title}>Member access</h1>
        <p className={styles.lead}>
          Use <strong>email + password</strong> (recommended) or magic link. After login, subscribe
          on{" "}
          <Link href="/#pricing">pricing</Link> — or go to <Link href="/account">account</Link> if
          you already have access.
        </p>
        <LoginForm nextPath={nextPath} error={error} initialMode={initialMode} />
      </main>
    </>
  );
}
