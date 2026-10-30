/**
 * Local command router — the Siri-like fast path.
 *
 * A spoken "open Spotify" should not need a round-trip to a language model: it is a
 * literal instruction the device can perform in milliseconds, and it must still work
 * when the network is down. This module parses those utterances into a small set of
 * typed commands.
 *
 * It imports nothing (no Electron, no Node) so it can be unit-tested directly, and it is
 * deliberately conservative: a phrase that does not match exactly falls through to the
 * brain instead of being guessed at.
 */

export interface AppEntry {
  /** Stable identifier used in logs and confirmations. */
  id: string;
  /** What the assistant calls it back to the user. */
  label: string;
  /** Extra words the user may say ("browser", "editor", ...). */
  aliases: string[];
  /** Fixed launch target. Never built from user text — that is how injection happens. */
  target: string;
  kind: "exe" | "uri";
}

/**
 * The allowlist. Nothing outside this list can be launched, and no entry takes
 * arguments, so a model or a mistyped phrase cannot turn "open" into a shell command.
 * Windows ships most of these; the browser entries degrade to the default browser.
 */
export const APP_ALLOWLIST: AppEntry[] = [
  { id: "chrome", label: "Google Chrome", aliases: ["chrome", "google chrome"], target: "chrome", kind: "exe" },
  { id: "edge", label: "Microsoft Edge", aliases: ["edge", "microsoft edge"], target: "msedge", kind: "exe" },
  { id: "firefox", label: "Firefox", aliases: ["firefox", "mozilla firefox"], target: "firefox", kind: "exe" },
  { id: "notepad", label: "Notepad", aliases: ["notepad", "text editor"], target: "notepad", kind: "exe" },
  { id: "explorer", label: "File Explorer", aliases: ["explorer", "file explorer", "files", "my files"], target: "explorer", kind: "exe" },
  { id: "terminal", label: "Terminal", aliases: ["terminal", "command prompt", "cmd", "powershell"], target: "wt", kind: "exe" },
  { id: "calculator", label: "Calculator", aliases: ["calculator", "calc"], target: "calc", kind: "exe" },
  { id: "settings", label: "Windows Settings", aliases: ["settings", "windows settings"], target: "ms-settings:", kind: "uri" },
  { id: "camera", label: "Camera", aliases: ["camera"], target: "microsoft.windows.camera:", kind: "uri" },
  { id: "spotify", label: "Spotify", aliases: ["spotify", "music"], target: "spotify", kind: "exe" },
  { id: "vscode", label: "VS Code", aliases: ["vs code", "vscode", "code", "visual studio code"], target: "code", kind: "exe" },
  { id: "word", label: "Word", aliases: ["word", "microsoft word"], target: "winword", kind: "exe" },
  { id: "excel", label: "Excel", aliases: ["excel", "microsoft excel"], target: "excel", kind: "exe" },
  { id: "powerpoint", label: "PowerPoint", aliases: ["powerpoint", "microsoft powerpoint"], target: "powerpnt", kind: "exe" },
  { id: "paint", label: "Paint", aliases: ["paint", "mspaint"], target: "mspaint", kind: "exe" },
  { id: "snipping", label: "Snipping Tool", aliases: ["snipping tool", "screenshot tool"], target: "ms-screenclip:", kind: "uri" },
  { id: "whatsapp", label: "WhatsApp", aliases: ["whatsapp", "whatsapp desktop"], target: "whatsapp:", kind: "uri" },
  { id: "telegram", label: "Telegram", aliases: ["telegram"], target: "tg:", kind: "uri" },
  { id: "instagram", label: "Instagram", aliases: ["instagram", "insta"], target: "https://www.instagram.com", kind: "uri" },
  { id: "youtube", label: "YouTube", aliases: ["youtube"], target: "https://www.youtube.com", kind: "uri" },
  { id: "gmail", label: "Gmail", aliases: ["gmail", "my email", "email"], target: "https://mail.google.com", kind: "uri" },
];

export type LocalCommand =
  | { kind: "open_app"; app: AppEntry; spokenAs: string }
  | { kind: "search_files"; query: string; limit: number }
  | { kind: "copy"; text: string }
  | { kind: "none" };

