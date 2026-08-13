# gbnews-watch

Streams GB News "Have Your Say" comments as they are posted — to a web UI, or to
your terminal.

To be clear about proportion: this repo holds a realtime push subscription with
a REST safety net, a hand-vetted entity lexicon, sentiment analysis tuned to
its audience, a two-layer schedule cache, and an exponentially-decaying topic
memory that survives serverless cold starts — so that when someone types
"Spot on molly 👌" under the breakfast programme, it reaches your screen about
400 milliseconds later. Every engineering decision here was made in earnest.
The subject matter declined to reciprocate.

```bash
bun install
bun run dev        # http://localhost:3000
```

`bun run dev` is the whole local setup — Bun bundles the React frontend on the
fly and hot-reloads it. The production shape is `bun run build && bun run
start`, which inlines the built frontend first; `start` without a build serves
the API and websocket only, and says so on boot.

A single Bun process holds one upstream subscription and fans it out to every
open tab. Comments appear newest-first, typically under half a second after
someone hits send.

| Route | |
| --- | --- |
| `/` | the live feed UI |
| `/ws` | websocket — a snapshot on connect, then one message per comment |
| `/api/health` | buffered count, comments/min, upstream state, connected tabs |
| `/api/schedule` | the broadcast grid, plus the programme on air right now |
| `/api/room` | the shared topic memory — every visitor renders this same graph |
| `/api/corpus` | news-cycle vocabulary from the site's RSS, used only to weight topic detection |

## The feed

What the browser shows, top to bottom:

- **The Room** — a live force-directed map of what the comments are arguing
  about, drawn to canvas. Each topic is a body of mass: bigger the more it has
  been dominating lately, redder as the comments mentioning it turn angry,
  greener as they warm up — and tethered to another topic when the two are
  argued in the same breath. Which grievances travel as a pair is the shape
  worth watching. Click a body to filter the feed to it.
- **Trend chips** — words and phrases surging in the stream, rising/falling
  arrows included. Click one to filter; the **Conservative** chip also catches
  "Tory". When nothing has caught on with more than one person, the row admits
  "· quiet" rather than inventing news.
- **The mood** — a rough temperature taken from words and emoji: *heated*,
  *grumbly*, *mixed*, *warm* or *buzzing*, with the split shown when the room
  genuinely disagrees ("60% 🔥 · 40% 🙂").
- **Top emoji** — the last five minutes' emoji leaderboard, one-offs ignored.
  Click one to filter to the comments carrying it.
- **On air now** — the current programme from the scraped schedule, so a surge
  can be attributed to whoever provoked it.
- **The feed itself** — newest-first under a 90-second activity sparkline,
  with a rate meter that counts when comments were *posted* rather than when
  they arrived (a replayed backfill must not read as a 40-comment rush),
  replies quoting the comment they answer, and frequent posters flagged once
  they manage three comments in five minutes.

## Configuration

Nothing is required — with an empty environment the server runs memory-only and
the feed works fully. Persistence is an environment decision, not a code one:

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `3000` | Where the server listens. |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | — | Room memory and schedule snapshots go to Upstash over REST — preferred on serverless, where a stateless request can't go stale between invocations. Vercel's Upstash integration sets both. |
| `REDIS_URL` (or `KV_URL`) | — | The same snapshots over Redis TCP, `rediss://` TLS included. |
| `ROOM_MEMORY_FILE` | `.room-memory.json` (dev) | Path for the room memory's file store, and permission to use the file backend outside dev. Upstash/Redis still win when configured. |

The first match wins: Upstash REST → Redis → a JSON file (dev, where the
filesystem outlives the process) → none. Losing the store costs continuity,
not correctness — the room memory becomes warm-lifetime only, and each cold
start re-scrapes the schedule.

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

