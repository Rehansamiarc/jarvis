import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      // Server modules carry `import "server-only"`, whose real package throws outside a
      // React Server Component bundle. Point it at an empty stub for tests.
      { find: /^server-only$/, replacement: path.resolve(__dirname, "./tests/stubs/server-only.ts") },
      { find: /^@\//, replacement: path.resolve(__dirname, "./src/") + "/" },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    passWithNoTests: false,
  },
});
