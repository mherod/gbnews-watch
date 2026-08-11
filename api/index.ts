import html from "../web/index.html";
import { startCommentServer } from "../src/app-server.ts";
import { streamComments } from "../src/stream.ts";
import { GBNEWS_LIVE_CONTAINER_UUID, GBNEWS_SECTION_UUID } from "../src/viafoura.ts";

const SNAPSHOT_SIZE = 40;

/**
 * Vercel Serverless Function entrypoint.
 * Starts the comment server and delegates incoming requests to it.
 */
const server = startCommentServer({
  html,
  port: Number(Bun.env.PORT ?? 3000),
  snapshotSize: SNAPSHOT_SIZE,
  containerUuid: GBNEWS_LIVE_CONTAINER_UUID,
  dev: !Bun.env.VERCEL && Bun.env.NODE_ENV !== "production",
  source: streamComments({
    sectionUuid: GBNEWS_SECTION_UUID,
    containerUuid: GBNEWS_LIVE_CONTAINER_UUID,
    backfill: SNAPSHOT_SIZE,
  }),
});

if (!Bun.env.VERCEL) {
  console.log(`gbnews-watch listening on ${server.url}`);
}

export default function handler(req: Request) {
  return server.fetch(req);
}
