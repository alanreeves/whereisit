"use client";
/**
 * app/page.tsx
 * Where Is It? — Main Voice UI
 *
 * Voice state machine:
 *   IDLE → RECORDING → PROCESSING → SPEAKING → IDLE
 *   IDLE → RECORDING → PROCESSING → PENDING_CATEGORY → RECORDING → ...
 *
 * Mobile-first layout:
 *   - Single-column on mobile
 *   - Sidebar (log) + main panel (mic + results) on md+
 */

import { useEffect, useRef, useState, useCallback, useMemo, Fragment } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";
import { logger } from "@/lib/logger";
import { VERSION_LABEL, APP_VERSION } from "@/lib/version";
import type { User, Session } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────────────
type VoiceState =
  | "IDLE"
  | "RECORDING"
  | "PROCESSING"
  | "SPEAKING"
  | "PENDING_CATEGORY";

type InputMode = "voice" | "text";

type ActionType =
  | "STORE"
  | "SEARCH"
  | "MOVE"
  | "REMOVE"
  | "PROVIDE_CATEGORY"
  | "LIST_CATEGORIES"
  | "SHOW_INVENTORY"
  | "UNKNOWN";

interface Message {
  id:     string;
  role:   "user" | "system";
  text:   string;
  ts:     Date;
  action?: ActionType;
}

interface ItemResult {
  id:           string;
  name:         string;
  category:     string | null;
  subcategory:  string | null;
  location:     string;
  notes:        string | null;
  hybrid_score?: number;
  created_at:   string;
  updated_at:   string;
}

interface PendingState {
  type:      "PENDING_CATEGORY";
  item_name: string;
  location:  string;
}

interface ParseIntentResponse {
  action:        ActionType;
  message:       string;
  items?:        ItemResult[];
  item?:         ItemResult;
  needsCategory: boolean;
  pendingState?: PendingState | null;
  model?:        string;
  elapsed_ms?:   number;
  usage?: {
    prompt_tokens?:     number;
    completion_tokens?: number;
    total_tokens?:      number;
  };
  estimated_cost?: number;
}

// ─── Available OpenAI models ──────────────────────────────────────────────────
const OPENAI_MODELS = [
  { value: "gpt-5.4-nano",   label: "GPT-5.4 Nano (Default — fastest)" },
  { value: "gpt-5.4-mini",   label: "GPT-5.4 Mini" },
  { value: "gpt-5.4",        label: "GPT-5.4" },
  { value: "gpt-5.4-pro",    label: "GPT-5.4 Pro" },
  { value: "gpt-5.5",        label: "GPT-5.5" },
  { value: "gpt-5.5-pro",    label: "GPT-5.5 Pro" },
  { value: "gpt-5.6-luna",   label: "GPT-5.6 Luna" },
  { value: "gpt-5.6-terra",  label: "GPT-5.6 Terra" },
  { value: "gpt-5.6-sol",    label: "GPT-5.6 Sol (most powerful)" },
];

// ─── Category emoji map ───────────────────────────────────────────────────────
function categoryEmoji(category: string | null): string {
  if (!category) return "📦";
  const c = category.toLowerCase();
  if (c.includes("document") || c.includes("paper"))  return "📄";
  if (c.includes("tool"))                              return "🔧";
  if (c.includes("electronic") || c.includes("tech")) return "💻";
  if (c.includes("kitchen") || c.includes("food"))    return "🍳";
  if (c.includes("clothes") || c.includes("fashion")) return "👗";
  if (c.includes("medicine") || c.includes("health")) return "💊";
  if (c.includes("book") || c.includes("media"))      return "📚";
  if (c.includes("key"))                               return "🔑";
  if (c.includes("jewel") || c.includes("access"))    return "💍";
  return "📦";
}

// ─── Speak helper ─────────────────────────────────────────────────────────────
function speak(text: string, onEnd?: () => void): void {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const utt  = new SpeechSynthesisUtterance(text);
  utt.rate   = 1.05;
  utt.pitch  = 1;
  utt.volume = 1;
  // Prefer a natural UK English voice
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v =>
    v.lang.startsWith("en-GB") && !v.name.toLowerCase().includes("novelty")
  ) ?? voices.find(v => v.lang.startsWith("en")) ?? null;
  if (preferred) utt.voice = preferred;
  utt.onend   = () => { logger.debug("TTS", "Speech ended"); onEnd?.(); };
  utt.onerror = (e) => { logger.warn("TTS", "Speech error", e); onEnd?.(); };
  logger.debug("TTS", `Speaking: "${text.slice(0, 60)}..."`);
  window.speechSynthesis.speak(utt);
}

