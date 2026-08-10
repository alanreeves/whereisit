/**
 * supabase/functions/parse-intent/index.ts
 * Supabase Edge Function — OpenAI Intent Parsing + DB Action
 *
 * Flow:
 *   1. Verify caller JWT → extract user_id
 *   2. Read openai_api_key from app_settings (service role)
 *   3. Read user preferred model & cost rates from user_settings / user_model_rates
 *   4. Call GPT model → parse JSON action
 *   5. If STORE / MOVE: generate text-embedding-3-small vector
 *   6. Execute DB operation (items table) with user_id filter
 *   7. For SEARCH: call hybrid_search Postgres function
 *   8. Calculate request cost → log to api_usage_logs
 *   9. Return { action, message, items?, item?, estimated_cost }
 *
 * Deploy:
 *   supabase functions deploy parse-intent
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_URL        = "https://api.openai.com/v1";
const DEFAULT_MODEL         = "gpt-5.4-nano";
const EMBEDDING_MODEL       = "text-embedding-3-small";

// ─── Types ────────────────────────────────────────────────────────────────────
type ActionType = "STORE" | "SEARCH" | "MOVE" | "REMOVE" | "PROVIDE_CATEGORY" | "LIST_CATEGORIES" | "UNKNOWN";

// Default per-model rates (USD per 1,000 tokens) — prices from OpenAI pricing page.
// Per-1M prices divided by 1,000. Default model: gpt-5.4-nano.
const DEFAULT_RATES: Record<string, { prompt: number; completion: number }> = {
  "gpt-5.6-sol":             { prompt: 0.005,    completion: 0.030   },
  "gpt-5.6-terra":           { prompt: 0.002,    completion: 0.012   },
  "gpt-5.6-luna":            { prompt: 0.0002,   completion: 0.0012  },
  "gpt-5.5":                 { prompt: 0.005,    completion: 0.030   },
  "gpt-5.5-pro":             { prompt: 0.030,    completion: 0.180   },
  "gpt-5.4":                 { prompt: 0.0025,   completion: 0.015   },
  "gpt-5.4-mini":            { prompt: 0.00075,  completion: 0.0045  },
  "gpt-5.4-nano":            { prompt: 0.0002,   completion: 0.00125 },
  "gpt-5.4-pro":             { prompt: 0.030,    completion: 0.180   },
  "text-embedding-3-small":  { prompt: 0.00002,  completion: 0       },
};

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
  customPrompt?:   string | null;
  minMatchScore?:  number | null;  // 0.0–1.0, results below this are excluded
}

// ─── Default system prompt ────────────────────────────────────────────────────
// This is the built-in prompt. Users can override it via Settings.
export const DEFAULT_SYSTEM_PROMPT = `You are the intent parser for "Where Is It?", a voice-first household inventory app.
Your job is to read a natural, conversational phrase spoken by a user and extract structured information.
Return ONLY a single valid JSON object — no markdown, no explanation, no backticks.

ACTIONS you must classify:
  STORE           — user is recording that they put/placed/stored/left/put away an item somewhere
  SEARCH          — user is looking for, asking about, or wanting to find an item or list items
  MOVE            — user is recording that an item has moved from one place to another
  REMOVE          — user wants to delete an item record (thrown away, lost, sold, etc.)
  PROVIDE_CATEGORY — user is answering a follow-up question about what category/subcategory an item belongs to
  LIST_CATEGORIES — user wants to see or list all available categories and subcategories in their inventory
  UNKNOWN         — the phrase does not match any of the above

OUTPUT JSON SCHEMA (always include every key):
{
  "type": "STORE" | "SEARCH" | "MOVE" | "REMOVE" | "PROVIDE_CATEGORY" | "LIST_CATEGORIES" | "UNKNOWN",
  "item_name":    string | null,   // the object being tracked, lowercase singular e.g. "passport", "spare key"
  "category":     string | null,   // broad group e.g. "Documents", "Tools", "Clothing", null if not mentioned
  "subcategory":  string | null,   // narrower group e.g. "Personal", "Power Tools", null if not mentioned
  "location":     string | null,   // where the item is/was — use " > " to show hierarchy e.g. "Kitchen > Drawer > Left"
  "new_location": string | null,   // MOVE only: the destination location
  "notes":        string | null,   // any extra detail the user mentioned
  "confidence":   number           // 0.0–1.0 how confident you are in the interpretation
}

CRITICAL RULES:
1. You MUST interpret natural, conversational language. Users will NOT say "store item passport at location desk".
   They will say things like "my passport is in the desk" or "I just put my keys on the hall table".
2. Common store phrases: put, placed, stored, left, stuck, popped, shoved, kept, filed, put away, dropped off.
3. Common search phrases: where is, find, where did I put, have you seen, where are my, looking for, can't find.
4. Common move phrases: moved, taken, shifted, relocated, transferred, brought, carried.
5. Common remove phrases: threw away, binned, sold, lost, donated, chucked out, got rid of, deleted.
6. item_name: always lowercase, singular noun, strip articles ("the", "my", "a").
7. location: infer a sensible hierarchy when possible. "in the desk" → "Desk". "kitchen top drawer" → "Kitchen > Drawer > Top".
8. If category/subcategory are not mentioned, return null — do NOT guess them.
9. For "find all items" or "list all items", set type="SEARCH", item_name="all", and extract category/subcategory if specified. E.g. "find all items in category household" → type="SEARCH", item_name="all", category="household".
10. For "list all categories", "show categories", "what categories do I have", set type="LIST_CATEGORIES".
11. NEVER return anything outside the JSON object.

FEW-SHOT EXAMPLES (learn from these):

User: "I put my passport in the desk"
→ {"type":"STORE","item_name":"passport","category":null,"subcategory":null,"location":"Desk","new_location":null,"notes":null,"confidence":0.98}

User: "My keys are on the hall table"
→ {"type":"STORE","item_name":"keys","category":null,"subcategory":null,"location":"Hall > Table","new_location":null,"notes":null,"confidence":0.95}

User: "Just left the car manual in the glove box"
→ {"type":"STORE","item_name":"car manual","category":null,"subcategory":null,"location":"Car > Glove Box","new_location":null,"notes":null,"confidence":0.97}

User: "Spare house key is inside the ceramic pot by the front door"
→ {"type":"STORE","item_name":"spare house key","category":null,"subcategory":null,"location":"Front Door > Ceramic Pot","new_location":null,"notes":null,"confidence":0.96}

User: "I filed the insurance documents in the grey folder in the office"
→ {"type":"STORE","item_name":"insurance documents","category":"Documents","subcategory":null,"location":"Office > Grey Folder","new_location":null,"notes":null,"confidence":0.97}

User: "Where is my passport?"
→ {"type":"SEARCH","item_name":"passport","category":null,"subcategory":null,"location":null,"new_location":null,"notes":null,"confidence":0.99}

User: "Find all items"
→ {"type":"SEARCH","item_name":"all","category":null,"subcategory":null,"location":null,"new_location":null,"notes":null,"confidence":0.99}

User: "Find all items in category Documents"
→ {"type":"SEARCH","item_name":"all","category":"Documents","subcategory":null,"location":null,"new_location":null,"notes":null,"confidence":0.99}

User: "Find all items in category Documents subcategory Personal"
→ {"type":"SEARCH","item_name":"all","category":"Documents","subcategory":"Personal","location":null,"new_location":null,"notes":null,"confidence":0.99}

User: "List all categories"
→ {"type":"LIST_CATEGORIES","item_name":null,"category":null,"subcategory":null,"location":null,"new_location":null,"notes":null,"confidence":0.99}

User: "What categories do I have?"
→ {"type":"LIST_CATEGORIES","item_name":null,"category":null,"subcategory":null,"location":null,"new_location":null,"notes":null,"confidence":0.99}

User: "Show categories"
→ {"type":"LIST_CATEGORIES","item_name":null,"category":null,"subcategory":null,"location":null,"new_location":null,"notes":null,"confidence":0.98}

User: "Have you seen my glasses?"
→ {"type":"SEARCH","item_name":"glasses","category":null,"subcategory":null,"location":null,"new_location":null,"notes":null,"confidence":0.98}

User: "Where did I leave the blue torch?"
→ {"type":"SEARCH","item_name":"blue torch","category":null,"subcategory":null,"location":null,"new_location":null,"notes":"blue","confidence":0.95}

User: "I moved the drill from the shed to the garage workbench"
→ {"type":"MOVE","item_name":"drill","category":null,"subcategory":null,"location":"Shed","new_location":"Garage > Workbench","notes":null,"confidence":0.97}

User: "Taken the charger upstairs to the bedroom"
→ {"type":"MOVE","item_name":"charger","category":null,"subcategory":null,"location":null,"new_location":"Bedroom","notes":null,"confidence":0.93}

User: "I threw away the old warranty card"
→ {"type":"REMOVE","item_name":"warranty card","category":null,"subcategory":null,"location":null,"new_location":null,"notes":"old","confidence":0.97}

User: "Delete the hand drill please"
→ {"type":"REMOVE","item_name":"hand drill","category":null,"subcategory":null,"location":null,"new_location":null,"notes":null,"confidence":0.99}

User: "It's a document, personal category"
→ {"type":"PROVIDE_CATEGORY","item_name":null,"category":"Documents","subcategory":"Personal","location":null,"new_location":null,"notes":null,"confidence":0.95}`;

function buildSystemPrompt(customPrompt?: string | null): string {
  return customPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
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

  const userJwt    = authHeader.replace("Bearer ", "");
  // Use service role client to verify JWT — correct Edge Function auth pattern.
  // DO NOT pass the JWT as the API key to createClient().
  const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
  const { data: { user }, error: authErr } = await svc.auth.getUser(userJwt);
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
  const { transcript, pendingState, customPrompt, minMatchScore } = body;
  if (!transcript?.trim()) return jsonError("transcript is required", 400);

  // ── Read settings (reuse service client from auth above) ─────────────────

  const [settingsRes, userSettingsRes, ratesRes] = await Promise.all([
    svc.from("app_settings").select("openai_api_key").eq("id", 1).single(),
    svc.from("user_settings").select("openai_model").eq("user_id", userId).single(),
    svc.from("user_model_rates").select("model, prompt_cost_per_1k, completion_cost_per_1k").eq("user_id", userId),
  ]);

  if (settingsRes.error || !settingsRes.data?.openai_api_key) {
    console.error("[parse-intent] OpenAI key missing:", settingsRes.error?.message);
    return jsonError("Server configuration error — OpenAI key not set", 500);
  }

  const openaiKey = settingsRes.data.openai_api_key;
  const model     = userSettingsRes.data?.openai_model ?? DEFAULT_MODEL;

  // Build a map of user-customised rates, falling back to DEFAULT_RATES
  const userRatesMap = new Map<string, { prompt: number; completion: number }>();
  for (const row of (ratesRes.data ?? [])) {
    userRatesMap.set(row.model, { prompt: row.prompt_cost_per_1k, completion: row.completion_cost_per_1k });
  }
  const modelRates = userRatesMap.get(model) ?? DEFAULT_RATES[model] ?? { prompt: 0, completion: 0 };

  console.log(`[parse-intent] Model: ${model}, minMatchScore: ${minMatchScore ?? "none"}`);

  // ── Build GPT messages ─────────────────────────────────────────────────────
  const messages: { role: string; content: string }[] = [
    { role: "system", content: buildSystemPrompt(customPrompt) },
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
    const usage    = chatJson.usage ?? null;
    console.log(`[parse-intent] GPT raw: ${raw.slice(0, 200)}`);
    parsed = JSON.parse(raw) as ParsedAction;
    (parsed as any)._usage = usage;
  } catch (err) {
    console.error("[parse-intent] GPT call failed:", err);
    return jsonError("Failed to parse intent", 502);
  }

  console.log(`[parse-intent] Action: ${parsed.type}, item: ${parsed.item_name}, confidence: ${parsed.confidence}`);

  // ── Determine if this is an "all items" / list query ─────────────────────
  const rawName = parsed.item_name?.trim().toLowerCase() ?? "";
  const rawTranscript = transcript.trim().toLowerCase();

  const isAllQuery = (parsed.type === "SEARCH" || parsed.type === "UNKNOWN") && (
    !rawName ||
    ["all", "all items", "everything", "*", "items", "all of my items", "all items in category", "list items", "find all items"].includes(rawName) ||
    rawName.startsWith("all items") ||
    rawName.startsWith("everything") ||
    rawTranscript.includes("find all items") ||
    rawTranscript.includes("list all items") ||
    rawTranscript.includes("show all items")
  );

  if (isAllQuery) {
    parsed.type = "SEARCH";
  }

  // ── Generate embedding (STORE, MOVE, SEARCH) ──────────────────────────────
  let embedding: number[] | null = null;
  if (["STORE", "MOVE", "SEARCH", "PROVIDE_CATEGORY"].includes(parsed.type) && parsed.item_name && !isAllQuery) {
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
      if (isAllQuery) {
        let query = svc.from("items").select().eq("user_id", userId);
        if (parsed.category) {
          query = query.ilike("category", parsed.category);
        }
        if (parsed.subcategory) {
          query = query.ilike("subcategory", parsed.subcategory);
        }

        const { data: allItems, error: allErr } = await query.order("name", { ascending: true }).limit(50);

        if (allErr) {
          console.error("[parse-intent] All items query error:", allErr.message);
          responseMessage = "I ran into a problem loading items. Please try again.";
        } else if (!allItems || allItems.length === 0) {
          if (parsed.category && parsed.subcategory) {
            responseMessage = `I couldn't find any items in category "${parsed.category}" › "${parsed.subcategory}".`;
          } else if (parsed.category) {
            responseMessage = `I couldn't find any items in category "${parsed.category}".`;
          } else {
            responseMessage = "Your inventory is currently empty.";
          }
        } else {
          responseItems = allItems;
          if (parsed.category && parsed.subcategory) {
            responseMessage = `Found ${allItems.length} item${allItems.length === 1 ? "" : "s"} in "${parsed.category} › ${parsed.subcategory}".`;
          } else if (parsed.category) {
            responseMessage = `Found ${allItems.length} item${allItems.length === 1 ? "" : "s"} in category "${parsed.category}".`;
          } else {
            responseMessage = `Found ${allItems.length} item${allItems.length === 1 ? "" : "s"} in your inventory.`;
          }
        }
        break;
      }

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
          // Apply minimum match score filter
          const scoreThreshold = typeof minMatchScore === "number" ? minMatchScore : 0;
          const filtered = scoreThreshold > 0
            ? results.filter((r: { hybrid_score?: number }) => (r.hybrid_score ?? 1) >= scoreThreshold)
            : results;

          if (filtered.length === 0) {
            responseMessage = `I found some possible matches for "${parsed.item_name}" but none were confident enough (threshold: ${Math.round(scoreThreshold * 100)}%). Try rephrasing.`;
          } else {
            responseItems   = filtered;
            const top       = filtered[0];
            responseMessage = `I found "${top.name}" in ${top.location}` +
              (top.category ? ` (${top.category} › ${top.subcategory ?? "General"})` : "") + ".";
            if (filtered.length > 1) {
              responseMessage += ` There ${filtered.length === 2 ? "is" : "are"} ${filtered.length - 1} other possible match${filtered.length === 2 ? "" : "es"}.`;
            }
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

    // ── LIST_CATEGORIES ────────────────────────────────────────────────────
    case "LIST_CATEGORIES": {
      const { data: catRows, error: catErr } = await svc
        .from("items")
        .select("category, subcategory")
        .eq("user_id", userId);

      if (catErr) {
        console.error("[parse-intent] List categories error:", catErr.message);
        responseMessage = "I ran into a problem loading categories. Please try again.";
      } else if (!catRows || catRows.length === 0) {
        responseMessage = "You don't have any categorized items in your inventory yet.";
      } else {
        const catMap = new Map<string, Set<string>>();
        for (const row of catRows) {
          const c = row.category?.trim() || "Uncategorized";
          if (!catMap.has(c)) catMap.set(c, new Set());
          if (row.subcategory?.trim()) catMap.get(c)!.add(row.subcategory.trim());
        }

        const catSummaries: string[] = [];
        catMap.forEach((subs, cat) => {
          if (subs.size > 0) {
            catSummaries.push(`${cat} (${Array.from(subs).join(", ")})`);
          } else {
            catSummaries.push(cat);
          }
        });

        responseMessage = `You have ${catMap.size} category${catMap.size === 1 ? "" : "ies"}:\n• ${catSummaries.join("\n• ")}`;
      }
      break;
    }

    default:
      responseMessage = "I didn't quite understand that. Try saying something like: \"I put my passport in the top drawer\" or \"Where is my passport?\"";
  }

  const elapsed = Date.now() - ts_start;
  console.log(`[parse-intent] Done in ${elapsed}ms. Message: "${responseMessage.slice(0, 80)}"`);

  // ── Calculate cost and log usage ──────────────────────────────────────────
  const rawUsage = (parsed as any)._usage;
  const promptTokens     = rawUsage?.prompt_tokens     ?? 0;
  const completionTokens = rawUsage?.completion_tokens ?? 0;
  const totalTokens      = rawUsage?.total_tokens      ?? promptTokens + completionTokens;
  const estimatedCost    =
    (promptTokens     / 1000) * modelRates.prompt +
    (completionTokens / 1000) * modelRates.completion;

  // Fire-and-forget — do not await so it doesn't slow the response
  svc.from("api_usage_logs").insert({
    user_id:           userId,
    model,
    prompt_tokens:     promptTokens,
    completion_tokens: completionTokens,
    total_tokens:      totalTokens,
    cost:              estimatedCost,
  }).then(({ error }) => {
    if (error) console.warn("[parse-intent] Failed to log usage:", error.message);
  });

  return jsonSuccess({
    action:         parsed.type,
    message:        responseMessage,
    items:          responseItems.length ? responseItems : undefined,
    item:           responseItem ?? undefined,
    needsCategory,
    pendingState:   needsCategory
      ? { type: "PENDING_CATEGORY", item_name: parsed.item_name, location: parsed.location }
      : null,
    model,
    elapsed_ms:     elapsed,
    usage:          rawUsage ?? undefined,
    estimated_cost: estimatedCost,
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
