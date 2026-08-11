/**
 * Serve the real UI against a source that never emits, so the waiting state can
 * be inspected in a browser without waiting for GB News to go quiet.
 *
 *   bun scripts/debug-empty-state.ts        # http://localhost:3100
 */

import index from "../web/index.html";
import { startCommentServer } from "../src/app-server.ts";
import type { StreamEvent } from "../src/stream.ts";

async function* silence(): AsyncGenerator<StreamEvent> {
  yield { type: "primed", tracking: 0 };
  await new Promise(() => {}); // never resolves — the feed stays empty
}

const server = startCommentServer({
  html: index,
  port: Number(Bun.env.PORT ?? 3100),
  source: silence(),
});

console.log(`empty-state preview on ${server.url}`);
