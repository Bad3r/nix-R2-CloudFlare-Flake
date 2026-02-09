import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REQUIRED_ENV = [
  "R2E_SMOKE_BASE_URL",
  "R2E_SMOKE_ADMIN_KID",
  "R2E_SMOKE_ADMIN_SECRET",
  "R2E_SMOKE_BUCKET",
  "R2E_SMOKE_KEY",
  "R2E_SMOKE_ACCESS_CLIENT_ID",
  "R2E_SMOKE_ACCESS_CLIENT_SECRET",
] as const;

const missingEnv = REQUIRED_ENV.filter((name) => {
  const value = process.env[name];
  return !value || value.trim().length === 0;
});

const describeLive = missingEnv.length === 0 ? describe : describe.skip;

function requiredEnv(name: (typeof REQUIRED_ENV)[number]): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

type ResponseWithBody = {
  status: number;
  headers: Headers;
  body: string;
};

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempts: number,
): Promise<ResponseWithBody> {
  let attemptError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const body = await response.text();
      if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
        continue;
      }
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      attemptError = error;
      if (attempt < attempts) {
        continue;
      }
    }
  }

  throw new Error(`Request failed after ${attempts} attempts: ${String(attemptError)}`);
}

describeLive("live worker integration", () => {
  it(
    "validates real share flow plus unauthenticated and authenticated API behavior",
    async () => {
      const baseUrl = requiredEnv("R2E_SMOKE_BASE_URL").replace(/\/+$/, "");
      const bucket = requiredEnv("R2E_SMOKE_BUCKET");
      const key = requiredEnv("R2E_SMOKE_KEY");
      const adminKid = requiredEnv("R2E_SMOKE_ADMIN_KID");
      const adminSecret = requiredEnv("R2E_SMOKE_ADMIN_SECRET");
      const accessClientId = requiredEnv("R2E_SMOKE_ACCESS_CLIENT_ID");
      const accessClientSecret = requiredEnv("R2E_SMOKE_ACCESS_CLIENT_SECRET");
      const r2Bin = process.env.R2E_SMOKE_R2_BIN || "r2";
      const ttl = process.env.R2E_SMOKE_TTL || "10m";
      const retries = Number.parseInt(process.env.R2E_SMOKE_RETRIES || "2", 10);
      const attempts = Number.isFinite(retries) && retries >= 0 ? retries + 1 : 3;

      const cliEnv = {
        ...process.env,
        R2_EXPLORER_BASE_URL: baseUrl,
        R2_EXPLORER_ADMIN_KID: adminKid,
        R2_EXPLORER_ADMIN_SECRET: adminSecret,
      } as NodeJS.ProcessEnv;

      let createdTokenId: string | null = null;
      try {
        const { stdout: createStdout } = await execFileAsync(
          r2Bin,
          ["share", "worker", "create", bucket, key, ttl, "--max-downloads", "1"],
          {
            env: cliEnv,
            timeout: 120_000,
          },
        );
        const createPayload = JSON.parse(createStdout.trim()) as {
          tokenId: string;
          url: string;
          expiresAt: string;
        };

        createdTokenId = createPayload.tokenId;
        expect(createPayload.tokenId.length).toBeGreaterThan(0);
        expect(createPayload.url.startsWith("http")).toBe(true);
        expect(createPayload.expiresAt.length).toBeGreaterThan(0);

        const firstDownload = await fetchWithRetry(createPayload.url, { redirect: "follow" }, attempts);
        expect(firstDownload.status).toBe(200);

        const secondDownload = await fetchWithRetry(createPayload.url, { redirect: "follow" }, attempts);
        expect(secondDownload.status).toBe(410);

        const apiInfoUrl = `${baseUrl}/api/server/info`;

        const unauthenticated = await fetchWithRetry(
          apiInfoUrl,
          {
            redirect: "manual",
          },
          attempts,
        );
        expect([302, 401]).toContain(unauthenticated.status);
        if (unauthenticated.status === 302) {
          const location = unauthenticated.headers.get("location") || "";
          expect(location).toContain("/cdn-cgi/access/login/");
        } else {
          const payload = JSON.parse(unauthenticated.body) as { error?: { code?: string } };
          expect(payload.error?.code).toBe("access_required");
        }

        const authenticated = await fetchWithRetry(
          apiInfoUrl,
          {
            method: "GET",
            redirect: "manual",
            headers: {
              "CF-Access-Client-Id": accessClientId,
              "CF-Access-Client-Secret": accessClientSecret,
            },
          },
          attempts,
        );
        expect(authenticated.status).toBe(200);

        const authenticatedPayload = JSON.parse(authenticated.body) as {
          version?: string;
          actor?: { mode?: string };
        };
        expect(typeof authenticatedPayload.version).toBe("string");
        expect(authenticatedPayload.version?.length).toBeGreaterThan(0);
        expect(authenticatedPayload.actor?.mode).toBe("access");
      } finally {
        if (createdTokenId) {
          const { stdout: revokeStdout } = await execFileAsync(
            r2Bin,
            ["share", "worker", "revoke", createdTokenId],
            {
              env: cliEnv,
              timeout: 120_000,
            },
          );
          const revokePayload = JSON.parse(revokeStdout.trim()) as { revoked?: boolean };
          expect(revokePayload.revoked).toBe(true);
        }
      }
    },
    180_000,
  );
});
