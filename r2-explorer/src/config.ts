import { HttpError } from "./http";

type EnvIntOptions = {
  allowZero: boolean;
  errorCode: string;
};

/**
 * Parse an integer Worker variable, failing fast with an HttpError when the
 * value is present but not a valid integer for the requested constraints.
 * Empty or missing values fall back to the provided default.
 */
export function parseEnvInt(
  name: string,
  value: string | undefined,
  fallback: number,
  options: EnvIntOptions,
): number {
  if (!value || value.trim().length === 0) {
    return fallback;
  }
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    const requirement = options.allowZero ? "a non-negative integer" : "a positive integer";
    throw new HttpError(500, options.errorCode, `${name} must be ${requirement}.`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || (!options.allowZero && parsed <= 0)) {
    const requirement = options.allowZero ? "a non-negative integer" : "a positive integer";
    throw new HttpError(500, options.errorCode, `${name} must be ${requirement}.`);
  }
  return parsed;
}

/**
 * Parse a positive integer Worker variable, throwing `errorCode` when the
 * configured value is invalid. Missing or empty values use the fallback.
 */
export function envInt(
  name: string,
  value: string | undefined,
  fallback: number,
  errorCode = "config_invalid",
): number {
  return parseEnvInt(name, value, fallback, {
    allowZero: false,
    errorCode,
  });
}

/**
 * Parse a non-negative integer Worker variable, throwing `errorCode` when the
 * configured value is invalid. Missing or empty values use the fallback.
 */
export function envNonNegativeInt(
  name: string,
  value: string | undefined,
  fallback: number,
  errorCode = "config_invalid",
): number {
  return parseEnvInt(name, value, fallback, {
    allowZero: true,
    errorCode,
  });
}

/**
 * Parse a boolean Worker variable. Accepts 1/true/yes/on and 0/false/no/off
 * (case-insensitive); any other value returns the fallback.
 */
export function envBool(value: string | undefined, fallback = false): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

/**
 * Split a comma-separated Worker variable into trimmed, non-empty entries.
 */
export function parseList(value: string | undefined): string[] {
  if (!value || value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
