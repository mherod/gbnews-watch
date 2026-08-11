#!/usr/bin/env bun
/**
 * Local development entrypoint: `bun run dev`.
 *
 * Lives apart from server.ts because Bun's HTML import (which powers HMR) is a
 * bundler feature Vercel's rolldown pass cannot parse — the production
 * entrypoint must never reference web/index.html, even dynamically.
 */
import html from "./web/index.html";
import { startCommentServer } from "./src/app-server";
import { streamComments } from "./src/stream";
import { GBNEWS_LIVE_CONTAINER_UUID, GBNEWS_SECTION_UUID } from "./src/viafoura";

const SNAPSHOT_SIZE = 40;

const server = startCommentServer({
  html,
  port: Number(Bun.env.PORT ?? 3000),
  snapshotSize: SNAPSHOT_SIZE,
  containerUuid: GBNEWS_LIVE_CONTAINER_UUID,
  dev: true,
  source: streamComments({
    sectionUuid: GBNEWS_SECTION_UUID,
    containerUuid: GBNEWS_LIVE_CONTAINER_UUID,
    backfill: SNAPSHOT_SIZE,
  }),
});

console.log(`gbnews-watch dev server on ${server.url}`);
