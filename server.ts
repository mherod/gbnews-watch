#!/usr/bin/env bun
/**
 * Production entrypoint. Vercel detects this file as the Bun server and routes
 * every request — including websocket upgrades — to it.
 *
 * The frontend is built and inlined into web/frontend-assets.generated.ts by
 * `bun run build`; the server serves it from memory. This indirection exists
 * because Vercel's Bun framework builder sends all traffic to the function and
 * publishes nothing to the CDN, so the built files have to travel inside the
 * function bundle. Local dev with HMR lives in dev.ts, which imports the HTML
 * bundle directly (rolldown cannot parse that import, hence the split).
 */
import { startCommentServer } from "./src/app-server";
import { streamComments } from "./src/stream";
import { GBNEWS_LIVE_CONTAINER_UUID, GBNEWS_SECTION_UUID } from "./src/viafoura";
import { ASSETS } from "./web/frontend-assets.generated";

const SNAPSHOT_SIZE = 40;

const server = startCommentServer({
  assets: ASSETS,
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

if (!ASSETS["/index.html"]) {
  console.warn("⚠️  No built frontend found — run `bun run build`. Serving API/ws only.");
}

console.log(`gbnews-watch listening on ${server.url}`);
