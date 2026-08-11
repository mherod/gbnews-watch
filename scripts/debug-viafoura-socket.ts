/**
 * Probe the Viafoura realtime event feed from outside the browser.
 *
 * The GB News page keeps one socket open and receives every new comment on it,
 * body and all. This script tries to reproduce that subscription from Bun.
 *
 * Because the widget's original subscribe frame is sent before any page hook can
 * see it, the filter key is unknown — so we open several subscriptions at once,
 * each keyed differently, and see which subscription_id the events come back on.
 *
 *   bun scripts/debug-viafoura-socket.ts
 *   bun scripts/debug-viafoura-socket.ts --seconds 120 --raw
 */

import { parseArgs } from "node:util";
import { GBNEWS_LIVE_CONTAINER_UUID, GBNEWS_SECTION_UUID } from "../src/viafoura";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "90" },
    container: { type: "string", default: GBNEWS_LIVE_CONTAINER_UUID },
    section: { type: "string", default: GBNEWS_SECTION_UUID },
    raw: { type: "boolean", default: false },
  },
});

const SOCKET_URL = `wss://realtimeeventfeeds.viafoura.co/eventfeed?site_uuid=${values.section}`;

const COMMENT_MESSAGE_TYPES = ["livecomment_post", "reply_to_livecomment_post"];

/**
 * Each entry becomes one subscription. `container_uuid` alone was already proven
 * to filter correctly (other=0), but it still drags in a notification firehose —
 * so these probe whether extra rules are AND-ed server-side.
 */
const CANDIDATES: { key: string; rules: Record<string, string[]> }[] = [
  { key: "container", rules: { container_uuid: [values.container!] } },
  {
    key: "container+type",
    rules: { container_uuid: [values.container!], message_type: COMMENT_MESSAGE_TYPES },
  },
  {
    key: "container+type+action",
    rules: {
      container_uuid: [values.container!],
      message_type: COMMENT_MESSAGE_TYPES,
      action: ["visible"],
    },
  },
  { key: "type-only", rules: { message_type: COMMENT_MESSAGE_TYPES } },
];

const subscriptions = CANDIDATES.map((candidate) => ({ id: crypto.randomUUID(), ...candidate }));

console.log("--- setup ---");
console.log("socket:", SOCKET_URL);
for (const sub of subscriptions) {
  console.log(`  ${sub.id}  ${sub.key}  rules=${JSON.stringify(sub.rules)}`);
}

const byId = new Map(subscriptions.map((s) => [s.id, s]));
const stats = {
  frames: 0,
  unparseable: 0,
  bySubscription: new Map<string, number>(),
  byKind: new Map<string, number>(),
  subscribeReplies: [] as unknown[],
  unknownSubscription: 0,
  /** Per filter key: did the event actually belong to the container we asked for? */
  onTarget: new Map<string, { matching: number; other: number; containers: Set<string> }>(),
  /** Per filter key, counting only the comment events we would want to emit. */
  comments: new Map<string, number>(),
  /** Bytes delivered per filter key — how much noise each rule set costs. */
  bytes: new Map<string, number>(),
  firstNotification: null as unknown,
};

const COMMENT_TYPES = new Set(["livecomment_post", "reply_to_livecomment_post"]);

function tally(key: string, event: any) {
  const bucket = stats.onTarget.get(key) ?? { matching: 0, other: 0, containers: new Set<string>() };
  const container = String(event.container_uuid);
  if (container === values.container) bucket.matching++;
  else {
    bucket.other++;
    if (bucket.containers.size < 5) bucket.containers.add(container);
  }
  stats.onTarget.set(key, bucket);

  if (COMMENT_TYPES.has(event.message_type) && event.action === "visible") {
    stats.comments.set(key, (stats.comments.get(key) ?? 0) + 1);
  }
}

const started = performance.now();
const since = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;

const socket = new WebSocket(SOCKET_URL, {
  headers: { Origin: "https://www.gbnews.com" },
} as unknown as string[]);

