import { createApp } from "./app";
import type { Env } from "./types";

const app = createApp();

export { createApp };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