// ─── generateId helper ────────────────────────────────────────────────────────
function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// =============================================================================
// AUTH SCREEN
// =============================================================================
function AuthScreen({ onAuth }: { onAuth: (session: Session) => void }) {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [mode,     setMode]     = useState<"signin" | "signup">("signin");
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const supabase = getSupabaseClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    logger.info("AUTH", `Attempting ${mode}`, { email });

    // ── Sign-up: check whitelist first ────────────────────────────────────────
    if (mode === "signup") {
      logger.info("AUTH", "Checking whitelist", { email });
      const { data: allowed, error: wlErr } = await (supabase as any)
        .rpc("check_whitelist", { p_email: email.trim().toLowerCase() });

      if (wlErr) {
        logger.warn("AUTH", "Whitelist check error", wlErr.message);
        setError("Unable to verify your account. Please try again.");
        setLoading(false);
        return;
      }

      if (!allowed) {
        logger.warn("AUTH", "Sign-up rejected — email not in whitelist", { email });
        setError("This email address is not authorised to create an account. Please contact the administrator.");
        setLoading(false);
        return;
      }

      logger.info("AUTH", "Whitelist check passed", { email });
    }

    // ── Proceed with Supabase auth ────────────────────────────────────────────
    const { data, error: authErr } = mode === "signin"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });

    if (authErr) {
      logger.warn("AUTH", "Auth failed", authErr.message);
      setError(authErr.message);
    } else if (data.session) {
      logger.info("AUTH", "Auth success", { userId: data.session.user.id });
      onAuth(data.session);
    } else {
      // signUp without email confirmation returns no session
      setError("Check your email to confirm your account.");
    }
    setLoading(false);
  }

  return (
    <div className="auth-screen">
      <div className="glass-strong auth-card">
        <div style={{ textAlign: "center", fontSize: "3rem", marginBottom: "0.5rem" }}>🔍</div>
        <h1 className="auth-title">Where Is It?</h1>
        <p className="auth-subtitle">
          {mode === "signin" ? "Your voice-first inventory tracker" : "Create your account"}
        </p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label" htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              type="email"
              className="form-input"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              className="form-input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              minLength={6}
            />
          </div>

          {mode === "signup" && (
            <p style={{
              fontSize: "var(--text-xs)",
              color:    "var(--clr-text-3)",
              marginBottom: "0.75rem",
              textAlign: "center",
            }}>
              🔒 Account creation is by invitation only
            </p>
          )}

          {error && (
            <div className="toast toast--error" style={{ marginBottom: "1rem", borderRadius: "0.5rem" }}>
              {error}
            </div>
          )}

          <button
            id="auth-submit"
            type="submit"
            className="btn btn--primary btn--full"
            disabled={loading}
          >
            {loading ? <span className="spinner" /> : null}
            {loading
              ? (mode === "signup" ? "Checking authorisation…" : "Signing in…")
              : mode === "signin" ? "Sign In" : "Create Account"
            }
          </button>
        </form>

        <div className="divider" />

        <button
          className="btn btn--ghost btn--full"
          onClick={() => { setMode(m => m === "signin" ? "signup" : "signin"); setError(null); }}
        >
          {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// SETTINGS MODAL
// =============================================================================
function SettingsModal({
  userId,
  currentModel,
  currentCustomPrompt,
  currentMinMatchScore,
  deferredPrompt,
  isStandalone,
  onInstallApp,
  onSave,
  onClose,
}: {
  userId:               string;
  currentModel:         string;
  currentCustomPrompt:  string | null;
  currentMinMatchScore: number;
  deferredPrompt:       any;
  isStandalone:         boolean;
  onInstallApp:         () => void;
  onSave: (model: string, customPrompt: string | null, minMatchScore: number) => void;
  onClose: () => void;
}) {
  const [model,           setModel]           = useState(currentModel);
  const [prompt,          setPrompt]          = useState(currentCustomPrompt ?? "");
  const [scoreThresh,     setScoreThresh]     = useState(Math.round(currentMinMatchScore * 100));
  const [saving,          setSaving]          = useState(false);
  const [saved,           setSaved]           = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateStatus,    setUpdateStatus]    = useState<string | null>(null);
  const supabase = getSupabaseClient();

  async function handleSave() {
    setSaving(true);
    const resolvedPrompt   = prompt.trim() || null;
    const resolvedScore    = scoreThresh / 100;
    logger.info("SETTINGS", "Saving settings", { model, hasCustomPrompt: !!resolvedPrompt, minMatchScore: resolvedScore });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("user_settings")
      .upsert(
        { user_id: userId, openai_model: model, custom_prompt: resolvedPrompt, min_match_score: resolvedScore },
        { onConflict: "user_id" }
      ) as { error: { message: string } | null };

    if (error) {
      logger.warn("SETTINGS", "Save failed", error.message);
    } else {
      logger.info("SETTINGS", "Settings saved");
      setSaved(true);
      onSave(model, resolvedPrompt, resolvedScore);
      setTimeout(onClose, 800);
    }
    setSaving(false);
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass-strong modal-sheet" style={{ position: "relative", maxHeight: "90vh", overflowY: "auto" }}>
        <h2 className="modal-title">⚙️ Settings</h2>

        {/* Model */}
        <div className="form-group">
          <label className="form-label" htmlFor="model-select">OpenAI Model</label>
          <select
            id="model-select"
            className="form-select"
            value={model}
            onChange={e => setModel(e.target.value)}
          >
            {OPENAI_MODELS.map(m => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <p style={{ fontSize: "0.75rem", color: "var(--clr-text-3)", marginTop: "0.25rem" }}>
            Applies to intent parsing only. Embeddings always use text-embedding-3-small.
          </p>
        </div>

        {/* Minimum match score */}
        <div className="form-group">
          <label className="form-label" htmlFor="score-thresh">
            Minimum match score: <strong>{scoreThresh}%</strong>
          </label>
          <input
            id="score-thresh"
            type="range"
            min={0}
            max={100}
            step={5}
            value={scoreThresh}
            onChange={e => setScoreThresh(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--clr-primary)" }}
          />
          <p style={{ fontSize: "0.75rem", color: "var(--clr-text-3)", marginTop: "0.25rem" }}>
            Search results with a match score below this threshold are hidden. 0% = show everything.
          </p>
        </div>

        {/* Custom system prompt */}
        <div className="form-group">
          <label className="form-label" htmlFor="custom-prompt">Custom AI Prompt (optional)</label>
          <textarea
            id="custom-prompt"
            className="form-input"
            rows={8}
            placeholder={`Leave empty to use the built-in prompt.\n\nExample override:\n"Parse the user's speech and return JSON with type (STORE/SEARCH/MOVE/REMOVE), item_name, and location..."`}
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            style={{ resize: "vertical", fontFamily: "monospace", fontSize: "0.75rem" }}
          />
          <p style={{ fontSize: "0.75rem", color: "var(--clr-text-3)", marginTop: "0.25rem" }}>
            Advanced: override the system prompt sent to the AI. Clear to restore the default.
          </p>
        </div>

        {/* ── PWA Installation Section ── */}
        <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.08)", margin: "1.25rem 0 1rem" }} />
        <div className="form-group">
          <label className="form-label">📱 App Installation (PWA)</label>
          {isStandalone ? (
            <div style={{ fontSize: "0.8rem", color: "#10b981", padding: "0.4rem 0.6rem", background: "rgba(16, 185, 129, 0.1)", borderRadius: "6px" }}>
              ✓ App is installed &amp; running in standalone mode.
            </div>
          ) : deferredPrompt ? (
            <button
              id="settings-install-pwa"
              type="button"
              className="btn btn--primary"
              style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}
              onClick={onInstallApp}
            >
              📲 Install App to Home Screen
            </button>
          ) : (
            <p style={{ fontSize: "0.75rem", color: "var(--clr-text-3)" }}>
              Install prompt is managed by your browser. If available, an 📲 Install icon appears in the top header toolbar.
            </p>
          )}
        </div>

        {/* ── Check for Updates Section ── */}
        <div className="form-group">
          <label className="form-label">🔄 App Version &amp; Updates</label>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: "0.8rem", color: "var(--clr-text-2)" }}>Running version: <strong>v{APP_VERSION}</strong></span>
            <button
              id="check-updates-btn"
              type="button"
              className="btn btn--ghost"
              style={{ fontSize: "0.8rem", padding: "0.35rem 0.75rem" }}
              onClick={async () => {
                setCheckingUpdates(true);
                setUpdateStatus("Checking for updates...");
                try {
                  if (!("serviceWorker" in navigator)) {
                    setUpdateStatus("Service worker not supported on this browser.");
                    return;
                  }
                  const reg = await navigator.serviceWorker.getRegistration();
                  if (!reg) {
                    setUpdateStatus("No active service worker found.");
                    return;
                  }

                  // Force SW update check
                  await reg.update();

                  if (reg.waiting) {
                    setUpdateStatus("New version found! Updating app...");
                    reg.waiting.postMessage({ type: "SKIP_WAITING" });
                    setTimeout(() => window.location.reload(), 600);
                    return;
                  }

                  if (reg.installing) {
                    setUpdateStatus("Downloading new update...");
                    reg.installing.addEventListener("statechange", function () {
                      if (this.state === "installed") {
                        setUpdateStatus("Update installed! Reloading app...");
                        setTimeout(() => window.location.reload(), 600);
                      }
                    });
                    return;
                  }

                  // Direct check of sw.js on server
                  const swRes = await fetch(`/sw.js?t=${Date.now()}`);
                  if (swRes.ok) {
                    const text = await swRes.text();
                    const match = text.match(/const APP_VERSION = "([^"]+)";/);
                    if (match && match[1] !== APP_VERSION) {
                      setUpdateStatus(`New version v${match[1]} available on server! Reloading...`);
                      setTimeout(() => window.location.reload(), 800);
                      return;
                    }
                  }

                  setUpdateStatus(`You are running the latest version (v${APP_VERSION}).`);
                } catch (err) {
                  console.warn("Update check error:", err);
                  setUpdateStatus("Error checking for updates.");
                } finally {
                  setCheckingUpdates(false);
                }
              }}
              disabled={checkingUpdates}
            >
              {checkingUpdates ? <span className="spinner" /> : "🔄 Check for Updates"}
            </button>
          </div>
          {updateStatus && (
            <p style={{ fontSize: "0.8rem", color: updateStatus.includes("Error") || updateStatus.includes("failed") ? "#ef4444" : "#10b981", marginTop: "0.5rem" }}>
              {updateStatus}
            </p>
          )}
        </div>

        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button className="btn btn--ghost" style={{ flex: 1 }} onClick={onClose}>
            Cancel
          </button>
          <button
            id="settings-save"
            className="btn btn--primary"
            style={{ flex: 2 }}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? <span className="spinner" /> : null}
            {saved ? "✓ Saved!" : saving ? "Saving…" : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// HELP GUIDE MODAL
// =============================================================================
function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass-strong modal-sheet" style={{ position: "relative", maxHeight: "85vh", overflowY: "auto" }}>
        <h2 className="modal-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          📖 Voice Help & Spoken Commands Guide
        </h2>
        <p style={{ fontSize: "0.85rem", color: "var(--clr-text-2)", marginBottom: "1rem" }}>
          Speak naturally! Here are examples of voice commands you can use to track, find, move, or delete household items.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {/* STORE */}
          <div style={{ background: "rgba(255,255,255,0.05)", padding: "0.85rem", borderRadius: "0.5rem", borderLeft: "3px solid var(--clr-primary)" }}>
            <h3 style={{ fontSize: "0.95rem", color: "var(--clr-primary)", marginBottom: "0.25rem" }}>📦 Storing Items</h3>
            <p style={{ fontSize: "0.8rem", color: "var(--clr-text-2)", marginBottom: "0.5rem" }}>Add a new item or set its initial location.</p>
            <ul style={{ fontSize: "0.8rem", color: "var(--clr-text-1)", paddingLeft: "1.2rem", margin: 0 }}>
              <li>&quot;I put my <strong>passport</strong> in the <strong>office desk top drawer</strong>.&quot;</li>
              <li>&quot;Stored <strong>hand drill</strong> under <strong>garage workbench</strong>.&quot;</li>
              <li>&quot;Place <strong>spare house key</strong> inside <strong>hallway keybox</strong>.&quot;</li>
            </ul>
          </div>

          {/* SEARCH */}
          <div style={{ background: "rgba(255,255,255,0.05)", padding: "0.85rem", borderRadius: "0.5rem", borderLeft: "3px solid #10b981" }}>
            <h3 style={{ fontSize: "0.95rem", color: "#10b981", marginBottom: "0.25rem" }}>🔍 Finding & Locating Items</h3>
            <p style={{ fontSize: "0.8rem", color: "var(--clr-text-2)", marginBottom: "0.5rem" }}>Ask where something is stored using natural questions.</p>
            <ul style={{ fontSize: "0.8rem", color: "var(--clr-text-1)", paddingLeft: "1.2rem", margin: 0 }}>
              <li>&quot;Where is my <strong>passport</strong>?&quot;</li>
              <li>&quot;Find the <strong>hand drill</strong>.&quot;</li>
              <li>&quot;<strong>Find all items</strong>&quot;</li>
              <li>&quot;<strong>Find all items in category Documents</strong>&quot;</li>
              <li>&quot;<strong>Find all items in category Documents subcategory Personal</strong>&quot;</li>
              <li>&quot;<strong>List all categories</strong>&quot;</li>
            </ul>
          </div>

          {/* MOVE */}
          <div style={{ background: "rgba(255,255,255,0.05)", padding: "0.85rem", borderRadius: "0.5rem", borderLeft: "3px solid #f59e0b" }}>
            <h3 style={{ fontSize: "0.95rem", color: "#f59e0b", marginBottom: "0.25rem" }}>🚚 Moving Items</h3>
            <p style={{ fontSize: "0.8rem", color: "var(--clr-text-2)", marginBottom: "0.5rem" }}>Relocate an item to a new location.</p>
            <ul style={{ fontSize: "0.8rem", color: "var(--clr-text-1)", paddingLeft: "1.2rem", margin: 0 }}>
              <li>&quot;Moved my <strong>passport</strong> from <strong>desk</strong> to <strong>bedroom safe</strong>.&quot;</li>
              <li>&quot;I took the <strong>hand drill</strong> to the <strong>shed shelf</strong>.&quot;</li>
              <li>&quot;Relocate <strong>car manual</strong> to <strong>glove compartment</strong>.&quot;</li>
            </ul>
          </div>

          {/* REMOVE */}
          <div style={{ background: "rgba(255,255,255,0.05)", padding: "0.85rem", borderRadius: "0.5rem", borderLeft: "3px solid #ef4444" }}>
            <h3 style={{ fontSize: "0.95rem", color: "#ef4444", marginBottom: "0.25rem" }}>🗑 Removing & Deleting Items</h3>
            <p style={{ fontSize: "0.8rem", color: "var(--clr-text-2)", marginBottom: "0.5rem" }}>Remove item records when used up or discarded.</p>
            <ul style={{ fontSize: "0.8rem", color: "var(--clr-text-1)", paddingLeft: "1.2rem", margin: 0 }}>
              <li>&quot;Delete the <strong>hand drill</strong> record.&quot;</li>
              <li>&quot;I threw away the <strong>old batteries</strong>.&quot;</li>
              <li>&quot;Remove <strong>expired warranty card</strong>.&quot;</li>
            </ul>
          </div>

          {/* CATEGORIES */}
          <div style={{ background: "rgba(255,255,255,0.05)", padding: "0.85rem", borderRadius: "0.5rem", borderLeft: "3px solid #8b5cf6" }}>
            <h3 style={{ fontSize: "0.95rem", color: "#8b5cf6", marginBottom: "0.25rem" }}>🏷 Multi-Tier Hierarchy</h3>
            <p style={{ fontSize: "0.8rem", color: "var(--clr-text-2)", margin: 0 }}>
              Items are structured into <strong>Primary Category</strong> (e.g. Documents, Tools), <strong>Subcategory</strong> (e.g. Personal, Hand Tools), and <strong>Location Path</strong> (e.g. Office &gt; Desk &gt; Top Drawer). If a category is missing, the app will ask you!
            </p>
          </div>
        </div>

        <div style={{ marginTop: "1.25rem" }}>
          <button className="btn btn--primary btn--full" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// MAIN APP
// =============================================================================
export default function HomePage() {
  const supabase = getSupabaseClient();

  // ── Auth state ───────────────────────────────────────────────────────────
  const [user,    setUser]    = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  // ── Voice / app state ────────────────────────────────────────────────────
  const [voiceState,    setVoiceState]    = useState<VoiceState>("IDLE");
  const [messages,      setMessages]      = useState<Message[]>([]);
  const [results,       setResults]       = useState<ItemResult[]>([]);
  const [pendingState,  setPendingState]  = useState<PendingState | null>(null);
  const [openaiModel,   setOpenaiModel]   = useState<string>("gpt-5.4-nano");
  const [customPrompt,  setCustomPrompt]  = useState<string | null>(null);  // null = use server default
  const [minMatchScore, setMinMatchScore] = useState<number>(0.5);  // 50% default
  const [showSettings,  setShowSettings]  = useState(false);
  const [showHelp,      setShowHelp]      = useState(false);
  const [showCost,      setShowCost]      = useState(false);
  const [showInventory, setShowInventory] = useState(false);
  const [inventoryItems, setInventoryItems] = useState<ItemResult[]>([]);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isStandalone,   setIsStandalone]   = useState(false);
  const [isOnline,      setIsOnline]      = useState(true);
  const [inputMode,     setInputMode]     = useState<InputMode>("voice");
  const [textInput,     setTextInput]     = useState("");
  const [isSubmitting,  setIsSubmitting]  = useState(false);
  const textInputRef                      = useRef<HTMLTextAreaElement>(null);
  const [aiUsageStats,  setAiUsageStats]  = useState<{
    model: string;
    elapsedMs?: number;
    tokens?: number;
    action?: string;
    cost?: number;
  } | null>(null);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const mediaRecorderRef  = useRef<MediaRecorder | null>(null);
  const audioChunksRef    = useRef<Blob[]>([]);
  const logRef            = useRef<HTMLDivElement>(null);
  const streamRef         = useRef<MediaStream | null>(null);

  // ─── PWA & Auth init ────────────────────────────────────────────────────────
  useEffect(() => {
    // Check if app is running in standalone PWA mode
    const isStandaloneMode =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as any).standalone === true;
    setIsStandalone(isStandaloneMode);

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
      logger.info("PWA", "beforeinstallprompt captured");
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
      logger.info("PWA", "App installed successfully");
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      setAuthChecked(true);
      if (s?.user) loadUserSettings(s.user.id);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      if (s?.user) loadUserSettings(s.user.id);
    });

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInstallApp = useCallback(async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    logger.info("PWA", "User install prompt outcome", { outcome });
    if (outcome === "accepted") {
      setDeferredPrompt(null);
      setIsStandalone(true);
    }
  }, [deferredPrompt]);

  // ─── Load user settings ───────────────────────────────────────────────────
  async function loadUserSettings(uid: string) {
    logger.info("SETTINGS", "Loading user settings", { uid });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from("user_settings")
      .select("openai_model, custom_prompt, min_match_score")
      .eq("user_id", uid)
      .single() as { data: { openai_model: string; custom_prompt: string | null; min_match_score: number | null } | null };

    if (data?.openai_model)    setOpenaiModel(data.openai_model);
    if (data?.custom_prompt !== undefined) setCustomPrompt(data.custom_prompt ?? null);
    if (typeof data?.min_match_score === "number") setMinMatchScore(data.min_match_score);
    logger.info("SETTINGS", "Settings loaded", { model: data?.openai_model, minMatchScore: data?.min_match_score });
  }

  // ─── Online/offline ───────────────────────────────────────────────────────
  useEffect(() => {
    const onOnline  = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online",  onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online",  onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // ─── Scroll log to bottom ────────────────────────────────────────────────
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages]);

  // ─── Speak on new system messages (voice mode only) ────────────────────────
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === "system") {
      if (inputMode === "voice") {
        setVoiceState("SPEAKING");
        speak(last.text, () => setVoiceState(pendingState ? "PENDING_CATEGORY" : "IDLE"));
      } else {
        setVoiceState(pendingState ? "PENDING_CATEGORY" : "IDLE");
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);



  // ─── Add message helper ───────────────────────────────────────────────────
  const addMessage = useCallback((role: Message["role"], text: string, action?: ActionType) => {
    setMessages(prev => [...prev, {
      id: generateId(), role, text, ts: new Date(), action,
    }]);
  }, []);

  // ─── Start recording ──────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    if (voiceState !== "IDLE" && voiceState !== "PENDING_CATEGORY") return;
    logger.info("MIC", "Requesting microphone access");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current      = stream;
      audioChunksRef.current = [];

      // Prefer webm/opus for Deepgram; fallback to default
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        processAudio();
      };

      recorder.start(250);
      setVoiceState("RECORDING");
      logger.info("MIC", "Recording started", { mimeType: mimeType || "default" });
    } catch (err) {
      logger.error("MIC", "Failed to access microphone", err);
      addMessage("system", "I couldn't access your microphone. Please check browser permissions.");
    }
  }, [voiceState, addMessage]);

  // ─── Stop recording ───────────────────────────────────────────────────────
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      logger.info("MIC", "Recording stopped");
      setVoiceState("PROCESSING");
    }
  }, []);

  // ─── Process audio → transcribe → parse intent ────────────────────────────
  const processAudio = useCallback(async () => {
    const chunks = audioChunksRef.current;
    if (!chunks.length) {
      setVoiceState(pendingState ? "PENDING_CATEGORY" : "IDLE");
      return;
    }

    const audioBlob = new Blob(chunks, { type: chunks[0].type || "audio/webm" });
    logger.info("EDGE", "Sending audio to transcribe edge function", {
      size: audioBlob.size,
      type: audioBlob.type,
    });

    try {
      // Step 1: Transcribe via Supabase Edge Function
      const formData = new FormData();
      formData.append("audio", audioBlob, "recording.webm");

      const transcribeRes = await supabase.functions.invoke("transcribe", { body: formData });

      if (transcribeRes.error) {
        throw new Error(`Transcribe error: ${transcribeRes.error.message}`);
      }

      const transcript: string = transcribeRes.data?.transcript ?? "";
      logger.info("DEEPGRAM", "Transcript received", { transcript });

      if (!transcript.trim()) {
        addMessage("system", "I didn't catch that. Please try again.");
        setVoiceState(pendingState ? "PENDING_CATEGORY" : "IDLE");
        return;
      }

      addMessage("user", transcript);

      // Step 2: Parse intent via Supabase Edge Function
      logger.info("EDGE", "Sending transcript to parse-intent", { transcript, pendingState });
      const intentRes = await supabase.functions.invoke<ParseIntentResponse>("parse-intent", {
        body: { transcript, pendingState, customPrompt, minMatchScore },
      });

      if (intentRes.error) {
        throw new Error(`Parse intent error: ${intentRes.error.message}`);
      }

      const result = intentRes.data!;
      logger.info("OPENAI", "Intent parsed", {
        action:  result.action,
        message: result.message,
        model:   result.model,
      });

      setAiUsageStats({
        model:     result.model ?? openaiModel,
        elapsedMs: result.elapsed_ms,
        tokens:    result.usage?.total_tokens,
        action:    result.action,
        cost:      result.estimated_cost,
      });

      // Update results list
      if (result.action === "SHOW_INVENTORY") {
        setShowInventory(true);
        if (result.items?.length) setInventoryItems(result.items);
      }
      if (result.items?.length) {
        setResults(result.items);
      } else if (result.item) {
        setResults(prev => {
          const next = [result.item as ItemResult, ...prev.filter(i => i.id !== result.item!.id)];
          return next.slice(0, 10);
        });
      } else if (result.action === "REMOVE") {
        // Item was removed — nothing to show
      }

      // Update pending state
      if (result.needsCategory && result.pendingState) {
        setPendingState(result.pendingState);
      } else {
        setPendingState(null);
      }

      addMessage("system", result.message, result.action);
    } catch (err) {
      logger.error("EDGE", "Processing failed", err);
      addMessage("system", "Something went wrong. Please try again.");
      setVoiceState("IDLE");
      setPendingState(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingState, addMessage]);

  // ─── Process typed text directly to parse-intent ─────────────────────────
  const processText = useCallback(async (text: string) => {
    if (!text.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setVoiceState("PROCESSING");
    setTextInput("");
    addMessage("user", text.trim());
    logger.info("TEXT", "Sending typed input to parse-intent", { text });

    try {
      const intentRes = await supabase.functions.invoke<ParseIntentResponse>("parse-intent", {
        body: { transcript: text.trim(), pendingState, customPrompt, minMatchScore },
      });

      if (intentRes.error) throw new Error(`Parse intent error: ${intentRes.error.message}`);

      const result = intentRes.data!;
      logger.info("OPENAI", "Intent parsed (text mode)", { action: result.action, model: result.model });

      setAiUsageStats({
        model:     result.model ?? openaiModel,
        elapsedMs: result.elapsed_ms,
        tokens:    result.usage?.total_tokens,
        action:    result.action,
        cost:      result.estimated_cost,
      });

      if (result.action === "SHOW_INVENTORY") {
        setShowInventory(true);
        if (result.items?.length) setInventoryItems(result.items);
      }
      if (result.items?.length) {
        setResults(result.items);
      } else if (result.item) {
        setResults(prev => {
          const next = [result.item as ItemResult, ...prev.filter(i => i.id !== result.item!.id)];
          return next.slice(0, 10);
        });
      }

      if (result.needsCategory && result.pendingState) {
        setPendingState(result.pendingState);
        setVoiceState("PENDING_CATEGORY");
      } else {
        setPendingState(null);
        setVoiceState("IDLE");
      }

      addMessage("system", result.message, result.action);
    } catch (err) {
      logger.error("TEXT", "Text processing failed", err);
      addMessage("system", "Something went wrong. Please try again.");
      setVoiceState("IDLE");
      setPendingState(null);
    } finally {
      setIsSubmitting(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingState, addMessage, isSubmitting, openaiModel]);

  // ─── Sign out ─────────────────────────────────────────────────────────────
  async function signOut() {
    logger.info("AUTH", "Signing out");
    window.speechSynthesis?.cancel();
    // Ask SW to clear API cache on logout
    if (navigator.serviceWorker?.controller) {
      const channel = new MessageChannel();
      navigator.serviceWorker.controller.postMessage(
        { type: "CLEAR_API_CACHE" }, [channel.port2]
      );
    }
    await supabase.auth.signOut();
    setMessages([]);
    setResults([]);
    setPendingState(null);
  }

  // ─── Mic button handler ───────────────────────────────────────────────────
  function handleMicPress() {
    if (voiceState === "RECORDING") {
      stopRecording();
    } else if (voiceState === "IDLE" || voiceState === "PENDING_CATEGORY") {
      startRecording();
    }
  }

  // ─── Render: auth loading ────────────────────────────────────────────────
  if (!authChecked) {
    return (
      <div className="auth-screen">
        <div style={{ textAlign: "center" }}>
          <div className="spinner" style={{ width: "2rem", height: "2rem", margin: "0 auto" }} />
        </div>
      </div>
    );
  }

  // ─── Render: auth screen ──────────────────────────────────────────────────
  if (!user || !session) {
    return <AuthScreen onAuth={(s) => { setSession(s); setUser(s.user); }} />;
  }

  // ─── Mic button appearance ─────────────────────────────────────────────────
  const micClass = [
    "mic-btn",
    voiceState === "RECORDING"  ? "mic-btn--recording"  : "",
    voiceState === "PROCESSING" ? "mic-btn--processing" : "",
    voiceState === "SPEAKING"   ? "mic-btn--speaking"   : "",
  ].filter(Boolean).join(" ");

  const micIcon = {
    IDLE:             "🎙",
    RECORDING:        "⏹",
    PROCESSING:       "⏳",
    SPEAKING:         "🔊",
    PENDING_CATEGORY: "🎙",
  }[voiceState];

  const statusText = {
    IDLE:             "Tap to speak",
    RECORDING:        "Listening… tap to stop",
    PROCESSING:       "Processing…",
    SPEAKING:         "Speaking…",
    PENDING_CATEGORY: "Tap to answer",
  }[voiceState];

  const statusClass = {
    IDLE:             "",
    RECORDING:        "mic-status--recording",
    PROCESSING:       "mic-status--processing",
    SPEAKING:         "mic-status--speaking",
    PENDING_CATEGORY: "mic-status--pending",
  }[voiceState];

  // ─── Main render ──────────────────────────────────────────────────────────
  return (
    <div className="app-shell">
      {/* ── Header ── */}
      <header className="app-header">
        <span className="app-header__logo">🔍 Where Is It?</span>
        <div className="app-header__actions">
          {/* Input mode toggle: shows mic icon when in text mode, keyboard when in voice mode */}
          <button
            id="input-mode-btn"
            className="btn btn--ghost btn--icon"
            onClick={() => {
              window.speechSynthesis?.cancel();
              setInputMode(m => m === "voice" ? "text" : "voice");
              setVoiceState("IDLE");
              // Focus text input after switching to text mode
              if (inputMode === "voice") {
                setTimeout(() => textInputRef.current?.focus(), 100);
              }
            }}
            aria-label={inputMode === "voice" ? "Switch to keyboard input" : "Switch to voice input"}
            title={inputMode === "voice" ? "Switch to keyboard" : "Switch to microphone"}
          >
            {inputMode === "voice" ? "⌨️" : "🎙"}
          </button>
          <button
            id="help-btn"
            className="btn btn--ghost btn--icon"
            onClick={() => setShowHelp(true)}
            aria-label="Voice Help Guide"
            title="Voice Help Guide"
          >
            ❓
          </button>
          <button
            id="cost-btn"
            className="btn btn--ghost btn--icon"
            onClick={() => setShowCost(true)}
            aria-label="API Usage & Costs"
            title="API Usage & Costs"
          >
            📊
          </button>
          <button
            id="inventory-btn"
            className="btn btn--ghost btn--icon"
            onClick={() => setShowInventory(true)}
            aria-label="Show Inventory Table"
            title="Show Inventory Table"
          >
            📦
          </button>
          {deferredPrompt && (
            <button
              id="install-pwa-btn"
              className="btn btn--ghost btn--icon"
              onClick={handleInstallApp}
              aria-label="Install App as PWA"
              title="Install App as PWA on Mobile / Desktop"
            >
              📲
            </button>
          )}
          <button
            id="settings-btn"
            className="btn btn--ghost btn--icon"
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
            title="Settings"
          >
            ⚙️
          </button>
          <button
            id="signout-btn"
            className="btn btn--ghost btn--icon"
            onClick={signOut}
            aria-label="Sign out"
            title="Sign out"
          >
            🚪
          </button>
        </div>
      </header>

      {/* ── Main layout ── */}
      <main className="app-main">

        {/* ── Sidebar / conversation log ── */}
        <aside className="app-sidebar" style={{ display: "flex", flexDirection: "column" }}>
          <div
            ref={logRef}
            className="conversation-log"
            aria-live="polite"
            aria-label="Conversation history"
          >
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state__icon">💬</div>
                <p className="empty-state__text">
                  {inputMode === "voice"
                    ? <>{"Tap the mic and say something like:"}<br /><em>&quot;I put my passport in the top drawer&quot;</em></>
                    : <>{"Type something like:"}<br /><em>&quot;Where is my passport?&quot;</em></>}
                </p>
              </div>
            ) : (
              messages.map(msg => (
                <div
                  key={msg.id}
                  className={`message-bubble message-bubble--${msg.role}`}
                >
                  <div className="message-bubble__label">
                    {msg.role === "user" ? "🗣 You" : "🤖 Where Is It?"}
                  </div>
                  {msg.text}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ── Main panel ── */}
        <section className="app-panel" style={{
          display:        "flex",
          flexDirection:  "column",
          alignItems:     "center",
          justifyContent: results.length > 0 ? "flex-start" : "center",
          overflowY:      "auto",
        }}>
          {/* Results */}
          {results.length > 0 && (
            <div className="results-section" style={{ width: "100%", maxWidth: 480 }}>
              <p className="results-title">📍 Results ({results.length})</p>
              {results.map(item => (
                <div key={item.id} className="glass item-card">
                  <div className="item-card__header">
                    <div className="item-card__icon" aria-hidden>
                      {categoryEmoji(item.category)}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="item-card__name">{item.name}</div>
                      <div className="item-card__badges">
                        {item.category && (
                          <span className="badge badge--category">
                            {item.category}
                          </span>
                        )}
                        {item.subcategory && (
                          <span className="badge badge--subcategory">
                            {item.subcategory}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="item-card__location">
                    📍{" "}
                    {item.location.split(/\s*[>→]\s*/).map((crumb, i, arr) => (
                      <span key={i} className="location-crumb">
                        {crumb}
                        {i < arr.length - 1 && (
                          <span className="location-sep">›</span>
                        )}
                      </span>
                    ))}
                  </div>
                  {item.notes && (
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--clr-text-3)" }}>
                      {item.notes}
                    </div>
                  )}
                  {item.hybrid_score !== undefined && (
                    <div className="item-card__score">
                      Match: {Math.round(item.hybrid_score * 100)}%
                    </div>
                  )}
                </div>
              ))}
              <button
                className="btn btn--ghost"
                style={{ alignSelf: "center", marginTop: "0.5rem" }}
                onClick={() => setResults([])}
              >
                Clear results
              </button>
            </div>
          )}

          {/* Pending category banner */}
          {voiceState === "PENDING_CATEGORY" && pendingState && (
            <div className="glass" style={{
              padding:      "1rem",
              marginBottom: "1rem",
              borderColor:  "rgba(251,191,36,0.4)",
              background:   "rgba(251,191,36,0.08)",
              maxWidth:     480,
              width:        "100%",
              textAlign:    "center",
              color:        "var(--clr-warning)",
              fontSize:     "var(--text-sm)",
            }}>
              ⚠️ What category and subcategory for <strong>&quot;{pendingState.item_name}&quot;</strong>?
            </div>
          )}

          {inputMode === "voice" ? (
            /* ── Voice / Mic panel ── */
            <div className="mic-section">
              <div className="mic-wrapper">
                <div className={`mic-ring mic-ring--1 ${
                  voiceState === "RECORDING" ? "mic-btn--recording" :
                  voiceState === "PROCESSING" ? "mic-btn--processing" : ""
                }`} />
                <div className={`mic-ring mic-ring--2 ${
                  voiceState === "RECORDING" ? "mic-btn--recording" : ""
                }`} />
                <button
                  id="mic-btn"
                  className={micClass}
                  onClick={handleMicPress}
                  disabled={voiceState === "PROCESSING" || voiceState === "SPEAKING"}
                  aria-label={voiceState === "RECORDING" ? "Stop recording" : "Start recording"}
                  aria-pressed={voiceState === "RECORDING"}
                >
                  <span style={{ fontSize: "1.75rem" }} aria-hidden>{micIcon}</span>
                </button>
              </div>

              <p className={`mic-status ${statusClass}`} aria-live="polite">
                {statusText}
              </p>

              <p style={{ fontSize: "var(--text-xs)", color: "var(--clr-text-3)", marginTop: "-0.5rem" }}>
                Model: {openaiModel}
              </p>
            </div>
          ) : (
            /* ── Text input panel ── */
            <div className="mic-section" style={{ width: "100%", maxWidth: 480, padding: "0 1rem" }}>
              <div style={{
                display:       "flex",
                flexDirection: "column",
                alignItems:    "center",
                gap:           "1rem",
                width:         "100%",
              }}>
                {/* Big keyboard tap-target */}
                <button
                  id="keyboard-open-btn"
                  className="mic-btn"
                  onClick={() => textInputRef.current?.focus()}
                  disabled={isSubmitting || voiceState === "SPEAKING"}
                  aria-label="Open keyboard"
                  title="Tap to open keyboard"
                  style={{ fontSize: "2rem" }}
                >
                  ⌨️
                </button>
                <p className="mic-status" aria-live="polite">
                  {isSubmitting ? "Processing…" : voiceState === "SPEAKING" ? "Speaking…" : "Tap to type"}
                </p>

                {/* Text input + send */}
                <form
                  onSubmit={e => { e.preventDefault(); processText(textInput); }}
                  style={{ display: "flex", gap: "0.5rem", width: "100%" }}
                >
                  <textarea
                    ref={textInputRef}
                    id="text-input"
                    className="form-input"
                    rows={2}
                    placeholder={pendingState ? `Category for "${pendingState.item_name}"…` : "Type your statement or question…"}
                    value={textInput}
                    onChange={e => setTextInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        processText(textInput);
                      }
                    }}
                    disabled={isSubmitting || voiceState === "SPEAKING"}
                    style={{ flex: 1, resize: "none" }}
                  />
                  <button
                    id="text-send-btn"
                    type="submit"
                    className="btn btn--primary"
                    disabled={!textInput.trim() || isSubmitting || voiceState === "SPEAKING"}
                    style={{ alignSelf: "stretch", padding: "0 1.25rem" }}
                  >
                    {isSubmitting ? <span className="spinner" /> : "➤"}
                  </button>
                </form>

                <p style={{ fontSize: "var(--text-xs)", color: "var(--clr-text-3)" }}>
                  Press Enter or ➤ to submit · Shift+Enter for new line
                </p>
              </div>
            </div>
          )}
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="app-footer" style={{ flexDirection: "column", gap: "0.25rem", padding: "0.5rem 1rem" }}>
        <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center" }}>
          <span className="app-footer__version">{VERSION_LABEL}</span>
          <div className="app-footer__status">
            <div className={`status-dot ${isOnline ? "" : "status-dot--offline"}`} />
            <span>{isOnline ? "Online" : "Offline"}</span>
          </div>
          <span style={{ color: "var(--clr-text-3)" }}>
            {user.email?.split("@")[0] ?? "User"}
          </span>
        </div>

        {/* AI usage stats bar */}
        <div style={{
          width: "100%",
          textAlign: "center",
          fontSize: "0.72rem",
          color: "var(--clr-text-3)",
          borderTop: "1px solid rgba(255,255,255,0.06)",
          paddingTop: "0.25rem",
          letterSpacing: "0.02em"
        }}>
          🤖 AI Usage: {aiUsageStats ? (
            <>
              {aiUsageStats.action ? <strong>{aiUsageStats.action}</strong> : ""}
              {aiUsageStats.tokens ? ` • ${aiUsageStats.tokens.toLocaleString()} tokens` : ""}
              {aiUsageStats.cost != null && aiUsageStats.cost > 0
                ? ` • ~$${aiUsageStats.cost.toFixed(6)}`
                : ""}
              {aiUsageStats.elapsedMs ? ` • ${aiUsageStats.elapsedMs}ms` : ""}
            </>
          ) : (
            "Ready"
          )}
        </div>
      </footer>

      {/* ── Settings modal ── */}
      {showSettings && (
        <SettingsModal
          userId={user.id}
          currentModel={openaiModel}
          currentCustomPrompt={customPrompt}
          currentMinMatchScore={minMatchScore}
          deferredPrompt={deferredPrompt}
          isStandalone={isStandalone}
          onInstallApp={handleInstallApp}
          onSave={(m, p, s) => {
            setOpenaiModel(m);
            setCustomPrompt(p);
            setMinMatchScore(s);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* ── Help guide modal ── */}
      {showHelp && (
        <HelpModal onClose={() => setShowHelp(false)} />
      )}

      {/* ── Cost & Rates modal ── */}
      {showCost && (
        <CostModal userId={user.id} onClose={() => setShowCost(false)} />
      )}

      {/* ── Inventory modal ── */}
      {showInventory && (
        <InventoryModal
          userId={user.id}
          initialItems={inventoryItems}
          onClose={() => setShowInventory(false)}
          onItemsUpdated={(updated) => {
            setInventoryItems(updated);
            setResults(updated.slice(0, 10));
          }}
        />
      )}
    </div>
  );
}

// =============================================================================
// COST & RATES MODAL
// =============================================================================
const MODEL_RATE_ROWS = [
  // Prices from OpenAI pricing page — USD per 1,000 tokens (per-1M ÷ 1000)
  { model: "gpt-5.4-nano",           label: "GPT-5.4 Nano (Default)",   prompt: 0.0002,   completion: 0.00125 },
  { model: "gpt-5.4-mini",           label: "GPT-5.4 Mini",             prompt: 0.00075,  completion: 0.0045  },
  { model: "gpt-5.4",                label: "GPT-5.4",                  prompt: 0.0025,   completion: 0.015   },
  { model: "gpt-5.4-pro",            label: "GPT-5.4 Pro",              prompt: 0.030,    completion: 0.180   },
  { model: "gpt-5.5",                label: "GPT-5.5",                  prompt: 0.005,    completion: 0.030   },
  { model: "gpt-5.5-pro",            label: "GPT-5.5 Pro",              prompt: 0.030,    completion: 0.180   },
  { model: "gpt-5.6-luna",           label: "GPT-5.6 Luna",             prompt: 0.0002,   completion: 0.0012  },
  { model: "gpt-5.6-terra",          label: "GPT-5.6 Terra",            prompt: 0.002,    completion: 0.012   },
  { model: "gpt-5.6-sol",            label: "GPT-5.6 Sol",              prompt: 0.005,    completion: 0.030   },
  { model: "text-embedding-3-small", label: "Embedding 3 Small",        prompt: 0.00002,  completion: 0       },
];

function CostModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const supabase = getSupabaseClient();

  // Accumulated usage stats
  const [totalCost,     setTotalCost]     = useState<number | null>(null);
  const [totalRequests, setTotalRequests] = useState<number | null>(null);
  const [totalTokens,   setTotalTokens]   = useState<number | null>(null);
  const [lastReset,     setLastReset]     = useState<string | null>(null);
  const [loadingStats,  setLoadingStats]  = useState(true);
  const [resetting,     setResetting]     = useState(false);

  // Rates form state — keyed by model
  const [rates, setRates] = useState<Record<string, { prompt: string; completion: string }>>(
    Object.fromEntries(MODEL_RATE_ROWS.map(r => [r.model, {
      prompt:     r.prompt.toString(),
      completion: r.completion.toString(),
    }]))
  );
  const [savingRates, setSavingRates] = useState(false);
  const [savedRates,  setSavedRates]  = useState(false);

  // Load current rates and accumulated stats
  useEffect(() => {
    (async () => {
      setLoadingStats(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [statsRes, ratesRes] = await Promise.all([
        (supabase as any).from("api_usage_logs").select("cost, total_tokens, created_at").eq("user_id", userId),
        (supabase as any).from("user_model_rates").select("model, prompt_cost_per_1k, completion_cost_per_1k").eq("user_id", userId),
      ]);

      if (statsRes.data?.length) {
        const logs = statsRes.data as { cost: number; total_tokens: number; created_at: string }[];
        setTotalCost(logs.reduce((s: number, r: { cost: number }) => s + (r.cost ?? 0), 0));
        setTotalTokens(logs.reduce((s: number, r: { total_tokens: number }) => s + (r.total_tokens ?? 0), 0));
        setTotalRequests(logs.length);
        const oldest = logs.reduce((earliest: string, r: { created_at: string }) =>
          !earliest || r.created_at < earliest ? r.created_at : earliest, "");
        setLastReset(oldest);
      } else {
        setTotalCost(0); setTotalTokens(0); setTotalRequests(0); setLastReset(null);
      }

      if (ratesRes.data?.length) {
        const updated = { ...rates };
        for (const row of ratesRes.data as { model: string; prompt_cost_per_1k: number; completion_cost_per_1k: number }[]) {
          if (updated[row.model]) {
            updated[row.model] = { prompt: row.prompt_cost_per_1k.toString(), completion: row.completion_cost_per_1k.toString() };
          }
        }
        setRates(updated);
      }
      setLoadingStats(false);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function handleReset() {
    if (!confirm("Reset all accumulated cost data? This cannot be undone.")) return;
    setResetting(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).rpc("reset_user_cost", { p_user_id: userId });
    setTotalCost(0); setTotalTokens(0); setTotalRequests(0); setLastReset(null);
    setResetting(false);
  }

  async function handleSaveRates() {
    setSavingRates(true);
    const rows = MODEL_RATE_ROWS.map(r => ({
      user_id:                userId,
      model:                  r.model,
      prompt_cost_per_1k:     parseFloat(rates[r.model]?.prompt  ?? "0") || 0,
      completion_cost_per_1k: parseFloat(rates[r.model]?.completion ?? "0") || 0,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("user_model_rates").upsert(rows, { onConflict: "user_id,model" });
    setSavingRates(false);
    setSavedRates(true);
    setTimeout(() => setSavedRates(false), 2500);
  }

  const fmtUSD = (n: number | null) =>
    n == null ? "—" : n < 0.000001 ? "< $0.000001" : `$${n.toFixed(6)}`;

  const cellStyle: React.CSSProperties = {
    padding: "0.35rem 0.5rem",
    fontSize: "0.75rem",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.03)",
  };
  const inputStyle: React.CSSProperties = {
    width: "90px",
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: "4px",
    color: "var(--clr-text-1)",
    padding: "0.2rem 0.4rem",
    fontSize: "0.75rem",
  };

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass-strong modal-sheet" style={{ position: "relative", maxHeight: "85vh", overflowY: "auto", minWidth: 320 }}>
        <h2 className="modal-title">📊 API Usage &amp; Costs</h2>

        {/* ── Accumulated Stats ── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem", marginBottom: "1rem" }}>
          {([
            { label: "Total Spent",    value: fmtUSD(totalCost) },
            { label: "Requests",       value: totalRequests == null ? "—" : totalRequests.toLocaleString() },
            { label: "Total Tokens",   value: totalTokens   == null ? "—" : totalTokens.toLocaleString() },
          ] as const).map(({ label, value }) => (
            <div key={label} style={{ background: "rgba(255,255,255,0.05)", borderRadius: "0.5rem", padding: "0.6rem", textAlign: "center" }}>
              <div style={{ fontSize: "0.65rem", color: "var(--clr-text-3)", marginBottom: "0.2rem" }}>{label}</div>
              <div style={{ fontSize: "1rem", fontWeight: 700, color: "var(--clr-primary)" }}>
                {loadingStats ? <span className="spinner" /> : value}
              </div>
            </div>
          ))}
        </div>
        {lastReset && (
          <p style={{ fontSize: "0.7rem", color: "var(--clr-text-3)", marginBottom: "0.75rem", textAlign: "center" }}>
            Tracking since {new Date(lastReset).toLocaleDateString()}
          </p>
        )}
        <button
          id="cost-reset-btn"
          className="btn btn--ghost"
          style={{ width: "100%", marginBottom: "1.25rem", color: "#ef4444" }}
          onClick={handleReset}
          disabled={resetting || loadingStats}
        >
          {resetting ? <span className="spinner" /> : null}
          🗑 Reset Accumulated Cost
        </button>

        <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.08)", marginBottom: "1rem" }} />

        {/* ── Model Rates Table ── */}
        <h3 style={{ fontSize: "0.9rem", color: "var(--clr-text-1)", marginBottom: "0.5rem" }}>
          💰 Model Cost Rates <span style={{ fontSize: "0.7rem", color: "var(--clr-text-3)" }}>(USD per 1,000 tokens)</span>
        </h3>
        <div style={{ overflowX: "auto", marginBottom: "1rem" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...cellStyle, textAlign: "left", color: "var(--clr-text-2)" }}>Model</th>
                <th style={{ ...cellStyle, textAlign: "right", color: "var(--clr-text-2)" }}>Input $/1k</th>
                <th style={{ ...cellStyle, textAlign: "right", color: "var(--clr-text-2)" }}>Output $/1k</th>
              </tr>
            </thead>
            <tbody>
              {MODEL_RATE_ROWS.map(row => (
                <tr key={row.model}>
                  <td style={{ ...cellStyle, color: "var(--clr-text-1)" }}>{row.label}</td>
                  <td style={{ ...cellStyle, textAlign: "right" }}>
                    <input
                      type="number"
                      step="0.000001"
                      min="0"
                      style={inputStyle}
                      value={rates[row.model]?.prompt ?? ""}
                      onChange={e => setRates(r => ({ ...r, [row.model]: { ...r[row.model], prompt: e.target.value } }))}
                    />
                  </td>
                  <td style={{ ...cellStyle, textAlign: "right" }}>
                    <input
                      type="number"
                      step="0.000001"
                      min="0"
                      style={inputStyle}
                      value={rates[row.model]?.completion ?? ""}
                      onChange={e => setRates(r => ({ ...r, [row.model]: { ...r[row.model], completion: e.target.value } }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button className="btn btn--ghost" style={{ flex: 1 }} onClick={onClose}>Close</button>
          <button
            id="rates-save-btn"
            className="btn btn--primary"
            style={{ flex: 2 }}
            onClick={handleSaveRates}
            disabled={savingRates}
          >
            {savingRates ? <span className="spinner" /> : null}
            {savedRates ? "✓ Saved!" : savingRates ? "Saving…" : "Save Rates"}
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// INVENTORY MODAL (Category & Subcategory Table with Pencil Edit)
// =============================================================================
function InventoryModal({
  userId,
  initialItems,
  onClose,
  onItemsUpdated,
}: {
  userId: string;
  initialItems?: ItemResult[];
  onClose: () => void;
  onItemsUpdated?: (items: ItemResult[]) => void;
}) {
  const supabase = getSupabaseClient();
  const [items, setItems]         = useState<ItemResult[]>(initialItems ?? []);
  const [loading, setLoading]     = useState<boolean>(!initialItems?.length);
  const [filterText, setFilterText] = useState("");
  const [editingItem, setEditingItem] = useState<ItemResult | null>(null);
  const [deletingId, setDeletingId]   = useState<string | null>(null);

  const handleDeleteItem = useCallback(async (item: ItemResult) => {
    if (!confirm(`Are you sure you want to delete "${item.name}" from your inventory?`)) return;

    setDeletingId(item.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("items")
      .delete()
      .eq("id", item.id)
      .eq("user_id", userId);

    if (error) {
      console.error("Delete item failed:", error.message);
      alert(`Failed to delete "${item.name}". Please try again.`);
    } else {
      setItems(prev => {
        const next = prev.filter(i => i.id !== item.id);
        onItemsUpdated?.(next);
        return next;
      });
    }
    setDeletingId(null);
  }, [supabase, userId, onItemsUpdated]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from("items")
      .select()
      .eq("user_id", userId)
      .order("category", { ascending: true })
      .order("subcategory", { ascending: true })
      .order("name", { ascending: true });

    if (!error && data) {
      setItems(data as ItemResult[]);
      onItemsUpdated?.(data as ItemResult[]);
    }
    setLoading(false);
  }, [supabase, userId, onItemsUpdated]);

  useEffect(() => {
    if (!initialItems?.length) {
      fetchItems();
    }
  }, [initialItems, fetchItems]);

  const filteredItems = items.filter(item => {
    if (!filterText.trim()) return true;
    const q = filterText.toLowerCase();
    return (
      item.name.toLowerCase().includes(q) ||
      (item.category && item.category.toLowerCase().includes(q)) ||
      (item.subcategory && item.subcategory.toLowerCase().includes(q)) ||
      item.location.toLowerCase().includes(q) ||
      (item.notes && item.notes.toLowerCase().includes(q))
    );
  });

  // Group filtered items by Category → Subcategory
  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, ItemResult[]>>();
    for (const item of filteredItems) {
      const cat = item.category?.trim() || "Uncategorized";
      const sub = item.subcategory?.trim() || "General";
      if (!map.has(cat)) map.set(cat, new Map());
      const subMap = map.get(cat)!;
      if (!subMap.has(sub)) subMap.set(sub, []);
      subMap.get(sub)!.push(item);
    }
    return map;
  }, [filteredItems]);

  const cellStyle: React.CSSProperties = {
    padding: "0.45rem 0.6rem",
    fontSize: "0.8rem",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
    color: "var(--clr-text-1)",
    verticalAlign: "middle",
  };

  const headerStyle: React.CSSProperties = {
    ...cellStyle,
    fontWeight: 600,
    color: "var(--clr-text-2)",
    background: "rgba(255,255,255,0.04)",
    fontSize: "0.75rem",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
  };

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="glass-strong modal-sheet"
        style={{
          position: "relative",
          maxWidth: "920px",
          width: "95%",
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 className="modal-title" style={{ margin: 0 }}>
            📦 Inventory ({items.length} {items.length === 1 ? "item" : "items"})
          </h2>
          <button className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">✖</button>
        </div>

        {/* Filter input */}
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            type="text"
            placeholder="🔎 Search inventory by name, location, category..."
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
            style={{
              flex: 1,
              background: "rgba(255,255,255,0.07)",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: "6px",
              color: "var(--clr-text-1)",
              padding: "0.4rem 0.75rem",
              fontSize: "0.85rem",
            }}
          />
          <button className="btn btn--ghost" onClick={fetchItems} disabled={loading} title="Refresh inventory">
            {loading ? <span className="spinner" /> : "🔄"}
          </button>
        </div>

        {/* Table Container */}
        <div style={{ flex: 1, overflowY: "auto", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px" }}>
          {loading ? (
            <div style={{ padding: "2rem", textAlign: "center", color: "var(--clr-text-3)" }}>
              <span className="spinner" /> Loading inventory...
            </div>
          ) : filteredItems.length === 0 ? (
            <div style={{ padding: "2rem", textAlign: "center", color: "var(--clr-text-3)" }}>
              {filterText ? "No matching items found." : "Inventory is currently empty."}
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
              <thead>
                <tr>
                  <th style={{ ...headerStyle, width: "25%" }}>Item Name</th>
                  <th style={{ ...headerStyle, width: "20%" }}>Category</th>
                  <th style={{ ...headerStyle, width: "18%" }}>Subcategory</th>
                  <th style={{ ...headerStyle, width: "22%" }}>Location</th>
                  <th style={{ ...headerStyle, width: "15%", textAlign: "center" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(grouped.entries()).map(([cat, subMap]: [string, Map<string, ItemResult[]>]) => (
                  <Fragment key={cat}>
                    {/* Category Header Row */}
                    <tr>
                      <td
                        colSpan={5}
                        style={{
                          padding: "0.4rem 0.6rem",
                          background: "rgba(99, 102, 241, 0.15)",
                          color: "var(--clr-primary)",
                          fontWeight: 700,
                          fontSize: "0.85rem",
                          borderBottom: "1px solid rgba(255,255,255,0.1)",
                        }}
                      >
                        {categoryEmoji(cat)} {cat}
                      </td>
                    </tr>
                    {Array.from(subMap.entries()).map(([sub, subItems]: [string, ItemResult[]]) => (
                      <Fragment key={`${cat}-${sub}`}>
                        {subItems.map((item: ItemResult) => (
                          <tr key={item.id} style={{ transition: "background 0.15s" }}>
                            <td style={{ ...cellStyle, fontWeight: 500 }}>{item.name}</td>
                            <td style={{ ...cellStyle, color: "var(--clr-text-2)" }}>{item.category || "—"}</td>
                            <td style={{ ...cellStyle, color: "var(--clr-text-2)" }}>{item.subcategory || "—"}</td>
                            <td style={{ ...cellStyle, color: "var(--clr-text-1)" }}>📍 {item.location}</td>
                            <td style={{ ...cellStyle, textAlign: "center", whiteSpace: "nowrap" }}>
                              <button
                                id={`edit-item-btn-${item.id}`}
                                className="btn btn--ghost btn--icon"
                                onClick={() => setEditingItem(item)}
                                title={`Edit ${item.name}`}
                                style={{ padding: "0.2rem 0.4rem", fontSize: "0.85rem", marginRight: "0.2rem" }}
                              >
                                ✏️
                              </button>
                              <button
                                id={`delete-item-btn-${item.id}`}
                                className="btn btn--ghost btn--icon"
                                onClick={() => handleDeleteItem(item)}
                                disabled={deletingId === item.id}
                                title={`Delete ${item.name}`}
                                style={{ padding: "0.2rem 0.4rem", fontSize: "0.85rem", color: "#ef4444" }}
                              >
                                {deletingId === item.id ? <span className="spinner" /> : "🗑️"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn btn--ghost" onClick={onClose}>Close</button>
        </div>
      </div>

      {/* Edit Item Modal */}
      {editingItem && (
        <EditItemModal
          userId={userId}
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSaved={(updated) => {
            setItems(prev => prev.map(i => i.id === updated.id ? updated : i));
            setEditingItem(null);
            onItemsUpdated?.(items.map(i => i.id === updated.id ? updated : i));
          }}
          onDeleted={(deletedId) => {
            setItems(prev => prev.filter(i => i.id !== deletedId));
            setEditingItem(null);
            onItemsUpdated?.(items.filter(i => i.id !== deletedId));
          }}
        />
      )}
    </div>
  );
}

// =============================================================================
// EDIT ITEM MODAL
// =============================================================================
function EditItemModal({
  userId,
  item,
  onClose,
  onSaved,
  onDeleted,
}: {
  userId: string;
  item: ItemResult;
  onClose: () => void;
  onSaved: (updatedItem: ItemResult) => void;
  onDeleted: (deletedId: string) => void;
}) {
  const supabase = getSupabaseClient();
  const [name, setName]               = useState(item.name);
  const [category, setCategory]       = useState(item.category ?? "");
  const [subcategory, setSubcategory] = useState(item.subcategory ?? "");
  const [location, setLocation]       = useState(item.location);
  const [notes, setNotes]             = useState(item.notes ?? "");
  const [saving, setSaving]           = useState(false);
  const [deleting, setDeleting]       = useState(false);
  const [errorMsg, setErrorMsg]       = useState<string | null>(null);

  async function handleDelete() {
    if (!confirm(`Are you sure you want to delete "${item.name}" from your inventory?`)) return;
    setDeleting(true);
    setErrorMsg(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("items")
      .delete()
      .eq("id", item.id)
      .eq("user_id", userId);

    if (error) {
      console.error("Delete item failed:", error.message);
      setErrorMsg("Failed to delete item. Please try again.");
      setDeleting(false);
    } else {
      onDeleted(item.id);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !location.trim()) {
      setErrorMsg("Item name and location are required.");
      return;
    }
    setSaving(true);
    setErrorMsg(null);

    const updatedPayload = {
      name:        name.trim(),
      category:    category.trim() || null,
      subcategory: subcategory.trim() || null,
      location:    location.trim(),
      notes:       notes.trim() || null,
      updated_at:  new Date().toISOString(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from("items")
      .update(updatedPayload)
      .eq("id", item.id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) {
      console.error("Edit item failed:", error.message);
      setErrorMsg("Failed to save changes. Please try again.");
      setSaving(false);
    } else {
      onSaved(data as ItemResult);
    }
  }

  const labelStyle: React.CSSProperties = {
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "var(--clr-text-2)",
    marginBottom: "0.2rem",
    display: "block",
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: "6px",
    color: "var(--clr-text-1)",
    padding: "0.4rem 0.6rem",
    fontSize: "0.85rem",
  };

  return (
    <div className="modal-overlay" style={{ zIndex: 1100 }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass-strong modal-sheet" style={{ maxWidth: "480px", width: "90%", position: "relative" }}>
        <h2 className="modal-title">✏️ Edit Item</h2>

        {errorMsg && (
          <div style={{ color: "#ef4444", fontSize: "0.8rem", marginBottom: "0.75rem" }}>
            ⚠️ {errorMsg}
          </div>
        )}

        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div>
            <label style={labelStyle}>Item Name *</label>
            <input
              type="text"
              style={inputStyle}
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
            <div>
              <label style={labelStyle}>Category</label>
              <input
                type="text"
                style={inputStyle}
                placeholder="e.g. Tools, Documents"
                value={category}
                onChange={e => setCategory(e.target.value)}
              />
            </div>
            <div>
              <label style={labelStyle}>Subcategory</label>
              <input
                type="text"
                style={inputStyle}
                placeholder="e.g. Hand Tools, Personal"
                value={subcategory}
                onChange={e => setSubcategory(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label style={labelStyle}>Location *</label>
            <input
              type="text"
              style={inputStyle}
              placeholder="e.g. Workshop drawer #2"
              value={location}
              onChange={e => setLocation(e.target.value)}
              required
            />
          </div>

          <div>
            <label style={labelStyle}>Notes</label>
            <textarea
              style={{ ...inputStyle, minHeight: "60px", resize: "vertical" }}
              placeholder="Optional notes or details..."
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>

          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ color: "#ef4444", flex: 1 }}
              onClick={handleDelete}
              disabled={deleting || saving}
            >
              {deleting ? <span className="spinner" /> : "🗑 Delete"}
            </button>
            <button type="button" className="btn btn--ghost" style={{ flex: 1 }} onClick={onClose}>
              Cancel
            </button>
            <button
              id="save-item-btn"
              type="submit"
              className="btn btn--primary"
              style={{ flex: 2 }}
              disabled={saving || deleting}
            >
              {saving ? <span className="spinner" /> : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
