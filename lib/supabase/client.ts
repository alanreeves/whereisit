/**
 * lib/supabase/client.ts
 * Browser-side Supabase client (anon key only — no secrets).
 * Re-use a single instance across the app to share auth state.
 */
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/database.types";

let _client: ReturnType<typeof createBrowserClient<Database>> | null = null;

export function getSupabaseClient() {
  if (!_client) {
    _client = createBrowserClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }
  return _client;
}
