import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated build artifacts — rewritten by `sites_prepare_next` / `next build`
    // on every publish, so linting them reports noise that cannot be fixed here.
    ".open-next/**",
    ".wrangler/**",
    "desktop/dist/**",
    "freebuff-sites-build/**",
    "freebuff.open-next.config.ts",
    "freebuff.wrangler.jsonc",
  ]),
]);

export default eslintConfig;

