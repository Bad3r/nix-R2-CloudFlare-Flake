import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/*
 * Second Vitest project running tests/workers/** inside workerd via
 * @cloudflare/vitest-pool-workers, so the real Durable Objects
 * (ShareCounterDurableObject, UploadSessionDurableObject) and R2/KV
 * simulators are exercised instead of the node-suite memory fakes.
 *
 * Bindings and migrations come from wrangler.toml; the deploy-placeholder
 * [vars] values are overridden here with the same test values the node
 * suite's createTestEnv() uses (tests/workers/helpers.ts must stay in sync
 * with the auth values).
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          R2E_PUBLIC_BASE_URL: "https://files.example.com",
          R2E_BUCKET_MAP: "",
          R2E_ACCESS_TEAM_DOMAIN: "repo.cloudflareaccess.com",
          R2E_ACCESS_AUD: "4e6af42fbb5a5c49daa17742abca157c30bac4f734855b695f02e1c4ae849769",
          R2E_ACCESS_JWKS_URL: "https://repo.cloudflareaccess.com/cdn-cgi/access/certs",
          R2E_ACCESS_REQUIRED_SCOPES_READ: "",
          R2E_ACCESS_REQUIRED_SCOPES_WRITE: "",
          R2E_ACCESS_REQUIRED_SCOPES_SHARE_MANAGE: "",
          R2E_ACCESS_CLOCK_SKEW_SEC: "60",
          R2E_ACCESS_JWKS_CACHE_TTL_SEC: "300",
          R2E_UPLOAD_ALLOWED_ORIGINS: "https://files.example.com",
          R2E_UPLOAD_S3_BUCKET: "files-bucket-test",
          CLOUDFLARE_ACCOUNT_ID: "account-id-test",
          S3_ACCESS_KEY_ID: "s3-access-test",
          S3_SECRET_ACCESS_KEY: "s3-secret-test",
        },
      },
    }),
  ],
  test: {
    include: ["tests/workers/**/*.spec.ts"],
  },
});
