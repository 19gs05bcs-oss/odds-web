"use client";

import { HardLink } from "@/components/HardLink";
import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import styles from "./SiteHeader.module.css";

type Props = {
  active?: "home" | "matches" | "analyze" | "seasons" | "smart";
};

export function SiteHeader({ active }: Props) {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setEmail(session?.user?.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <header className={styles.header}>
      <div className={`shell ${styles.inner}`}>
        <HardLink href="/" className={styles.brand} aria-label="OddsVig home">
          <img src="/oddsvig.png" alt="" className={styles.brandLogo} />
          <span>Odds</span>
          <span className={styles.brandMark}>Vig</span>
        </HardLink>
        <nav className={styles.nav} aria-label="Main">
          <HardLink href="/#demo" className={styles.link}>
            Demo
          </HardLink>
          <HardLink href="/#pricing" className={styles.link}>
            Pricing
          </HardLink>
          <HardLink
            href="/smart-analysis"
            className={active === "smart" ? styles.linkActive : styles.link}
          >
            Smart Analysis
          </HardLink>
          <HardLink
            href="/analyze"
            className={active === "analyze" ? styles.linkActive : styles.link}
          >
            Analyze
          </HardLink>
          <HardLink
            href="/seasons"
            className={active === "seasons" ? styles.linkActive : styles.link}
          >
            Seasons
          </HardLink>
          <HardLink
            href="/matches"
            className={active === "matches" ? styles.linkActive : styles.link}
          >
            Matches
          </HardLink>
          {email ? (
            <HardLink href="/account" className={styles.ctaSecondary}>
              Account
            </HardLink>
          ) : (
            <HardLink href="/login" className={styles.ctaSecondary}>
              Sign in
            </HardLink>
          )}
          <HardLink href="/#pricing" className={styles.cta}>
            Subscribe
          </HardLink>
        </nav>
      </div>
    </header>
  );
}
