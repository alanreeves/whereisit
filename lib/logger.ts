/**
 * lib/logger.ts
 * Structured logger for Where Is It? PWA.
 *
 * Outputs ISO-timestamped, prefixed log lines to the browser/Node console.
 * Each level maps to the corresponding console method so browser DevTools
 * can filter by severity.
 *
 * Usage:
 *   import { logger } from "@/lib/logger";
 *   logger.info("DEEPGRAM", "Transcription received", { transcript, duration });
 *   logger.error("GEMINI", "Parse failed", error);
 *
 * Log domains (first argument):
 *   MIC        - microphone activation / deactivation
 *   DEEPGRAM   - STT transcriptions
 *   OPENAI     - GPT-4 intent parsing + embedding calls
 *   DB         - Supabase database queries
 *   TTS        - SpeechSynthesis events
 *   SW         - Service Worker messages
 *   AUTH       - Login / logout / session events
 *   SETTINGS   - User settings reads / writes
 *   EDGE       - Edge Function invocations
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogDomain =
  | "MIC"
  | "DEEPGRAM"
  | "OPENAI"
  | "DB"
  | "TTS"
  | "SW"
  | "AUTH"
  | "SETTINGS"
  | "EDGE"
  | "UI"
  | string;

interface LogEntry {
  ts: string;
  level: LogLevel;
  domain: LogDomain;
  message: string;
  data?: unknown;
}

// ─── Colour map for console grouping ─────────────────────────────────────────
const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: "color:#94a3b8;font-weight:normal",
  info:  "color:#38bdf8;font-weight:bold",
  warn:  "color:#fbbf24;font-weight:bold",
  error: "color:#f87171;font-weight:bold",
};

const DOMAIN_EMOJI: Record<string, string> = {
  MIC:      "🎙",
  DEEPGRAM: "📝",
  OPENAI:   "🤖",
  DB:       "🗄",
  TTS:      "🔊",
  SW:       "⚙️",
  AUTH:     "🔑",
  SETTINGS: "⚙",
  EDGE:     "🌐",
  UI:       "🖥",
};

// ─── In-memory ring buffer (last 500 entries, useful for bug reports) ─────────
const MAX_BUFFER = 500;
const _buffer: LogEntry[] = [];

function getBuffer(): Readonly<LogEntry[]> {
  return _buffer;
}

// ─── Core log function ────────────────────────────────────────────────────────
function log(level: LogLevel, domain: LogDomain, message: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const entry: LogEntry = { ts, level, domain, message, data };

  // Maintain ring buffer
  _buffer.push(entry);
  if (_buffer.length > MAX_BUFFER) _buffer.shift();

  const emoji  = DOMAIN_EMOJI[domain] ?? "▪";
  const prefix = `%c[${ts}] ${emoji} ${domain}`;
  const style  = LEVEL_STYLE[level];
  const text   = ` ${message}`;

  if (data !== undefined) {
    switch (level) {
      case "debug": console.debug(prefix, style, text, data); break;
      case "info":  console.info (prefix, style, text, data); break;
      case "warn":  console.warn (prefix, style, text, data); break;
      case "error": console.error(prefix, style, text, data); break;
    }
  } else {
    switch (level) {
      case "debug": console.debug(prefix, style, text); break;
      case "info":  console.info (prefix, style, text); break;
      case "warn":  console.warn (prefix, style, text); break;
      case "error": console.error(prefix, style, text); break;
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
export const logger = {
  debug: (domain: LogDomain, message: string, data?: unknown) =>
    log("debug", domain, message, data),
  info:  (domain: LogDomain, message: string, data?: unknown) =>
    log("info",  domain, message, data),
  warn:  (domain: LogDomain, message: string, data?: unknown) =>
    log("warn",  domain, message, data),
  error: (domain: LogDomain, message: string, data?: unknown) =>
    log("error", domain, message, data),

  /** Returns a snapshot of the in-memory log buffer (useful for bug reports). */
  getBuffer,

  /** Downloads the buffer as a .json file (browser only). */
  exportBuffer(): void {
    if (typeof window === "undefined") return;
    const blob = new Blob([JSON.stringify(_buffer, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href     = url;
    a.download = `where-is-it-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },
} as const;
