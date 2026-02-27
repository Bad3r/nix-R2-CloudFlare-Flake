import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REQUIRED_ENV = [
  "R2E_SMOKE_BASE_URL",
  "R2E_SMOKE_BUCKET",
  "R2E_SMOKE_KEY",
  "R2E_SMOKE_OAUTH_CLIENT_ID",
  "R2E_SMOKE_OAUTH_CLIENT_SECRET",
  "R2E_SMOKE_OAUTH_TOKEN_URL",
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

async function fetchOAuthToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  scope = "r2.read r2.write r2.share.manage",
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const payload = (await response.json()) as { access_token?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(`oauth token exchange failed: status=${response.status}`);
  }
  return payload.access_token;
}

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
    "validates real share flow plus authenticated multipart upload behavior",
    async () => {
      const baseUrl = requiredEnv("R2E_SMOKE_BASE_URL").replace(/\/+$/, "");
      const baseOrigin = new URL(baseUrl).origin;
      const bucket = requiredEnv("R2E_SMOKE_BUCKET");
      const key = requiredEnv("R2E_SMOKE_KEY");
      const oauthClientId = requiredEnv("R2E_SMOKE_OAUTH_CLIENT_ID");
      const oauthClientSecret = requiredEnv("R2E_SMOKE_OAUTH_CLIENT_SECRET");
      const oauthTokenUrl = requiredEnv("R2E_SMOKE_OAUTH_TOKEN_URL");
      const r2Bin = process.env.R2E_SMOKE_R2_BIN || "r2";
      const ttl = process.env.R2E_SMOKE_TTL || "10m";
      const retries = Number.parseInt(process.env.R2E_SMOKE_RETRIES || "2", 10);
      const attempts = Number.isFinite(retries) && retries >= 0 ? retries + 1 : 3;
      const oauthBearerToken = await fetchOAuthToken(oauthTokenUrl, oauthClientId, oauthClientSecret);

      const cliEnv = {
        ...process.env,
        R2_EXPLORER_BASE_URL: baseUrl,
        R2_EXPLORER_OAUTH_CLIENT_ID: oauthClientId,
        R2_EXPLORER_OAUTH_CLIENT_SECRET: oauthClientSecret,
        R2_EXPLORER_OAUTH_TOKEN_URL: oauthTokenUrl,
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

        const apiInfoUrl = `${baseUrl}/api/v2/session/info`;

        const unauthenticated = await fetchWithRetry(
          apiInfoUrl,
          {
            redirect: "follow",
          },
          attempts,
        );
        expect(unauthenticated.status).toBe(401);
        const unauthenticatedPayload = JSON.parse(unauthenticated.body) as { error?: { code?: string } };
        expect(unauthenticatedPayload.error?.code).toBe("token_missing");

        const authenticated = await fetchWithRetry(
          apiInfoUrl,
          {
            method: "GET",
            redirect: "follow",
            headers: {
              authorization: `Bearer ${oauthBearerToken}`,
            },
          },
          attempts,
        );
        expect(authenticated.status).toBe(200);

        const authenticatedPayload = JSON.parse(authenticated.body) as {
          version?: string;
          actor?: { mode?: string; actor?: string };
        };
        expect(typeof authenticatedPayload.version).toBe("string");
        expect(authenticatedPayload.version?.length).toBeGreaterThan(0);
        expect(authenticatedPayload.actor?.mode).toBe("oauth");
        expect(authenticatedPayload.actor?.actor).toBeTruthy();
        expect(authenticatedPayload.actor?.actor).not.toBe("unknown");

        const uploadInit = await fetchWithRetry(
          `${baseUrl}/api/v2/upload/init`,
          {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              origin: baseOrigin,
              "x-r2e-csrf": "1",
              authorization: `Bearer ${oauthBearerToken}`,
            },
            body: JSON.stringify({
              filename: "live-multipart.bin",
              prefix: "live/",
              declaredSize: 4096,
              contentType: "application/octet-stream",
            }),
          },
          attempts,
        );
        if (uploadInit.status !== 200) {
          throw new Error(`upload init failed: status=${uploadInit.status} body=${uploadInit.body}`);
        }
        const initPayload = JSON.parse(uploadInit.body) as {
          sessionId: string;
          uploadId: string;
          objectKey: string;
        };
        expect(initPayload.sessionId.length).toBeGreaterThan(0);
        expect(initPayload.uploadId.length).toBeGreaterThan(0);
        expect(initPayload.objectKey.startsWith("live/")).toBe(true);

        const signPart = await fetchWithRetry(
          `${baseUrl}/api/v2/upload/sign-part`,
          {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              origin: baseOrigin,
              "x-r2e-csrf": "1",
              authorization: `Bearer ${oauthBearerToken}`,
            },
            body: JSON.stringify({
              sessionId: initPayload.sessionId,
              uploadId: initPayload.uploadId,
              partNumber: 1,
              contentLength: 4096,
            }),
          },
          attempts,
        );
        expect(signPart.status).toBe(200);
        const signPayload = JSON.parse(signPart.body) as {
          url: string;
          method: string;
          headers: Record<string, string>;
        };
        const multipartBody = new Uint8Array(4096).fill(90);
        const uploadResponse = await fetch(signPayload.url, {
          method: signPayload.method,
          headers: signPayload.headers,
          body: multipartBody,
        });
        expect(uploadResponse.status).toBe(200);
        const etag = uploadResponse.headers.get("etag");
        expect(etag).toBeTruthy();

        const completeMultipart = await fetchWithRetry(
          `${baseUrl}/api/v2/upload/complete`,
          {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              origin: baseOrigin,
              "x-r2e-csrf": "1",
              authorization: `Bearer ${oauthBearerToken}`,
            },
            body: JSON.stringify({
              sessionId: initPayload.sessionId,
              uploadId: initPayload.uploadId,
              finalSize: 4096,
              parts: [
                {
                  partNumber: 1,
                  etag: String(etag).replace(/^\"|\"$/g, ""),
                },
              ],
            }),
          },
          attempts,
        );
        expect(completeMultipart.status).toBe(200);
        const completePayload = JSON.parse(completeMultipart.body) as {
          key: string;
          size: number;
        };
        expect(completePayload.key).toBe(initPayload.objectKey);
        expect(completePayload.size).toBe(4096);
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
