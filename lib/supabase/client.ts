/**
 * lib/supabase/client.ts
 * Browser-side Supabase client (anon key only — no secrets).
 * Re-use a single instance across the app to share auth state.
 *
 * During Next.js static export pre-rendering (server/Node context),
 * env vars may not be present. We use a placeholder to allow the
 * build to succeed — real auth only occurs at runtime in the browser.
 */
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/database.types";

let _client: ReturnType<typeof createBrowserClient<Database>> | null = null;

export function getSupabaseClient() {
  if (!_client) {
    // During static pre-rendering, window is undefined and env vars may be absent.
    // Use placeholder values so the build succeeds; the real values are baked in
    // at build time for browser execution via NEXT_PUBLIC_* env vars.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://placeholder.supabase.co";
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "placeholder-key";
    _client = createBrowserClient<Database>(url, key);
  }
  return _client;
}
