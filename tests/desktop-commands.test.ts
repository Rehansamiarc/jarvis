import { describe, expect, it } from "vitest";
import {
  APP_ALLOWLIST,
  describeCommand,
  parseLocalCommand,
  resolveApp,
} from "../desktop/commandRouter";

describe("local command router", () => {
  it("opens an allowlisted app, ignoring wake word and politeness", () => {
    for (const phrase of [
      "open chrome",
      "Open Chrome.",
      "Hey JARVIS, open chrome",
      "jarvis please open chrome",
      "launch chrome for me",
      "bring up chrome",
    ]) {
      const command = parseLocalCommand(phrase);
      expect(command.kind, phrase).toBe("open_app");
      if (command.kind === "open_app") expect(command.app.id).toBe("chrome");
    }
  });

  it("resolves aliases and a trailing noun", () => {
    expect(resolveApp("vs code")?.id).toBe("vscode");
    expect(resolveApp("the settings app")?.id).toBe("settings");
    expect(resolveApp("the chrome browser")?.id).toBe("chrome");
    expect(resolveApp("whatsapp desktop")?.id).toBe("whatsapp");
    // A bare "browser" is ambiguous, so it is left to the brain rather than guessed.
    expect(resolveApp("browser")).toBeNull();
  });

  it("refuses to invent an app that is not on the allowlist", () => {
    // This is the injection boundary: "open <anything>" must never become a spawn.
    for (const phrase of [
      "open cmd /c del /s C:\\",
      "open https://evil.example/payload.exe",
      "launch ../../windows/system32/calc.exe",
      "open some random program",
    ]) {
      expect(parseLocalCommand(phrase).kind, phrase).toBe("none");
    }
  });

  it("searches files only for an explicit file phrase", () => {
    const a = parseLocalCommand("search my files for tax return");
    expect(a).toEqual({ kind: "search_files", query: "tax return", limit: 12 });

    const b = parseLocalCommand("find the file called invoice-2026.pdf");
    expect(b.kind).toBe("search_files");
    if (b.kind === "search_files") expect(b.query).toBe("invoice-2026.pdf");

    // "where is chrome" is an app, not a file search.
    expect(parseLocalCommand("where is chrome").kind).toBe("none");
  });

  it("copies text to the clipboard", () => {
    const command = parseLocalCommand("copy hello world to the clipboard");
    expect(command).toEqual({ kind: "copy", text: "hello world" });
  });

  it("leaves ordinary conversation to the brain", () => {
    for (const phrase of [
      "what is the weather in Paris",
      "draft an email to my landlord about the leak",
      "summarise my unread email",
      "",
      "   ",
    ]) {
      expect(parseLocalCommand(phrase).kind, phrase).toBe("none");
    }
  });

  it("keeps every allowlist entry launchable without arguments", () => {
    // A target with whitespace or a flag would let the shell be re-parsed.
    for (const app of APP_ALLOWLIST) {
      expect(app.target).not.toMatch(/\s/);
      expect(app.target).not.toContain("&");
      expect(app.target).not.toContain("|");
      expect(app.aliases.length).toBeGreaterThan(0);
    }
    const ids = APP_ALLOWLIST.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("describes a command for the activity feed", () => {
    expect(describeCommand({ kind: "open_app", app: APP_ALLOWLIST[0], spokenAs: "chrome" })).toBe(
      "Open Google Chrome"
    );
    expect(describeCommand({ kind: "none" })).toBe("Ask the brain");
  });
});
