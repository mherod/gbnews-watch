# gbnews-watch

Streams GB News "Have Your Say" comments to your terminal as they are posted.

```bash
bun install
bun run index.ts
```

Comments and replies appear oldest-first as they arrive:

```
00:16:41  Babs Berg  FEATURED
          So 17 year olds are having a problematic time, hmm...

00:16:46  Lee Holdsworth  ↳ Molly Sugden
          Spot on molly 👌
```

## Options

| Flag | Description |
| --- | --- |
| `--page <url>` | Resolve the thread from a GB News article URL |
| `--container-id <id>` | Resolve the thread from a `vf:container_id` value |
| `--container <uuid>` | Viafoura container UUID (default: the `/watch/live` thread) |
| `--section <uuid>` | Viafoura section UUID (default: GB News) |
| `--interval <seconds>` | Poll interval (default: `3`) |
| `--limit <n>` | Root comments fetched per poll (default: `50`) |
| `--backfill <n>` | Print the `n` most recent comments before going live |
| `--no-replies` | Only follow top-level comments |
| `--json` | Emit newline-delimited JSON instead of text |

Pipe the JSON mode anywhere:

```bash
bun run index.ts --json | jq -r '"\(.author): \(.body)"'
```

## How it works

GB News' comments run on [Viafoura](https://viafoura.com). The read APIs are
public — no login, no API key:

- `GET https://livecomments.viafoura.co/v4/livecomments/{section}/{container}/comments?limit&sorted_by=newest`
  — newest-first page of top-level comments.
- `GET .../comments/{thread_uuid}?limit` — replies belonging to one thread.
- `GET https://iam.viafoura.co/v3/sections/{section}/users/{actor_uuid}` — display
  names, which comments carry only as `actor_uuid`.

`src/stream.ts` polls the first endpoint and de-duplicates by `content_uuid`. It
watches each thread's `total_replies` and only re-fetches a thread when that
count changes, so replies are picked up without polling every thread.

The browser widget gets new comments pushed over a websocket rather than
polling. Swapping the poll loop for that socket would cut latency, but polling
needs no session and reconnects for free.

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
