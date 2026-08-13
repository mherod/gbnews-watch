#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { streamComments, type StreamedComment } from "./src/stream";
import {
  containerIdFromPage,
  resolveContainerId,
  GBNEWS_LIVE_CONTAINER_UUID,
  GBNEWS_SECTION_UUID,
} from "./src/viafoura";

const { values } = parseArgs({
  options: {
    section: { type: "string", default: GBNEWS_SECTION_UUID },
    container: { type: "string" },
    "container-id": { type: "string" },
    page: { type: "string" },
    transport: { type: "string", default: "socket" },
    interval: { type: "string" },
    limit: { type: "string", default: "50" },
    backfill: { type: "string", default: "0" },
    replies: { type: "boolean", default: true },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false, short: "h" },
  },
  allowNegative: true,
});

if (values.help) {
  console.log(`gbnews-watch — stream GB News "Have Your Say" comments as they are posted

Usage: bun run cli [options]

  --page <url>           Resolve the thread from a GB News article URL
  --container-id <id>    Resolve the thread from a vf:container_id value
  --container <uuid>     Viafoura container UUID
                         (default: the /watch/live thread)
  --section <uuid>       Viafoura section UUID (default: GB News)
  --transport <mode>     socket (realtime push, default) or poll
  --interval <seconds>   Poll interval — the safety net under socket
                         (default: 30 for socket, 3 for poll)
  --limit <n>            Root comments fetched per poll (default: 50)
  --backfill <n>         Print the n most recent comments before going live
  --no-replies           Only follow top-level comments
  --json                 Emit newline-delimited JSON instead of text
  -h, --help             Show this message
`);
  process.exit(0);
}

const sectionUuid = values.section!;
const containerUuid = await resolveContainer();

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => controller.abort());
}

const colour = Bun.enableANSIColors && !values.json;
const dim = (s: string) => (colour ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (colour ? `\x1b[1m${s}\x1b[0m` : s);
const cyan = (s: string) => (colour ? `\x1b[36m${s}\x1b[0m` : s);
const yellow = (s: string) => (colour ? `\x1b[33m${s}\x1b[0m` : s);
const red = (s: string) => (colour ? `\x1b[31m${s}\x1b[0m` : s);

const transport = values.transport === "poll" ? "poll" : "socket";

if (!values.json) {
  console.log(dim(`Watching container ${containerUuid}`));
  console.log(
    dim(
      transport === "socket"
        ? "Realtime feed, with a REST poll as a safety net — Ctrl-C to stop\n"
        : `Polling every ${values.interval ?? 3}s — Ctrl-C to stop\n`,
    ),
  );
}

let count = 0;

for await (const event of streamComments({
  sectionUuid,
  containerUuid,
  transport,
  intervalMs: values.interval ? Number(values.interval) * 1000 : undefined,
  pageLimit: Number(values.limit),
  includeReplies: values.replies,
  backfill: Number(values.backfill),
  signal: controller.signal,
})) {
  switch (event.type) {
    case "comment":
      count++;
      console.log(values.json ? JSON.stringify(event.comment) : format(event.comment));
      break;
    case "primed":
      if (!values.json) console.log(dim(`Live. Tracking ${event.tracking} existing comments.\n`));
      break;
    case "notice":
      if (!values.json) console.error(yellow(event.text));
      break;
    case "error": {
      const message = event.error instanceof Error ? event.error.message : String(event.error);
      const line = `Poll failed (${message}) — retrying in ${event.retryInMs / 1000}s`;
      console.error(values.json ? JSON.stringify({ error: message, retryInMs: event.retryInMs }) : red(line));
      break;
    }
  }
}

if (!values.json) console.log(dim(`\nStopped after ${count} comment${count === 1 ? "" : "s"}.`));

function format(comment: StreamedComment): string {
  const time = comment.postedAt.toLocaleTimeString("en-GB", { hour12: false });
  const badges = [
    comment.isPinned && "PINNED",
    comment.isPicked && "FEATURED",
    comment.isTopComment && "TOP",
    comment.isEdited && "edited",
  ].filter(Boolean) as string[];

  const heading = [
    dim(time),
    bold(cyan(comment.author)),
    comment.replyingTo ? dim(`↳ ${comment.replyingTo}`) : "",
    badges.length ? yellow(badges.join(" ")) : "",
    comment.likes > 0 ? dim(`♥ ${comment.likes}`) : "",
  ]
    .filter(Boolean)
    .join("  ");

  const body = comment.body
    .split("\n")
    .map((line) => `          ${line}`)
    .join("\n");

  return `${heading}\n${body}\n`;
}

async function resolveContainer(): Promise<string> {
  if (values.container) return values.container;
  if (values["container-id"]) return resolveContainerId(sectionUuid, values["container-id"]);
  if (values.page) {
    const containerId = await containerIdFromPage(values.page);
    return resolveContainerId(sectionUuid, containerId);
  }
  return GBNEWS_LIVE_CONTAINER_UUID;
}
