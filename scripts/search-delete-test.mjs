// Tests search, filters and deletion against the LOCAL dev server.
// Plants known metadata via the local database, then queries the API.
// Usage:  node scripts/search-delete-test.mjs

import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";

const BASE = "http://localhost:5173";

function sql(command) {
  execSync(
    `npx wrangler d1 execute alan-library-db --local --command "${command.replace(/"/g, '\\"')}"`,
    { stdio: "pipe" }
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The dev server can briefly drop connections after external DB writes,
// so retry transient network failures.
async function fetchRetry(url, options, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (i === attempts - 1) throw err;
      await sleep(1000);
    }
  }
}

function fail(step, detail) {
  console.error(`FAIL at ${step}:`, detail);
  process.exit(1);
}

const loginRes = await fetchRetry(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "alan-dev" }),
});
const cookie = loginRes.headers.get("set-cookie").split(";")[0];

async function uploadImage(name) {
  const png = Buffer.concat([
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    ),
    randomBytes(8),
  ]);
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), name);
  form.append("hash", createHash("sha256").update(png).digest("hex"));
  const res = await fetchRetry(`${BASE}/api/images`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  if (res.status !== 201) fail(`upload ${name}`, await res.text());
  return (await res.json()).image;
}

async function search(params) {
  const res = await fetchRetry(`${BASE}/api/images?${params}`, { headers: { cookie } });
  return res.json();
}

// --- Setup: two images with known metadata ---
const a = await uploadImage("alan-computer.png");
const b = await uploadImage("mia-club.png");
console.log("uploaded:", a.id, b.id);

sql(`UPDATE images SET description = 'Alan sitting at his computer in a dark bedroom at night', character = 'Alan', location = 'Bedroom', mood = 'Tired', analysis_status = 'READY' WHERE id = '${a.id}'`);
sql(`UPDATE images SET description = 'Mia dancing in a club', character = 'Mia', location = 'Club', mood = 'Excited', analysis_status = 'READY' WHERE id = '${b.id}'`);
sql(`INSERT INTO image_tags (image_id, tag_id, source) SELECT '${a.id}', id, 'AI' FROM tags WHERE (canonical_name = 'Alan' AND category = 'CHARACTER') OR (canonical_name = 'Computer' AND category = 'OBJECT') OR (canonical_name = 'Tired' AND category = 'MOOD')`);
sql(`INSERT INTO image_tags (image_id, tag_id, source) SELECT '${b.id}', id, 'AI' FROM tags WHERE (canonical_name = 'Mia' AND category = 'CHARACTER') OR (canonical_name = 'Club' AND category = 'LOCATION')`);
console.log("metadata planted");

// --- Search tests ---
let r = await search("q=computer");
if (r.total !== 1 || r.images[0].id !== a.id) fail("q=computer", JSON.stringify(r));
console.log("search 'computer': OK");

r = await search("q=alan%20bedroom");
if (r.total !== 1 || r.images[0].id !== a.id) fail("q=alan bedroom", JSON.stringify(r));
console.log("search 'alan bedroom' (multi-word): OK");

r = await search("q=dancing");
if (r.total !== 1 || r.images[0].id !== b.id) fail("q=dancing", JSON.stringify(r));
console.log("search 'dancing': OK");

r = await search("q=spaceship");
if (r.total !== 0) fail("q=spaceship", JSON.stringify(r));
console.log("search with no matches: OK");

// --- Filter tests (tag ids straight from the API) ---
const tagsRes = await fetchRetry(`${BASE}/api/tags`, { headers: { cookie } });
const { tags } = await tagsRes.json();
const tiredTag = tags.find((t) => t.canonical_name === "Tired" && t.category === "MOOD");
const miaTag = tags.find((t) => t.canonical_name === "Mia" && t.category === "CHARACTER");

r = await search(`tags=${tiredTag.id}`);
if (r.total !== 1 || r.images[0].id !== a.id) fail("filter Tired", JSON.stringify(r));
console.log("filter Mood=Tired: OK");

r = await search(`q=club&tags=${miaTag.id}`);
if (r.total !== 1 || r.images[0].id !== b.id) fail("search+filter combo", JSON.stringify(r));
console.log("combined search + filter: OK");

r = await search("has_videos=1");
if (r.total !== 0) fail("has_videos=1", JSON.stringify(r));
console.log("filter has_videos: OK");

// --- Delete: image without videos ---
let res = await fetchRetry(`${BASE}/api/images/${b.id}`, { method: "DELETE", headers: { cookie } });
if (!res.ok) fail("delete without videos", await res.text());
r = await search("q=dancing");
if (r.total !== 0) fail("b should be gone", JSON.stringify(r));
console.log("delete without videos: OK");

// --- Delete: image WITH videos → 409 first, then explicit ---
sql(`INSERT INTO videos (id, parent_image_id, original_filename, storage_key, mime_type, file_size) VALUES ('testvid1', '${a.id}', 'clip.mp4', 'videos/originals/testvid1.mp4', 'video/mp4', 123)`);
res = await fetchRetry(`${BASE}/api/images/${a.id}`, { method: "DELETE", headers: { cookie } });
if (res.status !== 409) fail("expected 409", `${res.status} ${await res.text()}`);
const conflict = await res.json();
if (conflict.videoCount !== 1) fail("videoCount", JSON.stringify(conflict));
console.log("delete with videos correctly asks first (409): OK");

res = await fetchRetry(`${BASE}/api/images/${a.id}?with_videos=1`, { method: "DELETE", headers: { cookie } });
const del = await res.json();
if (!res.ok || del.deletedVideos !== 1) fail("delete with videos", JSON.stringify(del));
r = await search("");
if (r.images.some((i) => i.id === a.id)) fail("a should be gone", "still present");
console.log("explicit delete with videos: OK");

console.log("\nAll search/filter/delete tests passed.");
