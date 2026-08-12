# gbnews-watch

Streams GB News "Have Your Say" comments as they are posted — to a web UI, or to
your terminal.

```bash
bun install
bun run start      # http://localhost:3000
```

A single Bun process holds one upstream subscription and fans it out to every
open tab. Comments appear newest-first, typically under half a second after
someone hits send.

| Route | |
| --- | --- |
| `/` | the live feed UI |
| `/ws` | websocket — a snapshot on connect, then one message per comment |
| `/api/health` | buffered count, comments/min, upstream state, connected tabs |
| `/api/schedule` | the broadcast grid, plus the programme on air right now |

Set `PORT` to serve somewhere else.

## Terminal

```bash
bun run cli --backfill 10
```

```
00:16:41  Babs Berg  FEATURED
          So 17 year olds are having a problematic time, hmm...

00:16:46  Lee Holdsworth  ↳ Molly Sugden
          Spot on molly 👌
```

### Options

| Flag | Description |
| --- | --- |
| `--page <url>` | Resolve the thread from a GB News article URL |
| `--container-id <id>` | Resolve the thread from a `vf:container_id` value |
| `--container <uuid>` | Viafoura container UUID (default: the `/watch/live` thread) |
| `--section <uuid>` | Viafoura section UUID (default: GB News) |
| `--transport <mode>` | `socket` for realtime push (default) or `poll` |
| `--interval <seconds>` | Poll interval — the safety net under `socket` (default: `30` for socket, `3` for poll) |
| `--limit <n>` | Root comments fetched per poll (default: `50`) |
| `--backfill <n>` | Print the `n` most recent comments before going live |
| `--no-replies` | Only follow top-level comments |
| `--json` | Emit newline-delimited JSON instead of text |

Pipe the JSON mode anywhere:

```bash
bun run cli --json | jq -r '"\(.author): \(.body)"'
```

## Deploying to Vercel

```bash
vercel deploy
```

`vercel.json` is all the configuration needed — no environment variables, since
the Viafoura read APIs are public.

```json
{
  "framework": "bun",
  "bunVersion": "1.x",
  "regions": ["lhr1"]
}
```

`framework: bun` deploys the app as a Bun **backend**: Vercel detects `server.ts`
as the entrypoint, runs it on the Bun runtime so `Bun.serve` and its websockets
work exactly as they do locally, and routes every request — including `/ws`
upgrades — to it.

That backend model has one sharp edge worth knowing, because it cost two failed
deploys to find:

- **The function serves the frontend itself.** A Bun backend publishes nothing
  to the CDN and `includeFiles` is ignored for it, so a `public/` directory
  never reaches the function — assets 404. Instead, `bun run build`
  (`bundle-frontend.ts`) inlines the built HTML/CSS/JS into
  `web/frontend-assets.generated.ts`, which `server.ts` imports and serves from
  memory. That module is git-ignored and rebuilt on every deploy.
- **`server.ts` must never import `web/index.html`.** Vercel compiles the
  entrypoint with rolldown, which can't parse Bun's HTML-module import. That
  import — and the HMR it powers — lives in `dev.ts` (`bun run dev`) instead.

Three things also behave differently at runtime in production:

- **One subscription per instance, not per deployment.** Locally a single
  process holds one upstream socket for every tab. Vercel scales instances
  independently, so each one opens its own Viafoura subscription and runs its
  own backfill. Fine at this size, but it isn't the shared-upstream model.
- **Connections end when the function does.** `maxDuration` caps a websocket's
  life, so clients will periodically reconnect. The frontend already backs off
  exponentially, which is what Vercel's own websocket guidance recommends.
- **An idle socket still costs money.** A connection held open keeps an
  instance alive. A feed nobody is watching bills nothing only if nobody has a
  tab open.

If you would rather have the shared-upstream model and flat pricing, this same
server runs unchanged on any host that keeps a process alive — `bun run start`
behind a reverse proxy is the whole deployment.

## Layout

| | |
| --- | --- |
| `src/viafoura.ts` | REST client — comments, replies, user lookups, container resolution |
| `src/realtime.ts` | the websocket subscription and its reconnect loop |
| `src/schedule.ts` | the broadcast schedule, scraped from the `/watch/schedule` page |
| `src/stream.ts` | merges both sources into one de-duplicated stream |
| `src/app-server.ts` | serves the UI and fans the stream out to browser tabs |
| `web/` | the React frontend, bundled by Bun's HTML import |
| `index.ts` | the server — also Vercel's detected entrypoint |
| `cli.ts` | the terminal client |

`app-server.ts` takes its stream as an argument rather than creating one, so
tests drive the websocket without waiting on live GB News traffic.

## How it works

GB News' comments run on [Viafoura](https://viafoura.com). Nothing here needs a
login or an API key.

