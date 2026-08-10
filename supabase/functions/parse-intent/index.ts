/**
 * supabase/functions/parse-intent/index.ts
 * Supabase Edge Function — OpenAI Intent Parsing + DB Action
 *
 * Flow:
 *   1. Verify caller JWT → extract user_id
 *   2. Read openai_api_key from app_settings (service role)
 *   3. Read user preferred model from user_settings (default: gpt-5.6-luna)
 *   4. Call GPT model → parse JSON action
 *   5. If STORE / MOVE: generate text-embedding-3-small vector
 *   6. Execute DB operation (items table) with user_id filter
 *   7. For SEARCH: call hybrid_search Postgres function
 *   8. Return { action, message, items?, item? }
 *
 * Deploy:
 *   supabase functions deploy parse-intent
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_URL        = "https://api.openai.com/v1";
const DEFAULT_MODEL         = "gpt-5.6-luna";
const EMBEDDING_MODEL       = "text-embedding-3-small";

// ─── Types ────────────────────────────────────────────────────────────────────
type ActionType = "STORE" | "SEARCH" | "MOVE" | "REMOVE" | "PROVIDE_CATEGORY" | "UNKNOWN";

interface ParsedAction {
  type:         ActionType;
  item_name?:   string;
  category?:    string | null;
  subcategory?: string | null;
  location?:    string | null;
  new_location?: string | null;
  notes?:       string | null;
  confidence:   number;
}

interface RequestBody {
  transcript:    string;
  pendingState?: {
    type:       "PENDING_CATEGORY";
    item_name:  string;
    location:   string;
  } | null;
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(): string {
  return `You are the intent parser for "Where Is It?", a voice-first household inventory tracker.
Parse the user's speech transcript and return ONLY valid JSON (no markdown, no explanation).

Actions:
- STORE:            User is putting/storing an item somewhere.
- SEARCH:           User is looking for an item.
- MOVE:             User is moving an item to a new location.
- REMOVE:           User wants to delete/remove an item record.
- PROVIDE_CATEGORY: User is answering a follow-up question about category/subcategory.
- UNKNOWN:          Cannot determine intent.

JSON schema to return:
{
  "type": "STORE" | "SEARCH" | "MOVE" | "REMOVE" | "PROVIDE_CATEGORY" | "UNKNOWN",
  "item_name":    string | null,   // e.g. "passport", "spare car key"
  "category":     string | null,   // e.g. "Documents", "Tools"
  "subcategory":  string | null,   // e.g. "Personal", "Hand Tools"
  "location":     string | null,   // current/source location, e.g. "Office > Desk > Top Drawer"
  "new_location": string | null,   // MOVE target location only
  "notes":        string | null,   // any extra details
  "confidence":   number           // 0.0–1.0
}

Rules:
- item_name: always lowercase, singular, trimmed.
- location: infer hierarchical path using " > " separator if implied.
- If category or subcategory are not mentioned, return null.
- For SEARCH, location is where the user thinks it might be (if mentioned), else null.
- For REMOVE, location/category can be null.
- Always return valid JSON. Never add backticks or prose.`;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const ts_start = Date.now();
  console.log(`[parse-intent] ${req.method} request`);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return jsonError("Unauthorized", 401);

  const userJwt   = authHeader.replace("Bearer ", "");
  const userClient = createClient(SUPABASE_URL, userJwt, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return jsonError("Unauthorized", 401);

  const userId = user.id;
  console.log(`[parse-intent] User: ${userId}`);

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }
  const { transcript, pendingState } = body;
  if (!transcript?.trim()) return jsonError("transcript is required", 400);

  // ── Read settings (service role) ───────────────────────────────────────────
  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

  const [settingsRes, userSettingsRes] = await Promise.all([
    svc.from("app_settings").select("openai_api_key").eq("id", 1).single(),
    svc.from("user_settings").select("openai_model").eq("user_id", userId).single(),
  ]);

  if (settingsRes.error || !settingsRes.data?.openai_api_key) {
    console.error("[parse-intent] OpenAI key missing:", settingsRes.error?.message);
    return jsonError("Server configuration error — OpenAI key not set", 500);
  }

  const openaiKey = settingsRes.data.openai_api_key;
  const model     = userSettingsRes.data?.openai_model ?? DEFAULT_MODEL;
  console.log(`[parse-intent] Model: ${model}`);

  // ── Build GPT messages ─────────────────────────────────────────────────────
  const messages: { role: string; content: string }[] = [
    { role: "system", content: buildSystemPrompt() },
  ];

  if (pendingState?.type === "PENDING_CATEGORY") {
    messages.push({
      role:    "system",
      content: `Context: The user was previously asked to provide category and subcategory for item "${pendingState.item_name}" stored at "${pendingState.location}". Treat this transcript as a PROVIDE_CATEGORY response with item_name="${pendingState.item_name}" and location="${pendingState.location}".`,
    });
  }

  messages.push({ role: "user", content: transcript });

  // ── Call OpenAI Chat Completion ────────────────────────────────────────────
  let parsed: ParsedAction;
  try {
    const chatRes = await fetch(`${OPENAI_API_URL}/chat/completions`, {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature:     0,
        max_tokens:      256,
        response_format: { type: "json_object" },
      }),
    });

    if (!chatRes.ok) {
      const errText = await chatRes.text();
      console.error(`[parse-intent] OpenAI error ${chatRes.status}:`, errText);
      return jsonError(`OpenAI API error: ${chatRes.status}`, 502);
    }

    const chatJson = await chatRes.json();
    const raw      = chatJson.choices?.[0]?.message?.content ?? "{}";
    console.log(`[parse-intent] GPT raw: ${raw.slice(0, 200)}`);
    parsed = JSON.parse(raw) as ParsedAction;
  } catch (err) {
    console.error("[parse-intent] GPT call failed:", err);
    return jsonError("Failed to parse intent", 502);
  }

  console.log(`[parse-intent] Action: ${parsed.type}, item: ${parsed.item_name}, confidence: ${parsed.confidence}`);

  // ── Generate embedding (STORE, MOVE, SEARCH) ──────────────────────────────
  let embedding: number[] | null = null;
  if (["STORE", "MOVE", "SEARCH", "PROVIDE_CATEGORY"].includes(parsed.type) && parsed.item_name) {
    try {
      const embRes = await fetch(`${OPENAI_API_URL}/embeddings`, {
        method:  "POST",
        headers: {
          Authorization:  `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: parsed.item_name }),
      });
      const embJson = await embRes.json();
      embedding = embJson.data?.[0]?.embedding ?? null;
      console.log(`[parse-intent] Embedding generated (${embedding?.length} dims)`);
    } catch (err) {
      console.warn("[parse-intent] Embedding failed (non-fatal):", err);
    }
  }

  // ── Execute DB action ──────────────────────────────────────────────────────
  let responseMessage = "";
  let responseItems:  unknown[] = [];
  let responseItem:   unknown   = null;
  let needsCategory              = false;

  switch (parsed.type) {
    // ── STORE ──────────────────────────────────────────────────────────────
    case "STORE":
    case "PROVIDE_CATEGORY": {
      if (!parsed.item_name || !parsed.location) {
        responseMessage = "I couldn't catch the item name or location. Could you try again?";
        break;
      }
      if (!parsed.category) {
        needsCategory   = true;
        responseMessage = `I've noted the location. What category and subcategory should I save "${parsed.item_name}" under?`;
        break;
      }
      const { data: stored, error: storeErr } = await svc.from("items").insert({
        user_id:     userId,
        name:        parsed.item_name,
        category:    parsed.category  ?? null,
        subcategory: parsed.subcategory ?? null,
        location:    parsed.location,
        notes:       parsed.notes     ?? null,
        embedding:   embedding ? (`[${embedding.join(",")}]` as unknown) : null,
      }).select().single();

      if (storeErr) {
        console.error("[parse-intent] Insert failed:", storeErr.message);
        responseMessage = `Sorry, I couldn't save "${parsed.item_name}". Please try again.`;
      } else {
        responseItem    = stored;
        responseMessage = `Got it! I've saved "${parsed.item_name}" in ${parsed.location}` +
          (parsed.category ? ` under ${parsed.category} › ${parsed.subcategory ?? "General"}` : "") + ".";
      }
      break;
    }

    // ── SEARCH ─────────────────────────────────────────────────────────────
    case "SEARCH": {
      if (!parsed.item_name) {
        responseMessage = "I couldn't work out what you're looking for. Please try again.";
        break;
      }
      const embVec = embedding
        ? `[${embedding.join(",")}]`
        : null;

      if (embVec) {
        const { data: results, error: searchErr } = await svc.rpc("hybrid_search", {
          p_user_id:     userId,
          p_query_text:  parsed.item_name,
          p_embedding:   embVec,
          p_category:    parsed.category    ?? null,
          p_subcategory: parsed.subcategory ?? null,
          p_limit:       5,
        });

        if (searchErr) {
          console.error("[parse-intent] Search error:", searchErr.message);
          responseMessage = "I ran into a problem searching. Please try again.";
        } else if (!results || results.length === 0) {
          responseMessage = `I couldn't find "${parsed.item_name}" in your inventory.`;
        } else {
          responseItems   = results;
          const top       = results[0];
          responseMessage = `I found "${top.name}" in ${top.location}` +
            (top.category ? ` (${top.category} › ${top.subcategory ?? "General"})` : "") + ".";
          if (results.length > 1) {
            responseMessage += ` There ${results.length === 2 ? "is" : "are"} ${results.length - 1} other possible match${results.length === 2 ? "" : "es"}.`;
          }
        }
      } else {
        // Fallback: plain ilike search when no embedding available
        const { data: fallback } = await svc.from("items")
          .select()
          .eq("user_id", userId)
          .ilike("name", `%${parsed.item_name}%`)
          .limit(5);

        if (!fallback?.length) {
          responseMessage = `I couldn't find "${parsed.item_name}" in your inventory.`;
        } else {
          responseItems   = fallback;
          responseMessage = `I found "${fallback[0].name}" in ${fallback[0].location}.`;
        }
      }
      break;
    }

    // ── MOVE ───────────────────────────────────────────────────────────────
    case "MOVE": {
      if (!parsed.item_name || !parsed.new_location) {
        responseMessage = "I need the item name and new location to move it.";
        break;
      }
      const { data: moved, error: moveErr } = await svc.from("items")
        .update({
          location:    parsed.new_location,
          embedding:   embedding ? (`[${embedding.join(",")}]` as unknown) : undefined,
          updated_at:  new Date().toISOString(),
        })
        .eq("user_id", userId)
        .ilike("name", parsed.item_name)
        .select()
        .single();

      if (moveErr || !moved) {
        responseMessage = `I couldn't find "${parsed.item_name}" to move it.`;
      } else {
        responseItem    = moved;
        responseMessage = `Done! I've moved "${moved.name}" to ${parsed.new_location}.`;
      }
      break;
    }

    // ── REMOVE ─────────────────────────────────────────────────────────────
    case "REMOVE": {
      if (!parsed.item_name) {
        responseMessage = "Which item would you like to remove?";
        break;
      }
      const { data: removed, error: removeErr } = await svc.from("items")
        .delete()
        .eq("user_id", userId)
        .ilike("name", parsed.item_name)
        .select()
        .single();

      if (removeErr || !removed) {
        responseMessage = `I couldn't find "${parsed.item_name}" to remove it.`;
      } else {
        responseItem    = removed;
        responseMessage = `Removed! "${removed.name}" has been deleted from your inventory.`;
      }
      break;
    }

    default:
      responseMessage = "I didn't quite understand that. Try saying something like: \"I put my passport in the top drawer\" or \"Where is my passport?\"";
  }

  const elapsed = Date.now() - ts_start;
  console.log(`[parse-intent] Done in ${elapsed}ms. Message: "${responseMessage.slice(0, 80)}"`);

  return jsonSuccess({
    action:        parsed.type,
    message:       responseMessage,
    items:         responseItems.length ? responseItems : undefined,
    item:          responseItem ?? undefined,
    needsCategory,
    pendingState:  needsCategory
      ? { type: "PENDING_CATEGORY", item_name: parsed.item_name, location: parsed.location }
      : null,
    model,
    elapsed_ms:    elapsed,
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function jsonSuccess(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey, x-client-info",
  };
}
