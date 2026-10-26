import { mkdirSync } from "node:fs";
import { cpSync } from "node:fs";
import { build } from "esbuild";

/**
 * Desktop bundling.
 *
 * Three targets: the main process and the preload bridge are CommonJS Node bundles, the
 * renderer is a classic IIFE so `<script src>` works from `file://` without module CORS
 * rules. Native modules (`electron`, the wake-word engine) stay external and resolve
 * from node_modules at runtime.
 */

const shared = {
  bundle: true,
  logLevel: "warning",
  absWorkingDir: process.cwd(),
};

const nodeExternal = ["electron", "@picovoice/porcupine-node"];

await build({
  ...shared,
  entryPoints: ["desktop/main.ts"],
  outfile: "desktop/dist/main.js",
  platform: "node",
  format: "cjs",
  target: "node22",
  external: nodeExternal,
});

await build({
  ...shared,
  entryPoints: ["desktop/preload.ts"],
  outfile: "desktop/dist/preload.js",
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});

await build({
  ...shared,
  entryPoints: ["desktop/ui/renderer.ts"],
  outfile: "desktop/dist/ui/renderer.js",
  platform: "browser",
  format: "iife",
  target: "chrome126",
});

mkdirSync("desktop/dist/ui", { recursive: true });
cpSync("desktop/ui/index.html", "desktop/dist/ui/index.html");

console.log("desktop build complete → desktop/dist/");
