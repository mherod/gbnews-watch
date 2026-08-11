#!/usr/bin/env bun
import { startCommentServer } from "./src/app-server";
import { streamComments } from "./src/stream";
import { GBNEWS_LIVE_CONTAINER_UUID, GBNEWS_SECTION_UUID } from "./src/viafoura";

const SNAPSHOT_SIZE = 40;

const dev = !Bun.env.VERCEL && Bun.env.NODE_ENV !== "production";

/**
 * In dev, Bun's HTML import gives HMR for the frontend. The specifier is kept
 * out of a static import (and non-literal) deliberately: Vercel's builder
 * compiles this file with tsc, which cannot process a .html module — the
 * production path must never reference it.
 *
 * In production the frontend is prebuilt into public/ (`bun run build`). On
 * Vercel those files are served by the CDN before the function is invoked;
 * the fallback Response only answers "/" on hosts without that layer.
 */
async function resolveHtml(): Promise<Bun.HTMLBundle | Response> {
  if (dev) {
    const htmlPath = "./web/index.html";
    return (await import(htmlPath)).default;
  }
  const built = Bun.file("public/index.html");
  if (await built.exists()) {
    return new Response(await built.bytes(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return new Response("Frontend not built — run `bun run build` first.", { status: 503 });
}

/**
 * Vercel detects this file as the server entrypoint and routes every request —
 * including websocket upgrades — to it. The port only matters locally; in
 * production the platform assigns one via PORT.
 */
const server = startCommentServer({
  html: await resolveHtml(),
  port: Number(Bun.env.PORT ?? 3000),
  snapshotSize: SNAPSHOT_SIZE,
  containerUuid: GBNEWS_LIVE_CONTAINER_UUID,
  dev,
  publicDir: dev ? undefined : "public",
  source: streamComments({
    sectionUuid: GBNEWS_SECTION_UUID,
    containerUuid: GBNEWS_LIVE_CONTAINER_UUID,
    backfill: SNAPSHOT_SIZE,
  }),
});

console.log(`gbnews-watch listening on ${server.url}`);
