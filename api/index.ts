import { startCommentServer } from "../src/app-server.ts";
import { streamComments } from "../src/stream.ts";
import { GBNEWS_LIVE_CONTAINER_UUID, GBNEWS_SECTION_UUID } from "../src/viafoura.ts";

const SNAPSHOT_SIZE = 40;

/**
 * Vercel Serverless Function entrypoint.
 * Starts the comment server and delegates incoming requests to it.
 */
const server = startCommentServer({
  html: new Response("OK"),
  port: Number(Bun.env.PORT ?? 3000),
  snapshotSize: SNAPSHOT_SIZE,
  containerUuid: GBNEWS_LIVE_CONTAINER_UUID,
  dev: false,
  source: streamComments({
    sectionUuid: GBNEWS_SECTION_UUID,
    containerUuid: GBNEWS_LIVE_CONTAINER_UUID,
    backfill: SNAPSHOT_SIZE,
  }),
});

export default async function handler(req: any, res?: any) {
  // Web Standard Request (Vercel Edge / Bun)
  if (req instanceof Request || (req && typeof req.url === "string" && typeof req.arrayBuffer === "function")) {
    return server.fetch(req);
  }

  // Node.js IncomingMessage & ServerResponse (Vercel Serverless Function)
  const url = new URL(req.url ?? "/", `http://${req.headers?.host ?? "localhost"}`);
  const webReq = new Request(url.href, {
    method: req.method ?? "GET",
    headers: req.headers as any,
  });

  const webRes = await server.fetch(webReq);

  if (res && typeof res.status === "function") {
    res.status(webRes.status);
    webRes.headers.forEach((val: string, key: string) => {
      res.setHeader(key, val);
    });
    const body = await webRes.arrayBuffer();
    res.end(Buffer.from(body));
    return;
  }

  return webRes;
}
