/**
 * Proves the Upstash REST wiring against the real service, without touching
 * the live room key: save → load → compare on a scratch key, then delete it.
 *
 * Credentials come from the environment. If they aren't already loaded, the
 * script falls back to reading .env.production.local (created by
 * `vercel env pull .env.production.local --environment=production`).
 * Nothing secret is ever printed — only pass/fail.
 *
 * Run: bun scripts/debug-upstash-roundtrip.ts
 */

import { upstashRestRoomStore } from "../src/room-store";

let url = process.env.KV_REST_API_URL;
let token = process.env.KV_REST_API_TOKEN;

if (!url || !token) {
  const envFile = Bun.file(".env.production.local");
  if (await envFile.exists()) {
    for (const line of (await envFile.text()).split("\n")) {
      const m = /^(KV_REST_API_URL|KV_REST_API_TOKEN)="?([^"\n]+)"?$/.exec(line.trim());
      if (m?.[1] === "KV_REST_API_URL") url = m[2];
      if (m?.[1] === "KV_REST_API_TOKEN") token = m[2];
    }
  }
}

if (!url || !token) {
  console.error(
    "no usable Upstash REST credentials.\n" +
      "Note: Vercel's Upstash integration marks these variables sensitive, so\n" +
      "`vercel env pull` writes them as empty strings — they only decrypt inside\n" +
      "Vercel's runtime. To run this locally, paste the values from the Upstash\n" +
      "console into KV_REST_API_URL / KV_REST_API_TOKEN in your shell env.",
  );
  process.exit(1);
}

const SCRATCH_KEY = "gbnews-watch:room:selftest";
const store = upstashRestRoomStore(url, token, SCRATCH_KEY);
const payload = `{"selftest":true,"at":${Date.now()}}`;

console.log("credentials present:", true);

await store.save(payload);
console.log("save: ok");

const back = await store.load();
console.log("load matches save:", back === payload, "  <-- expected true");

// Clean the scratch key up so nothing lingers in the production store.
const del = await fetch(`${url.replace(/\/$/, "")}/del/${encodeURIComponent(SCRATCH_KEY)}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
});
console.log("scratch key deleted:", del.ok);

const gone = await store.load();
console.log("scratch key now absent:", gone === null, "  <-- expected true");
