import { AwsClient } from "aws4fetch";
import { HttpError } from "./http";
import type { Env } from "./types";

type SignedUploadPart = {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
};

type SignUploadPartInput = {
  bucketName: string;
  key: string;
  uploadId: string;
  partNumber: number;
  expiresInSec: number;
  contentType?: string;
  contentMd5?: string;
};

function encodeObjectKey(key: string): string {
  return key
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function requiredEnv(name: keyof Env, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(
      500,
      "upload_signing_config_invalid",
      `Missing required Worker variable ${String(name)} for upload signing.`,
    );
  }
  return value.trim();
}

export async function signMultipartUploadPart(
  env: Env,
  input: SignUploadPartInput,
): Promise<SignedUploadPart> {
  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID", env.CLOUDFLARE_ACCOUNT_ID);
  const accessKeyId = requiredEnv("S3_ACCESS_KEY_ID", env.S3_ACCESS_KEY_ID);
  const secretAccessKey = requiredEnv("S3_SECRET_ACCESS_KEY", env.S3_SECRET_ACCESS_KEY);

  const objectPath = encodeObjectKey(input.key);
  if (objectPath.length === 0) {
    throw new HttpError(400, "invalid_upload_key", "Upload key must resolve to a non-empty object path.");
  }

  const uploadUrl = new URL(
    `https://${accountId}.r2.cloudflarestorage.com/${encodeURIComponent(input.bucketName)}/${objectPath}`,
  );
  uploadUrl.searchParams.set("uploadId", input.uploadId);
  uploadUrl.searchParams.set("partNumber", String(input.partNumber));
  uploadUrl.searchParams.set("X-Amz-Expires", String(input.expiresInSec));

  const headers = new Headers();
  if (typeof input.contentType === "string" && input.contentType.trim().length > 0) {
    headers.set("content-type", input.contentType);
  }
  if (typeof input.contentMd5 === "string" && input.contentMd5.trim().length > 0) {
    headers.set("content-md5", input.contentMd5.trim());
  }

  const signer = new AwsClient({
    accessKeyId,
    secretAccessKey,
  });

  const signedRequest = await signer.sign(
    new Request(uploadUrl.toString(), {
      method: "PUT",
      headers,
    }),
    {
      aws: {
        signQuery: true,
      },
    },
  );

  const requiredHeaders: Record<string, string> = {};
  const signedContentType = headers.get("content-type");
  if (signedContentType) {
    requiredHeaders["content-type"] = signedContentType;
  }
  const signedContentMd5 = headers.get("content-md5");
  if (signedContentMd5) {
    requiredHeaders["content-md5"] = signedContentMd5;
  }

  return {
    url: signedRequest.url,
    method: "PUT",
    headers: requiredHeaders,
    expiresAt: new Date(Date.now() + input.expiresInSec * 1000).toISOString(),
  };
}