socket.addEventListener("open", () => {
  console.log(`\n--- open (${since()}) ---`);
  for (const sub of subscriptions) {
    const frame = {
      type: "subscribe",
      subscription_id: sub.id,
      filter: {
        rules: Object.entries(sub.rules).map(([key, values]) => ({ type: "one_of", key, values })),
      },
    };
    console.log("send:", JSON.stringify(frame));
    socket.send(JSON.stringify(frame));
  }
});

socket.addEventListener("error", (event) => {
  console.log(`\n--- error (${since()}) ---`);
  console.dir(event, { depth: null });
});

socket.addEventListener("close", (event) => {
  console.log(`\n--- close (${since()}) code=${event.code} reason=${event.reason || "(none)"} ---`);
});

socket.addEventListener("message", (event) => {
  stats.frames++;
  const raw = typeof event.data === "string" ? event.data : "[binary]";

  let message: any;
  try {
    message = JSON.parse(raw);
  } catch {
    stats.unparseable++;
    console.log(`${since()} UNPARSEABLE len=${raw.length}:`, raw.slice(0, 200));
    return;
  }

  if (message.type === "subscribe") {
    stats.subscribeReplies.push(message);
    const sub = byId.get(message.subscription_id);
    console.log(
      `${since()} SUBSCRIBE-REPLY status=${message.status} key=${sub?.key ?? "?"} id=${message.subscription_id}`,
    );
    if (values.raw) console.dir(message, { depth: null });
    return;
  }

  const sub = byId.get(message.subscription_id);
  if (!sub) stats.unknownSubscription++;
  const label = sub?.key ?? `unknown(${message.subscription_id})`;
  stats.bySubscription.set(label, (stats.bySubscription.get(label) ?? 0) + 1);
  stats.bytes.set(label, (stats.bytes.get(label) ?? 0) + raw.length);

  const e = message.event ?? {};
  const kind = `${e.message_type} / ${e.action}`;
  stats.byKind.set(kind, (stats.byKind.get(kind) ?? 0) + 1);
  tally(sub?.key ?? "unknown", e);

  if (e.message_type === "notification" && !stats.firstNotification) stats.firstNotification = message;

  // The notification firehose drowns everything else, so only narrate the rest.
  const interesting = e.message_type !== "notification";
  const body = typeof e.payload?.content === "string" ? e.payload.content : "";
  if (interesting || values.raw) {
    console.log(
      `${since()} [${sub?.key ?? "??"}] ${kind}  state=${e.payload?.state ?? "-"}  container=${String(e.container_uuid).slice(0, 8)}  ${JSON.stringify(body.slice(0, 60))}`,
    );
  }
  if (values.raw) console.dir(message, { depth: null });
});

const keepAlive = setInterval(() => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "keep-alive" }));
}, 30_000);

await Bun.sleep(Number(values.seconds) * 1000);
clearInterval(keepAlive);
socket.close();

console.log(`\n--- summary after ${values.seconds}s ---`);
console.log("frames:", stats.frames, " unparseable:", stats.unparseable);
console.log("subscribe replies:", stats.subscribeReplies.length, "  <-- expected", subscriptions.length);
console.log("events per filter key:", Object.fromEntries(stats.bySubscription));
console.log("events per kind:", Object.fromEntries(stats.byKind));
console.log("events on an unknown subscription_id:", stats.unknownSubscription);

console.log("\n--- did the filter actually narrow to our container? ---");
for (const [key, bucket] of stats.onTarget) {
  console.log(
    `${key.padEnd(24)} ours=${String(bucket.matching).padStart(7)}  other=${String(bucket.other).padStart(7)}  other containers seen: ${[...bucket.containers].map((c) => c.slice(0, 8)).join(", ") || "(none)"}`,
  );
}

console.log("\n--- visible comment events (what we would emit) vs bytes delivered ---");
for (const sub of subscriptions) {
  const bytes = stats.bytes.get(sub.key) ?? 0;
  console.log(
    `${sub.key.padEnd(24)} events=${String(stats.bySubscription.get(sub.key) ?? 0).padStart(7)}  visible-comments=${String(stats.comments.get(sub.key) ?? 0).padStart(4)}  bytes=${(bytes / 1e6).toFixed(2)}MB`,
  );
}

if (stats.firstNotification) {
  console.log("\n--- sample notification event (the firehose) ---");
  console.dir(stats.firstNotification, { depth: 3 });
}
