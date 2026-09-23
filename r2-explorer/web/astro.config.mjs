import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import preact from "@astrojs/preact";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  integrations: [preact()],
  vite: {
    server: {
      // Two-terminal local dev: `pnpm dev` in r2-explorer/ (the API Worker's
      // wrangler dev, default port 8787) plus `pnpm dev` here. /share/* needs
      // no auth and works end to end through this proxy. /api/v2/* correctly
      // 401s with access_required instead of a same-origin 404: Access
      // enforcement is in-worker against a real team-domain JWT that only
      // Cloudflare's edge can issue, so authenticated routes cannot be
      // exercised this way. See README.md for the working alternative.
      proxy: {
        "/api": "http://127.0.0.1:8787",
        "/share": "http://127.0.0.1:8787",
      },
    },
  },
});
