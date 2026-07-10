import type { AuthSource, Env } from "./types";
import type { UploadPolicy } from "./upload/policy";

export type AppVariables = {
  rawBody: string;
  actor: string;
  authSource: AuthSource | null;
  uploadPolicy: UploadPolicy | null;
};

export type AppContext = {
  Bindings: Env;
  Variables: AppVariables;
};
