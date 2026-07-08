import { z } from "zod";
import { HttpError, json, parseJsonText } from "./http";
import { requestActorSchema } from "./schemas";
import type { RequestActor } from "./types";

/**
 * Validate a payload against a Zod schema, converting failures into a
 * client-safe 400 validation_error with the collected issues.
 */
export function validateSchema<T extends z.ZodType>(schema: T, payload: unknown, label: string): z.output<T> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new HttpError(400, "validation_error", `Invalid ${label}.`, {
      issues: result.error.issues,
    });
  }
  return result.data;
}

/**
 * Parse and validate the buffered JSON request body captured by the raw-body
 * middleware for the JSON mutation routes.
 */
export function readJsonBody<T extends z.ZodType>(
  c: { get: (key: "rawBody") => string },
  schema: T,
): z.output<T> {
  const rawBody = c.get("rawBody");
  if (!rawBody || rawBody.trim().length === 0) {
    throw new HttpError(400, "bad_request", "Request body is required.");
  }
  return validateSchema(schema, parseJsonText(rawBody), "request body");
}

/**
 * Serialize a payload as JSON after asserting it matches the response schema.
 * This guards route handlers against drifting from the documented API shape.
 */
export function jsonValidated<T extends z.ZodType>(schema: T, payload: unknown, init?: ResponseInit): Response {
  return json(validateSchema(schema, payload, "response payload"), init);
}

/** Collect the query string into a plain string map for schema validation. */
export function queryPayload(request: Request): Record<string, string> {
  const payload: Record<string, string> = {};
  const search = new URL(request.url).searchParams;
  search.forEach((value, key) => {
    payload[key] = value;
  });
  return payload;
}

/** Build the validated actor descriptor echoed in API responses. */
export function requestActor(c: { get: (key: "actor") => string }): RequestActor {
  const actor = c.get("actor");
  const payload = {
    mode: "access" as const,
    actor: actor || "unknown",
  };
  return requestActorSchema.parse(payload);
}

/** Require a non-empty authenticated actor for upload session ownership. */
export function requireUploadActor(c: { get: (key: "actor") => string }): string {
  const actor = c.get("actor");
  if (!actor || actor.trim().length === 0) {
    throw new HttpError(401, "access_required", "Authenticated upload actor is required.");
  }
  return actor;
}
