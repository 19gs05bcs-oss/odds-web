"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import styles from "./AccountSettings.module.css";

export function AccountSettings() {
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [pending, setPending] = useState(false);

  async function updatePassword(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setMsg("");
    if (password.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    if (password !== password2) {
      setErr("Passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setMsg("Password updated.");
      setPassword("");
      setPassword2("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not update password.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className={styles.card}>
      <h2>Security</h2>
      <p className={styles.lead}>Set or change your password for email sign-in.</p>
      <form className={styles.form} onSubmit={updatePassword}>
        <label className={styles.field}>
          <span>New password</span>
          <input
            type="password"
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>Confirm</span>
          <input
            type="password"
            minLength={8}
            autoComplete="new-password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
          />
        </label>
        {err ? <p className={styles.error}>{err}</p> : null}
        {msg ? <p className={styles.ok}>{msg}</p> : null}
        <button type="submit" className={styles.btn} disabled={pending}>
          {pending ? "Saving…" : "Update password"}
        </button>
      </form>
    </section>
  );
}
