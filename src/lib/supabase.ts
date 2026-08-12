import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/** Bound once — never call `fetch` by name inside the wrapper (Next patches it → stack overflow). */
const nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

export function hasSupabaseEnv(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim(),
  );
}

export function getSupabase(): SupabaseClient | null {
  if (!hasSupabaseEnv()) return null;
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.trim(),
      {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: (input, init) =>
            nativeFetch(input, {
              ...init,
              cache: "no-store",
            }),
        },
      },
    );
  }
  return client;
}
