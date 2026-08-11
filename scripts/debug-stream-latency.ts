/**
 * Compare the two transports on the live feed: which source delivers each
 * comment first, and how far behind the posted timestamp we are.
 *
 *   bun scripts/debug-stream-latency.ts --seconds 90
 *   bun scripts/debug-stream-latency.ts --seconds 90 --transport poll
 */

import { parseArgs } from "node:util";
import { streamComments } from "../src/stream";
import { GBNEWS_LIVE_CONTAINER_UUID, GBNEWS_SECTION_UUID } from "../src/viafoura";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "90" },
    transport: { type: "string", default: "socket" },
    interval: { type: "string" },
  },
});

const controller = new AbortController();
setTimeout(() => controller.abort(), Number(values.seconds) * 1000);

const latencies: { via: string; ms: number }[] = [];
const bySource = new Map<string, number>();

console.log(`--- ${values.transport} transport, ${values.seconds}s ---`);

for await (const event of streamComments({
  sectionUuid: GBNEWS_SECTION_UUID,
  containerUuid: GBNEWS_LIVE_CONTAINER_UUID,
  transport: values.transport === "poll" ? "poll" : "socket",
  intervalMs: values.interval ? Number(values.interval) * 1000 : undefined,
  signal: controller.signal,
})) {
  if (event.type === "notice") {
    console.log("NOTICE:", event.text);
    continue;
  }
  if (event.type === "error") {
    console.log("ERROR:", event.error instanceof Error ? event.error.message : event.error);
    continue;
  }
  if (event.type !== "comment") continue;

  const ms = Date.now() - event.comment.postedAt.getTime();
  latencies.push({ via: event.comment.via, ms });
  bySource.set(event.comment.via, (bySource.get(event.comment.via) ?? 0) + 1);

  console.log(
    `${String(ms).padStart(6)}ms  via=${event.comment.via.padEnd(6)} ${event.comment.kind.padEnd(7)} ${event.comment.author}: ${JSON.stringify(event.comment.body.slice(0, 50))}`,
  );
}

console.log("\n--- summary ---");
console.log("comments:", latencies.length, " by source:", Object.fromEntries(bySource));
if (latencies.length) {
  const sorted = [...latencies].map((l) => l.ms).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  console.log(
    `latency ms — min ${sorted[0]}  median ${median}  max ${sorted.at(-1)}   <-- socket should be low single-digit seconds`,
  );
}
