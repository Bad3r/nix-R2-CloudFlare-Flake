import { HttpError } from "./http";
import type { Env } from "./types";

type BucketMap = Record<string, string>;
type BucketBindings = Record<string, R2Bucket | undefined>;

const DEFAULT_BUCKET_ALIAS = "files";
const DEFAULT_BUCKET_BINDING = "FILES_BUCKET";

export function parseBucketMap(env: Env): BucketMap {
  const raw = env.R2E_BUCKET_MAP;
  if (!raw || raw.trim().length === 0) {
    return { [DEFAULT_BUCKET_ALIAS]: DEFAULT_BUCKET_BINDING };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HttpError(500, "bucket_map_invalid", "R2E_BUCKET_MAP must be valid JSON.", {
      error: String(error),
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(500, "bucket_map_invalid", "R2E_BUCKET_MAP must be a JSON object.");
  }

  const map: BucketMap = {};
  for (const [alias, binding] of Object.entries(parsed as Record<string, unknown>)) {
    if (!alias || typeof binding !== "string" || binding.trim().length === 0) {
      throw new HttpError(
        500,
        "bucket_map_invalid",
        "R2E_BUCKET_MAP must map non-empty aliases to binding names.",
        { alias, binding },
      );
    }
    map[alias] = binding;
  }

  if (Object.keys(map).length === 0) {
    throw new HttpError(500, "bucket_map_invalid", "R2E_BUCKET_MAP must include at least one alias.");
  }

  if (!map[DEFAULT_BUCKET_ALIAS]) {
    throw new HttpError(
      500,
      "bucket_map_invalid",
      "R2E_BUCKET_MAP must include the default 'files' alias.",
    );
  }

  if (map[DEFAULT_BUCKET_ALIAS] !== DEFAULT_BUCKET_BINDING) {
    throw new HttpError(
      500,
      "bucket_map_invalid",
      "R2E_BUCKET_MAP must map the 'files' alias to FILES_BUCKET.",
      { alias: DEFAULT_BUCKET_ALIAS, binding: map[DEFAULT_BUCKET_ALIAS] },
    );
  }

  return map;
}

export function resolveBucket(env: Env, alias: string): { alias: string; binding: string; bucket: R2Bucket } {
  const map = parseBucketMap(env);
  const binding = map[alias];
  if (!binding) {
    // Log the configured aliases for operators; the client only gets back the
    // alias it asked for, not the deployment's bucket map.
    console.error(`Unknown bucket alias '${alias}'; configured aliases: ${Object.keys(map).join(", ")}`);
    throw new HttpError(400, "bucket_unknown", `Unknown bucket alias: ${alias}`, {
      alias,
    });
  }
  const bucket = (env as BucketBindings)[binding];
  if (!bucket) {
    // Binding names are deployment internals; log them instead of echoing
    // them in the client-facing error payload.
    console.error(`Bucket binding '${binding}' for alias '${alias}' not found in worker environment.`);
    throw new HttpError(
      500,
      "bucket_binding_missing",
      `Bucket for alias '${alias}' is not bound in this worker environment.`,
      { alias },
    );
  }
  return { alias, binding, bucket };
}

export function listBucketBindings(env: Env): Array<{ alias: string; binding: string }> {
  return Object.entries(parseBucketMap(env))
    .map(([alias, binding]) => ({ alias, binding }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}