export const NO_COMMAND: LocalCommand = { kind: "none" };
export const DEFAULT_FILE_LIMIT = 12;

/** Resolve a spoken app name against the allowlist (case-insensitive, alias-aware). */
export function resolveApp(name: string): AppEntry | null {
  const needle = name
    .trim()
    .toLowerCase()
    .replace(/[.?!]+$/, "")
    .replace(/^the\s+/, "");
  if (!needle) return null;

  const exact = APP_ALLOWLIST.find(
    (app) => app.id === needle || app.aliases.includes(needle) || app.label.toLowerCase() === needle
  );
  if (exact) return exact;

  // "open the chrome browser" — allow a trailing noun, but never guess at a mismatch.
  const stripped = needle.replace(/\s+(app|application|browser|window)$/, "").trim();
  if (stripped !== needle) {
    return (
      APP_ALLOWLIST.find(
        (app) => app.id === stripped || app.aliases.includes(stripped) || app.label.toLowerCase() === stripped
      ) ?? null
    );
  }
  return null;
}

/**
 * Strip wake words and politeness so "Hey JARVIS, please open Chrome" routes the same as
 * "open chrome".
 */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^(?:hey\s+|ok\s+|hi\s+)?jarvis[\s,]+/i, "")
    .replace(/^(?:please|kindly)\s+/i, "")
    .replace(/\s+(?:please|for me|now)$/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

/**
 * Parse one utterance. Returns `{kind:"none"}` for anything ambiguous, which sends the
 * request to the brain exactly as before.
 */
export function parseLocalCommand(raw: string): LocalCommand {
  if (typeof raw !== "string") return NO_COMMAND;
  const text = normalize(raw);
  if (!text) return NO_COMMAND;

  // ---- clipboard -------------------------------------------------------------------
  const copyMatch =
    /^copy\s+(.+?)\s+(?:to|into)\s+(?:the\s+)?clipboard$/i.exec(text) ??
    /^(?:put|set)\s+(.+?)\s+(?:on|in)\s+(?:the\s+)?clipboard$/i.exec(text);
  if (copyMatch) {
    const copied = copyMatch[1].trim();
    if (copied && copied.length <= 20_000) return { kind: "copy", text: copyMatch[1].trim() };
    return NO_COMMAND;
  }

  // ---- file search -----------------------------------------------------------------
  const fileMatch =
    /^(?:search|look through|find)\s+(?:my\s+)?(?:files?|documents?)\s+(?:for\s+)?(.+)$/i.exec(text) ??
    /^find\s+(?:me\s+)?(?:the\s+)?(?:file|document)\s+(?:called\s+|named\s+)?(.+)$/i.exec(text) ??
    /^(?:where\s+is|locate)\s+(?:the\s+)?(?:file\s+)?(.+?)(?:\s+on\s+(?:my\s+)?(?:pc|computer|disk))?$/i.exec(
      text
    );
  if (fileMatch) {
    // "where is spotify" is an app question, not a file search.
    const query = fileMatch[1]
      .replace(/\s+(?:on|in)\s+my\s+(?:pc|computer|files|documents)$/i, "")
      .trim();
    if (query && query.length >= 2 && !resolveApp(query)) {
      return { kind: "search_files", query, limit: DEFAULT_FILE_LIMIT };
    }
    return NO_COMMAND;
  }

  // ---- open / launch ----------------------------------------------------------------
  const openMatch = /^(?:open|launch|start|run|bring up|pull up)\s+(.+)$/i.exec(text);
  if (openMatch) {
    const app = resolveApp(openMatch[1]);
    // Unknown app → not a local command. Guessing "open <anything>" would mean spawning
    // whatever the model wrote, which is exactly the injection surface to avoid.
    if (!app) return NO_COMMAND;
    return { kind: "open_app", app, spokenAs: openMatch[1].trim() };
  }

  return NO_COMMAND;
}

/** One-line description used in the UI and in the assistant's spoken confirmation. */
export function describeCommand(command: LocalCommand): string {
  switch (command.kind) {
    case "open_app":
      return `Open ${command.app.label}`;
    case "search_files":
      return `Search files for "${command.query}"`;
    case "copy":
      return "Copy text to the clipboard";
    default:
      return "Ask the brain";
  }
}
