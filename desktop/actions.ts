import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { clipboard, Notification, app } from "electron";
import type { AppEntry, LocalCommand } from "./commandRouter";

/**
 * Execution of local device actions.
 *
 * Everything here runs on this machine, under the user's own Windows account, and only
 * for targets on the allowlist in `commandRouter.ts`. Nothing takes a shell string built
 * from model or user text: arguments are always a fixed array, so a hostile phrase cannot
 * smuggle in `& del /s` or similar.
 */

export interface DeviceOutcome {
  ok: boolean;
  /** What the assistant says back. Written to be true even when the action half-fails. */
  reply: string;
  detail: string;
  data?: unknown;
}

/** Folders searched by "find my file X". Never the whole disk: bounded and predictable. */
function searchRoots(): string[] {
  const roots: string[] = [];
  for (const name of ["documents", "desktop", "downloads"] as const) {
    try {
      roots.push(app.getPath(name));
    } catch {
      // A missing known folder is normal on a fresh Windows profile.
    }
  }
  return roots;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "appdata", "$recycle.bin", "system volume information"]);
const MAX_SCANNED = 25_000;
const MAX_DEPTH = 6;

/**
 * Bounded breadth-first filename search. It matches the *name*, not the contents: an
 * assistant that silently greps every file on the machine would be a privacy problem and
 * a very slow one.
 */
export async function searchFiles(query: string, limit: number): Promise<{ path: string; name: string }[]> {
  return searchNameInRoots(searchRoots(), query, limit);
}

/**
 * The search itself, with the roots injected — so it can be tested without Electron and
 * without touching a real user profile.
 */
export async function searchNameInRoots(
  roots: string[],
  query: string,
  limit: number
): Promise<{ path: string; name: string }[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const found: { path: string; name: string }[] = [];
  const queue: { dir: string; depth: number }[] = roots.map((dir) => ({ dir, depth: 0 }));
  let scanned = 0;

  while (queue.length && found.length < limit && scanned < MAX_SCANNED) {
    const { dir, depth } = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (scanned++ >= MAX_SCANNED || found.length >= limit) break;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name.toLowerCase())) {
          queue.push({ dir: full, depth: depth + 1 });
        }
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().includes(needle)) {
        found.push({ path: full, name: entry.name });
      }
    }
  }

  return found;
}

/**
 * Launch an allowlisted target.
 *
 * `cmd /c start "" <target>` is the Windows shell's own "open this" verb, so it resolves
 * `msedge`, protocol handlers (`whatsapp:`) and URLs the same way the Start menu does. The
 * empty `""` is the window title — without it, `start` would treat a quoted target as the
 * title and open nothing.
 */
export async function openApp(entry: AppEntry): Promise<DeviceOutcome> {
  return new Promise((resolve) => {
    try {
      const child = spawn("cmd", ["/c", "start", "", entry.target], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", (error) => {
        resolve({
          ok: false,
          reply: `I could not launch ${entry.label}: ${error.message}`,
          detail: error.message,
        });
      });
      child.unref();
      // `start` returns immediately; this confirms the request was handed to Windows, not
      // that the window is on screen. The reply is worded to match that distinction.
      resolve({
        ok: true,
        reply: `Opening ${entry.label}.`,
        detail: `Requested Windows to start "${entry.target}".`,
        data: { target: entry.target },
      });
    } catch (error) {
      resolve({
        ok: false,
        reply: `I could not launch ${entry.label}: ${(error as Error).message}`,
        detail: (error as Error).message,
      });
    }
  });
}

export function copyToClipboard(text: string): DeviceOutcome {
  clipboard.writeText(text);
  const preview = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  return {
    ok: true,
    reply: `Copied to the clipboard: “${preview}”`,
    detail: `${text.length} characters written to the clipboard.`,
  };
}

export function notify(title: string, body: string): DeviceOutcome {
  if (!Notification.isSupported()) {
    return { ok: false, reply: "Windows notifications are not available here.", detail: "unsupported" };
  }
  new Notification({ title, body }).show();
  return { ok: true, reply: `Notified: ${title}`, detail: "Notification shown." };
}

/**
 * Execute a parsed local command, or return null when it cannot be handled locally so the
 * caller can fall back to the brain.
 */
export async function runLocalCommand(command: LocalCommand): Promise<DeviceOutcome | null> {
  switch (command.kind) {
    case "open_app":
      return openApp(command.app);
    case "copy":
      return copyToClipboard(command.text);
    case "search_files": {
      const matches = await searchFiles(command.query, command.limit);
      if (!matches.length) {
        return {
          ok: true,
          reply: `I searched your Documents, Desktop and Downloads for “${command.query}” and found nothing.`,
          detail: "0 matches",
          data: [],
        };
      }
      const list = matches.map((m) => `• ${m.name}\n  ${m.path}`).join("\n");
      return {
        ok: true,
        reply: `Found ${matches.length} file${matches.length === 1 ? "" : "s"} matching “${command.query}”:\n${list}`,
        detail: `${matches.length} match(es)`,
        data: matches,
      };
    }
    default:
      return null;
  }
}
