#!/usr/bin/env bun
/**
 * Production entrypoint. Vercel detects this file as the Bun server and routes
 * every request — including websocket upgrades — to it.
 *
 * The frontend is prebuilt into public/ (`bun run build`). On Vercel those
 * files are served by the CDN before the function is invoked; the publicDir
 * fallback below covers "/" and assets on hosts without that layer. This file
 * must never reference web/index.html — Vercel bundles the server with
 * rolldown, which cannot parse HTML modules. Local dev with HMR lives in
 * dev.ts for exactly that reason.
 */
import { startCommentServer } from "./src/app-server";
import { streamComments } from "./src/stream";
import { GBNEWS_LIVE_CONTAINER_UUID, GBNEWS_SECTION_UUID } from "./src/viafoura";

const SNAPSHOT_SIZE = 40;

async function resolveHtml(): Promise<Response> {
  const built = Bun.file("public/index.html");
  if (await built.exists()) {
    return new Response(await built.bytes(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return new Response("Frontend not built — run `bun run build` first.", { status: 503 });
}

const server = startCommentServer({
  html: await resolveHtml(),
  port: Number(Bun.env.PORT ?? 3000),
  snapshotSize: SNAPSHOT_SIZE,
  containerUuid: GBNEWS_LIVE_CONTAINER_UUID,
  dev: false,
  publicDir: "public",
  source: streamComments({
    sectionUuid: GBNEWS_SECTION_UUID,
    containerUuid: GBNEWS_LIVE_CONTAINER_UUID,
    backfill: SNAPSHOT_SIZE,
  }),
});

console.log(`gbnews-watch listening on ${server.url}`);
