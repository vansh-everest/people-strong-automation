import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Secrets } from "./config.js";

export function createSupabase(secrets: Secrets): SupabaseClient {
  return createClient(secrets.SUPABASE_URL, secrets.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type { SupabaseClient };
