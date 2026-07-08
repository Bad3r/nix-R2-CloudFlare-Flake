import { createApp } from "./app";
import { ShareCounterDurableObject } from "./share/counter";
import { UploadSessionDurableObject } from "./upload-sessions";
import type { Env } from "./types";

const app = createApp();

export { createApp, ShareCounterDurableObject, UploadSessionDurableObject };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