**Realtime (default).** The page keeps one websocket open to
`wss://realtimeeventfeeds.viafoura.co/eventfeed?site_uuid={section}` and receives
every new comment on it — the whole comment, not just an id. `src/realtime.ts`
opens the same socket and sends:

```json
{ "type": "subscribe", "subscription_id": "<uuid>", "filter": { "rules": [
  { "type": "one_of", "key": "container_uuid", "values": ["<container>"] },
  { "type": "one_of", "key": "message_type", "values": ["livecomment_post", "reply_to_livecomment_post"] },
  { "type": "one_of", "key": "action", "values": ["created", "visible"] }
]}}
```

The rules are AND-ed server-side, and all three matter. Over one 75-second
window, filtering on `container_uuid` alone delivered 57,199 events / 93 MB —
99.8% of it an unrelated notification firehose. Adding the `message_type` and
`action` rules brought the same comments down to 0.02 MB. Keep-alives go up
every 30s as `{"type":"keep-alive"}`.

Each comment is announced twice: `action: "created"` while it awaits moderation,
then `action: "visible"` once it clears. Only `payload.state === "visible"` is
emitted.

**REST.** Used as a slow safety net under the socket, and as the only source
under `--transport poll`:

- `GET https://livecomments.viafoura.co/v4/livecomments/{section}/{container}/comments?limit&sorted_by=newest`
  — newest-first page of top-level comments.
- `GET .../comments/{thread_uuid}?limit` — replies belonging to one thread.
- `GET https://iam.viafoura.co/v3/sections/{section}/users/{actor_uuid}` — display
  names, which comments carry only as `actor_uuid`.

The poll watches each thread's `total_replies` and only re-fetches a thread when
that count changes. Both sources feed one de-duplication set keyed on
`content_uuid`, so a comment seen twice is emitted once and a socket reconnect
loses nothing.

Measured on the live feed: socket median **398 ms** behind the posted timestamp,
3-second polling median **2,557 ms**.

### The broadcast schedule

There is no public schedule JSON endpoint. The `/watch/schedule` page ships the
complete multi-week grid inline as `window.schedule_response = [...]` and its
date picker only filters that array client-side — confirmed with a full network
capture (no schedule XHR on load or on date change). `src/schedule.ts` fetches
the page, extracts that array, and normalises it.

The array is a JavaScript literal, **not JSON**: strings are single-quoted
until a value contains an apostrophe, then that one string is double-quoted
instead — a Python-repr habit inherited from upstream. Public evidence from
2023 places that upstream in Azure (Synapse → Logic App → API Management as
`FetchRecordsFromDatabase/manual-invoke`, on RebelMouse post `2659031149`),
but the pipeline's current shape is unconfirmed, so the parser trusts only the
literal's grammar, accepts both JSON and Python spellings of null/booleans,
and fails loudly on anything else.

Quirks observed live and normalised (details in the `schedule.ts` docblock):
the page's "All times GMT" label is wrong in summer (timestamps carry the
correct `+01:00`, so parsing into Dates settles it), presenter section ids
arrive duplicated, image URLs double their `&` separators, and continuity
slots (the national anthem) have null section ids and zero duration.

The page weighs ~600 KB, so the grid is cached in two layers: process memory,
fresh for 30 minutes, and the same Upstash/Redis/file snapshot store the room
memory sleeps in — a cold start adopts the last scrape instead of hitting
gbnews.com per instance. A stored grid lives exactly as long as it stays
relevant: its key expires when its final programme ends, and the loader
re-checks that horizon for backends without native expiry. "On air now" is
computed per request from the cached copy, and a failed or empty refresh
keeps serving the previous grid — memory first, then store — for as long as
one exists.

### Container UUIDs

`--page` reads the page's `<meta name="vf:container_id">` and resolves it via
`/contentcontainer/id`. That works for regular articles, but **not** for
`/watch/live`: its meta tag points at an unused, empty container. The live
thread's real UUID (`d4eb1580-3fa5-439d-8a54-66c0fc445290`) is the default and
is hardcoded in `src/viafoura.ts`.

## Tests

```bash
bun test
```

## Diagnostic scripts

Kept around so the next investigation starts from evidence rather than guesswork:

```bash
bun scripts/debug-viafoura-socket.ts --seconds 75
```

Opens several subscriptions side by side with different filter rules and reports
events, matched container, and bytes per rule set. This is what established that
the rules are AND-ed.

```bash
bun scripts/debug-stream-latency.ts --seconds 90 --transport socket
```

Runs the real stream and reports, per comment, which source delivered it first
and how far behind the posted timestamp it arrived.

```bash
bun scripts/debug-empty-state.ts
```

Serves the real UI against a source that never emits, so the waiting state can
be inspected without waiting for GB News to go quiet.
