/**
 * supabase/functions/transcribe/index.ts
 * Supabase Edge Function — Deepgram Speech-to-Text
 *
 * Accepts a multipart/form-data POST with an `audio` file field.
 * Reads the Deepgram API key from the app_settings table (service role).
 * Returns: { transcript: string }
 *
 * Invoked from the client via:
 *   supabase.functions.invoke("transcribe", { body: formData })
 *
 * Deploy:
 *   supabase functions deploy transcribe --no-verify-jwt
 *   (JWT is verified manually below to support streaming audio)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL            = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEEPGRAM_API_URL        = "https://api.deepgram.com/v1/listen";

// Model: Nova-3 — Deepgram's most accurate general-purpose model.
const DEEPGRAM_PARAMS = new URLSearchParams({
  model:       "nova-3",
  punctuate:   "true",
  smart_format:"true",
  language:    "en-GB",
});

Deno.serve(async (req: Request) => {
  const ts_start = Date.now();
  console.log(`[transcribe] ${req.method} request received`);

  // ── CORS pre-flight ────────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey, x-client-info",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonError("Method not allowed", 405);
  }

  // ── Verify caller JWT ──────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonError("Missing or invalid Authorization header", 401);
  }

  const userClient = createClient(SUPABASE_URL, authHeader.replace("Bearer ", ""), {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    console.error("[transcribe] Auth failed:", authError?.message);
    return jsonError("Unauthorized", 401);
  }
  console.log(`[transcribe] Authenticated user: ${user.id}`);

  // ── Read Deepgram key from app_settings (service role) ───────────────────
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
  const { data: settings, error: settingsError } = await serviceClient
    .from("app_settings")
    .select("deepgram_api_key")
    .eq("id", 1)
    .single();

  if (settingsError || !settings?.deepgram_api_key) {
    console.error("[transcribe] Failed to read Deepgram key:", settingsError?.message);
    return jsonError("Server configuration error — Deepgram key not set", 500);
  }

  const deepgramKey = settings.deepgram_api_key;

  // ── Extract audio from form data ──────────────────────────────────────────
  let audioBlob: Blob;
  let contentType: string;

  try {
    const formData = await req.formData();
    const audioField = formData.get("audio");
    if (!audioField || !(audioField instanceof File)) {
      return jsonError("Missing `audio` field in form data", 400);
    }
    audioBlob   = audioField;
    contentType = audioField.type || "audio/webm";
    console.log(`[transcribe] Audio received: ${audioBlob.size} bytes, type: ${contentType}`);
  } catch (err) {
    console.error("[transcribe] Failed to parse form data:", err);
    return jsonError("Invalid form data", 400);
  }

  // ── Call Deepgram REST API ────────────────────────────────────────────────
  const deepgramUrl = `${DEEPGRAM_API_URL}?${DEEPGRAM_PARAMS.toString()}`;
  let transcript: string;

  try {
    const dgResponse = await fetch(deepgramUrl, {
      method:  "POST",
      headers: {
        Authorization:  `Token ${deepgramKey}`,
        "Content-Type": contentType,
      },
      body: audioBlob,
    });

    if (!dgResponse.ok) {
      const errText = await dgResponse.text();
      console.error(`[transcribe] Deepgram error ${dgResponse.status}:`, errText);
      return jsonError(`Deepgram API error: ${dgResponse.status}`, 502);
    }

    const dgJson = await dgResponse.json();
    transcript = dgJson?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";

    if (!transcript) {
      console.warn("[transcribe] Deepgram returned empty transcript");
      return jsonSuccess({ transcript: "" });
    }

    console.log(`[transcribe] Transcript (${Date.now() - ts_start}ms): "${transcript.slice(0, 80)}..."`);
  } catch (err) {
    console.error("[transcribe] Network error calling Deepgram:", err);
    return jsonError("Failed to reach Deepgram", 502);
  }

  return jsonSuccess({ transcript });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function jsonSuccess(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status:  200,
    headers: corsHeaders("application/json"),
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: corsHeaders("application/json"),
  });
}

function corsHeaders(contentType: string): HeadersInit {
  return {
    "Content-Type":                 contentType,
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey, x-client-info",
  };
}
