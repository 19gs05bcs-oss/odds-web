"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import styles from "./LoginForm.module.css";

type Props = {
  nextPath: string;
  error?: string;
  initialMode?: "signin" | "signup" | "magic";
};

type Mode = "signin" | "signup" | "magic";

function appOrigin(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || "http://127.0.0.1:3001";
}

export function LoginForm({ nextPath, error: initialError, initialMode = "signin" }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(initialError || "");
  const [info, setInfo] = useState("");
  const [pending, setPending] = useState(false);

  function callbackUrl() {
    return `${appOrigin()}/auth/callback?next=${encodeURIComponent(nextPath)}`;
  }

  async function onSignIn(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError("");
    setInfo("");
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: err } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (err) throw err;
      window.location.href = nextPath.startsWith("/") ? nextPath : "/account";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setPending(false);
    }
  }

  async function onSignUp(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError("");
    setInfo("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      setPending(false);
      return;
    }
    if (password !== password2) {
      setError("Passwords do not match.");
      setPending(false);
      return;
    }
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error: err } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: callbackUrl() },
      });
      if (err) throw err;
      if (data.session) {
        window.location.href = nextPath.startsWith("/") ? nextPath : "/account";
        return;
      }
      setInfo("Account created — check your email to confirm, then sign in.");
      setMode("signin");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed.");
    } finally {
      setPending(false);
    }
  }

  async function onMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError("");
    setInfo("");
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: err } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: callbackUrl() },
      });
      if (err) throw err;
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send magic link.");
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return (
      <div className={styles.notice}>
        <strong>Check your email</strong>
        <p>
          We sent a sign-in link to <strong>{email}</strong>. Open it in the same browser on
          this device.
        </p>
        <button type="button" className={styles.linkBtn} onClick={() => setSent(false)}>
          ← Back
        </button>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          className={mode === "signin" ? styles.tabActive : styles.tab}
          onClick={() => {
            setMode("signin");
            setError("");
            setInfo("");
          }}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          className={mode === "signup" ? styles.tabActive : styles.tab}
          onClick={() => {
            setMode("signup");
            setError("");
            setInfo("");
          }}
        >
          Create account
        </button>
        <button
          type="button"
          role="tab"
          className={mode === "magic" ? styles.tabActive : styles.tab}
          onClick={() => {
            setMode("magic");
            setError("");
            setInfo("");
          }}
        >
          Magic link
        </button>
      </div>

      {mode === "signin" ? (
        <form className={styles.form} onSubmit={onSignIn}>
          <label className={styles.field}>
            <span>Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <label className={styles.field}>
            <span>Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </label>
          {error ? <p className={styles.error}>{error}</p> : null}
          {info ? <p className={styles.info}>{info}</p> : null}
          <button type="submit" className={styles.btn} disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      ) : null}

      {mode === "signup" ? (
        <form className={styles.form} onSubmit={onSignUp}>
          <label className={styles.field}>
            <span>Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <label className={styles.field}>
            <span>Password</span>
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
          </label>
          <label className={styles.field}>
            <span>Confirm password</span>
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              placeholder="Repeat password"
            />
          </label>
          {error ? <p className={styles.error}>{error}</p> : null}
          {info ? <p className={styles.info}>{info}</p> : null}
          <button type="submit" className={styles.btn} disabled={pending}>
            {pending ? "Creating…" : "Create account"}
          </button>
        </form>
      ) : null}

      {mode === "magic" ? (
        <form className={styles.form} onSubmit={onMagicLink}>
          <label className={styles.field}>
            <span>Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          {error ? <p className={styles.error}>{error}</p> : null}
          <button type="submit" className={styles.btn} disabled={pending}>
            {pending ? "Sending…" : "Send magic link"}
          </button>
          <p className={styles.hint}>Passwordless — one-time link to your inbox.</p>
        </form>
      ) : null}
    </div>
  );
}
