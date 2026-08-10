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

import { useEffect, useRef, useState, useCallback } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";
import { logger } from "@/lib/logger";
import { VERSION_LABEL } from "@/lib/version";
import type { User, Session } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────────────
type VoiceState =
  | "IDLE"
  | "RECORDING"
  | "PROCESSING"
  | "SPEAKING"
  | "PENDING_CATEGORY";

type ActionType =
  | "STORE"
  | "SEARCH"
  | "MOVE"
  | "REMOVE"
  | "PROVIDE_CATEGORY"
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
}

// ─── Available OpenAI models ──────────────────────────────────────────────────
const OPENAI_MODELS = [
  { value: "gpt-5.6-luna",      label: "GPT-5.6 Luna (Default)" },
  { value: "gpt-4o",            label: "GPT-4o" },
  { value: "gpt-4o-mini",       label: "GPT-4o Mini (Fastest)" },
  { value: "gpt-4-turbo",       label: "GPT-4 Turbo" },
  { value: "o1-mini",           label: "o1 Mini (Reasoning)" },
  { value: "o1-preview",        label: "o1 Preview (Advanced)" },
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
  onSave,
  onClose,
}: {
  userId:       string;
  currentModel: string;
  onSave:       (model: string) => void;
  onClose:      () => void;
}) {
  const [model,   setModel]   = useState(currentModel);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const supabase = getSupabaseClient();

  async function handleSave() {
    setSaving(true);
    logger.info("SETTINGS", "Saving model preference", { model });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any)
      .from("user_settings")
      .upsert(
        { user_id: userId, openai_model: model },
        { onConflict: "user_id" }
      ) as { error: { message: string } | null };

    if (error) {
      logger.warn("SETTINGS", "Save failed", error.message);
    } else {
      logger.info("SETTINGS", "Model saved", { model });
      setSaved(true);
      onSave(model);
      setTimeout(onClose, 800);
    }
    setSaving(false);
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass-strong modal-sheet" style={{ position: "relative" }}>
        <h2 className="modal-title">⚙️ Settings</h2>

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
              <li>&quot;Where did I leave my <strong>spare house key</strong>?&quot;</li>
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
  const [openaiModel,   setOpenaiModel]   = useState<string>("gpt-5.6-luna");
  const [showSettings,  setShowSettings]  = useState(false);
  const [showHelp,      setShowHelp]      = useState(false);
  const [isOnline,      setIsOnline]      = useState(true);
  const [aiUsageStats,  setAiUsageStats]  = useState<{
    model: string;
    elapsedMs?: number;
    tokens?: number;
    action?: string;
  } | null>(null);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const mediaRecorderRef  = useRef<MediaRecorder | null>(null);
  const audioChunksRef    = useRef<Blob[]>([]);
  const logRef            = useRef<HTMLDivElement>(null);
  const streamRef         = useRef<MediaStream | null>(null);

  // ─── Auth init ────────────────────────────────────────────────────────────
  useEffect(() => {
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

    return () => subscription.unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // ─── Speak on new system messages ────────────────────────────────────────
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === "system") {
      setVoiceState("SPEAKING");
      speak(last.text, () => setVoiceState(pendingState ? "PENDING_CATEGORY" : "IDLE"));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // ─── Load user settings ───────────────────────────────────────────────────
  async function loadUserSettings(uid: string) {
    logger.info("SETTINGS", "Loading user settings", { uid });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from("user_settings")
      .select("openai_model")
      .eq("user_id", uid)
      .single() as { data: { openai_model: string } | null };

    if (data?.openai_model) {
      setOpenaiModel(data.openai_model);
      logger.info("SETTINGS", "Model loaded", { model: data.openai_model });
    }
  }

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
        body: { transcript, pendingState },
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
      });

      // Update results list
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
                  Tap the mic and say something like:<br />
                  <em>"I put my passport in the top drawer"</em>
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

          {/* Mic button */}
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

            {/* Model indicator */}
            <p style={{
              fontSize:  "var(--text-xs)",
              color:     "var(--clr-text-3)",
              marginTop: "-0.5rem",
            }}>
              Model: {openaiModel}
            </p>
          </div>
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
              <strong>{aiUsageStats.model}</strong>
              {aiUsageStats.action ? ` • Action: ${aiUsageStats.action}` : ""}
              {aiUsageStats.tokens ? ` • ${aiUsageStats.tokens} tokens` : ""}
              {aiUsageStats.elapsedMs ? ` • ${aiUsageStats.elapsedMs}ms` : ""}
            </>
          ) : (
            `Ready (${openaiModel})`
          )}
        </div>
      </footer>

      {/* ── Settings modal ── */}
      {showSettings && (
        <SettingsModal
          userId={user.id}
          currentModel={openaiModel}
          onSave={setOpenaiModel}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* ── Help guide modal ── */}
      {showHelp && (
        <HelpModal onClose={() => setShowHelp(false)} />
      )}
    </div>
  );
}
