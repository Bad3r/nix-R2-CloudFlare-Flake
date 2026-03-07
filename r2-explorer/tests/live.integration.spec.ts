import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REQUIRED_SUFFIXES = [
  "SMOKE_BASE_URL",
  "SMOKE_BUCKET",
  "SMOKE_KEY",
  "SERVICE_TOKEN_CLIENT_ID",
  "SERVICE_TOKEN_CLIENT_SECRET",
] as const;

type CiEnvironment = "preview" | "production";

type CiContext = {
  environment: CiEnvironment;
  baseUrl: string;
  bucket: string;
  key: string;
  serviceTokenClientId: string;
  serviceTokenClientSecret: string;
  r2Bin: string;
  smokeTtl: string;
  retries: number;
};

function inferCiEnvironment(): CiEnvironment | null {
  const explicit = process.env.CF_CI_ENVIRONMENT?.trim().toLowerCase();
  if (explicit) {
    if (explicit === "preview" || explicit === "production") {
      return explicit;
    }
    throw new Error(`CF_CI_ENVIRONMENT must be 'preview' or 'production' (got '${process.env.CF_CI_ENVIRONMENT}')`);
  }

  const hasPreview = Object.keys(process.env).some((name) => name.startsWith("CF_PREVIEW_CI_"));
  const hasProduction = Object.keys(process.env).some((name) => name.startsWith("CF_PRODUCTION_CI_"));

  if (hasPreview && hasProduction) {
    throw new Error(
      "Detected both CF_PREVIEW_CI_* and CF_PRODUCTION_CI_* variables. Set CF_CI_ENVIRONMENT to disambiguate.",
    );
  }
  if (hasPreview) {
    return "preview";
  }
  if (hasProduction) {
    return "production";
  }
  return null;
}

function prefixedName(environment: CiEnvironment, suffix: string): string {
  return `CF_${environment.toUpperCase()}_CI_${suffix}`;
}

function readRequiredPrefixed(environment: CiEnvironment, suffix: (typeof REQUIRED_SUFFIXES)[number]): string {
  const name = prefixedName(environment, suffix);
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readOptionalPrefixed(environment: CiEnvironment, suffix: string, fallback: string): string {
  const name = prefixedName(environment, suffix);
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return fallback;
  }
  return value;
}

function resolveMissingEnv(): string[] {
  const environment = inferCiEnvironment();
  if (!environment) {
    return ["CF_CI_ENVIRONMENT or one CF_<ENV>_CI_* variable family"];
  }

  return REQUIRED_SUFFIXES.filter((suffix) => {
    const value = process.env[prefixedName(environment, suffix)];
    return !value || value.trim().length === 0;
  }).map((suffix) => prefixedName(environment, suffix));
}

function resolveCiContext(): CiContext {
  const environment = inferCiEnvironment();
  if (!environment) {
    throw new Error("Unable to determine CI environment. Set CF_CI_ENVIRONMENT or define CF_PREVIEW_CI_* / CF_PRODUCTION_CI_* variables.");
  }

  const retriesRaw = readOptionalPrefixed(environment, "SMOKE_RETRIES", "2");
  const retriesParsed = Number.parseInt(retriesRaw, 10);
  const retries = Number.isFinite(retriesParsed) && retriesParsed >= 0 ? retriesParsed : 2;

  return {
    environment,
    baseUrl: readRequiredPrefixed(environment, "SMOKE_BASE_URL").replace(/\/+$/, ""),
    bucket: readRequiredPrefixed(environment, "SMOKE_BUCKET"),
    key: readRequiredPrefixed(environment, "SMOKE_KEY"),
    serviceTokenClientId: readRequiredPrefixed(environment, "SERVICE_TOKEN_CLIENT_ID"),
    serviceTokenClientSecret: readRequiredPrefixed(environment, "SERVICE_TOKEN_CLIENT_SECRET"),
    r2Bin: readOptionalPrefixed(environment, "R2_BIN", "r2"),
    smokeTtl: readOptionalPrefixed(environment, "SMOKE_TTL", "10m"),
    retries,
  };
}

const missingEnv = resolveMissingEnv();
const describeLive = missingEnv.length === 0 ? describe : describe.skip;

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
    "validates real share flow plus authenticated multipart upload behavior",
    async () => {
      const ci = resolveCiContext();
      const baseOrigin = new URL(ci.baseUrl).origin;
      const attempts = ci.retries + 1;

      const cliEnv = {
        ...process.env,
        R2_EXPLORER_BASE_URL: ci.baseUrl,
        R2_EXPLORER_ACCESS_CLIENT_ID: ci.serviceTokenClientId,
        R2_EXPLORER_ACCESS_CLIENT_SECRET: ci.serviceTokenClientSecret,
      } as NodeJS.ProcessEnv;

      const accessHeaders = {
        "CF-Access-Client-Id": ci.serviceTokenClientId,
        "CF-Access-Client-Secret": ci.serviceTokenClientSecret,
      };

      let createdTokenId: string | null = null;
      try {
        const { stdout: createStdout } = await execFileAsync(
          ci.r2Bin,
          ["share", "worker", "create", ci.bucket, ci.key, ci.smokeTtl, "--max-downloads", "1"],
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

        const apiInfoUrl = `${ci.baseUrl}/api/v2/session/info`;

        const unauthenticated = await fetchWithRetry(
          apiInfoUrl,
          {
            redirect: "manual",
          },
          attempts,
        );
        if (unauthenticated.status === 302) {
          const redirectLocation = unauthenticated.headers.get("location") ?? "";
          expect(redirectLocation).toContain("/cdn-cgi/access/login");
        } else {
          expect(unauthenticated.status).toBe(401);
          const unauthenticatedPayload = JSON.parse(unauthenticated.body) as { error?: { code?: string } };
          expect(unauthenticatedPayload.error?.code).toBe("access_required");
        }

        const authenticated = await fetchWithRetry(
          apiInfoUrl,
          {
            method: "GET",
            redirect: "follow",
            headers: accessHeaders,
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
        expect(authenticatedPayload.actor?.mode).toBe("access");
        expect(authenticatedPayload.actor?.actor).toBeTruthy();
        expect(authenticatedPayload.actor?.actor).not.toBe("unknown");

        const uploadInit = await fetchWithRetry(
          `${ci.baseUrl}/api/v2/upload/init`,
          {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              origin: baseOrigin,
              "x-r2e-csrf": "1",
              ...accessHeaders,
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
          `${ci.baseUrl}/api/v2/upload/sign-part`,
          {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              origin: baseOrigin,
              "x-r2e-csrf": "1",
              ...accessHeaders,
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
          `${ci.baseUrl}/api/v2/upload/complete`,
          {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": "application/json",
              origin: baseOrigin,
              "x-r2e-csrf": "1",
              ...accessHeaders,
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
            ci.r2Bin,
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