`vercel.json` is all the configuration needed — no environment variables are
required, since the Viafoura read APIs are public. The one integration worth
attaching is Upstash (or set `REDIS_URL`): it is what lets the room memory and
the schedule snapshot survive cold starts.

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
  independently, so each one opens its own Viafoura subscription, runs its own
  backfill, and learns its own room memory — instances trade last-writer-wins
  snapshots through the shared store. Fine at this size, but nobody would call
  it consensus.
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
| `src/stream.ts` | merges both sources into one de-duplicated stream |
| `src/schedule.ts` | the broadcast schedule, scraped from the `/watch/schedule` page |
| `src/trending.ts` | words and phrases surging against their own prior |
| `src/entities.ts` | curated entity aliases — "Tory"/"Tories" → **Conservative** |
| `src/sentiment.ts` | the room's temperature, AFINN-style, tuned to this audience |
| `src/emoji.ts` | grapheme-aware emoji counting — 🇬🇧 is one emoji, not two |
| `src/corpus.ts` | news-cycle vocabulary from the site's RSS feed |
| `src/graph.ts` | the amnesiac co-mention graph of the last few minutes |
| `src/memory.ts` | the long-lived one — reinforcement, decay, broadcast attribution |
| `src/room-store.ts` | where the memory sleeps: Upstash REST, Redis, or a file |
| `src/wire.ts` | the websocket message types both ends agree on |
| `src/app-server.ts` | serves the UI, fans the stream out, runs the learning tick |
| `web/` | the React frontend; `constellation.tsx` draws The Room |
| `server.ts` | production entrypoint — what Vercel detects and runs |
| `dev.ts` | dev entrypoint — Bun HTML import, HMR |
| `bundle-frontend.ts` | inlines the built frontend for serverless (`bun run build`) |
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

### Topic detection

The trend chips and The Room share one pipeline of pure functions:

- **`trending.ts`** scores words and two-word phrases by how hard they surge
  against their own prior, and requires breadth across distinct authors — one
  person cannot manufacture a trend, however hard they post. Engagement counts
  too: a liked, replied-to comment lifts the words it uses.
- **`entities.ts`** merges aliases into one canonical topic and carries the
  disambiguation this particular corpus demands: `UN` only counts when
  capitalised, because the audience writes "wrong'un" considerably more often
  than it discusses the United Nations. Likewise `VAT` (the tax, not the
  container) and the Home Office (the department, not the spare room).
- **`corpus.ts`** reads the site's own RSS headlines for the live news-cycle
  vocabulary, so a name can be recognised before the chat has repeated it
  enough to trend on its own. It only ever weights detection — nothing from
  the feed is rendered.
- **`sentiment.ts`** is an AFINN-style lexicon deliberately weighted toward
  the vocabulary these commenters actually use — "marvellous" scores +3,
  "spineless" −2 — and reads emoji as first-class signals (💩 is −3, which
  feels right).

The stopword list keeps a dedicated section for the debris left when a
non-standard apostrophe splits a contraction — `doesn`, `didn`, `wouldn` —
which is as close as this repo comes to a style guide for its input.

### The Room's memory

The map is not a per-tab visualisation. It is one shared memory, learned
server-side on an 8-second tick from every comment the server sees, whether or
not anyone has a tab open — it used to live in each browser's localStorage,
which meant it only learned while someone watched and every visitor saw a
private graph. Now `/api/room` serves the same map to everyone.

Topics are reinforced each time they appear and decay exponentially with a
45-minute half-life: a link seen once an hour survives, a link seen once ever
fades out, and a link hammered all evening becomes structural. Node size
follows accumulated, decayed weight — how much the topic has been dominating —
with distinct voices as a floor. Voices are counted as distinct commenter ids,
capped at sixteen, because a running total would credit the same commenter on
every batch and turn one obsessive into a crowd.

Each topic also accumulates which programmes it was argued under, attributed at
learning time against whatever the schedule says is on air, decayed like
everything else, and capped at six programmes — a topic that outlives six
programmes has stopped being *about* any of them.

With a store configured (see Configuration) the memory survives process death:
hydrated once at boot, snapshotted after every tick. The snapshot keeps the
seen-comment list, so a backfill replayed after a restart is not counted twice,
and the decay clock, so downtime ages the graph exactly as elapsed time should.

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

The analysis pipeline is pure functions end to end, so the suite runs in about
a second and none of it needs GB News to be on air.

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

```bash
bun scripts/debug-merge-overlap.ts
```

Replays the live case where "bbq's" and "disposable BBQ" trended as two
separate chips, printing the stems and capitalisation flags the merge rule
reads and the chips that result.

```bash
bun scripts/debug-upstash-roundtrip.ts
```

Proves the Upstash REST wiring against the real service without touching the
live room key: save → load → compare on a scratch key, then delete it.
Credentials come from the environment, falling back to `.env.production.local`
(from `vercel env pull`). Nothing secret is printed.
