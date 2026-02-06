export default {
  async fetch(): Promise<Response> {
    return new Response("R2-Explorer scaffold only (Phase 1).", { status: 501 });
  },
};
