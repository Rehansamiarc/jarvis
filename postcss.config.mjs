/**
 * Tailwind v4 through PostCSS.
 *
 * The production build uses `next build --webpack` because this machine's
 * Application Control policy blocks the native SWC/Turbopack bindings, so the
 * Turbopack-only CSS loader in next.config.ts cannot be used there. Routing CSS
 * through PostCSS keeps one pipeline for both `next dev` (Turbopack) and
 * `next build` (webpack) instead of configuring Tailwind twice.
 */
const config = {
  plugins: ["@tailwindcss/postcss"],
};

export default config;
