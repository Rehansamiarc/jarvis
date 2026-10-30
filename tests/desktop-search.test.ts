import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The walker lives in a module that also imports Electron, so `electron` is stubbed at
 * import time — the search itself touches only Node's fs, which is the part worth testing.
 */
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  clipboard: { writeText: () => {} },
  Notification: class {
    static isSupported() {
      return false;
    }
    show() {}
  },
}));

const { searchNameInRoots } = await import("../desktop/actions");

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "jarvis-search-"));
  await mkdir(path.join(root, "invoices"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
  await writeFile(path.join(root, "invoices", "Tax-Return-2026.pdf"), "x");
  await writeFile(path.join(root, "notes.txt"), "x");
  await writeFile(path.join(root, "node_modules", "junk", "Tax-Return-hidden.pdf"), "x");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("local file search", () => {
  it("finds a file in a nested folder, case-insensitively", async () => {
    const matches = await searchNameInRoots([root], "tax-return", 10);
    expect(matches.map((m) => m.name)).toEqual(["Tax-Return-2026.pdf"]);
    expect(matches[0].path.endsWith("Tax-Return-2026.pdf")).toBe(true);
  });

  it("skips node_modules, so a project tree cannot flood the result", async () => {
    const matches = await searchNameInRoots([root], "tax-return", 10);
    expect(matches.some((m) => m.path.includes("node_modules"))).toBe(false);
  });

  it("respects the result limit", async () => {
    expect((await searchNameInRoots([root], "tax", 1)).length).toBe(1);
  });

  it("ignores queries shorter than two characters and missing roots", async () => {
    expect(await searchNameInRoots([root], "t", 10)).toEqual([]);
    expect(await searchNameInRoots([path.join(root, "nope")], "tax", 10)).toEqual([]);
  });
});
