// Tests the image detail endpoints against the LOCAL dev server.
// Usage:  node scripts/detail-test.mjs

import { createHash, randomBytes } from "node:crypto";

const BASE = "http://localhost:5173";

function fail(step, detail) {
  console.error(`FAIL at ${step}:`, detail);
  process.exit(1);
}

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "alan-dev" }),
});
const cookie = loginRes.headers.get("set-cookie").split(";")[0];
const jsonHeaders = { "content-type": "application/json", cookie };

// Upload a test image
const png = Buffer.concat([
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  ),
  randomBytes(8),
]);
const form = new FormData();
form.append("file", new Blob([png], { type: "image/png" }), "detail-test.png");
form.append("hash", createHash("sha256").update(png).digest("hex"));
const up = await fetch(`${BASE}/api/images`, {
  method: "POST",
  headers: { cookie },
  body: form,
});
const { image } = await up.json();
console.log("uploaded:", image.id);

// 1. Detail endpoint
let res = await fetch(`${BASE}/api/images/${image.id}`, { headers: { cookie } });
let data = await res.json();
if (!res.ok || data.image.id !== image.id || !Array.isArray(data.tags))
  fail("detail", JSON.stringify(data));
console.log("1. detail endpoint: OK");

// 2. Edit description → description_edited flag set
res = await fetch(`${BASE}/api/images/${image.id}`, {
  method: "PATCH",
  headers: jsonHeaders,
  body: JSON.stringify({ description: "My corrected description" }),
});
if (!res.ok) fail("patch description", await res.text());
res = await fetch(`${BASE}/api/images/${image.id}`, { headers: { cookie } });
data = await res.json();
if (
  data.image.description !== "My corrected description" ||
  data.image.description_edited !== 1
)
  fail("description flag", JSON.stringify(data.image));
console.log("2. description edit + protection flag: OK");

// 3. Add a project tag
res = await fetch(`${BASE}/api/images/${image.id}/tags`, {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ name: "Streamer Alan", category: "PROJECT" }),
});
data = await res.json();
const projectTag = data.tags.find(
  (t) => t.canonical_name === "Streamer Alan" && t.category === "PROJECT"
);
if (!projectTag || projectTag.source !== "USER") fail("add project tag", JSON.stringify(data));
console.log("3. add project tag: OK");

// 4. Adding the same name (different case) must reuse the same tag id
res = await fetch(`${BASE}/api/images/${image.id}/tags`, {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ name: "streamer alan", category: "PROJECT" }),
});
data = await res.json();
const sameTags = data.tags.filter(
  (t) => t.canonical_name.toLowerCase() === "streamer alan"
);
if (sameTags.length !== 1 || sameTags[0].id !== projectTag.id)
  fail("tag reuse", JSON.stringify(data.tags));
console.log("4. tag reuse (case-insensitive): OK");

// 5. Character tag addition (manual correction path)
res = await fetch(`${BASE}/api/images/${image.id}/tags`, {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ name: "Mia", category: "CHARACTER" }),
});
data = await res.json();
if (!data.tags.some((t) => t.canonical_name === "Mia" && t.category === "CHARACTER"))
  fail("character tag", JSON.stringify(data.tags));
console.log("5. manual character tag: OK");

// 6. Remove a tag
res = await fetch(`${BASE}/api/images/${image.id}/tags/${projectTag.id}`, {
  method: "DELETE",
  headers: { cookie },
});
if (!res.ok) fail("remove tag", await res.text());
res = await fetch(`${BASE}/api/images/${image.id}`, { headers: { cookie } });
data = await res.json();
if (data.tags.some((t) => t.id === projectTag.id)) fail("tag still present", "");
console.log("6. remove tag: OK");

// 7. Download header
res = await fetch(
  `${BASE}/api/media/${image.storage_key}?download=1&name=${encodeURIComponent("my photo.png")}`,
  { headers: { cookie } }
);
const disposition = res.headers.get("content-disposition") ?? "";
if (!disposition.includes('attachment; filename="my photo.png"'))
  fail("download header", disposition);
console.log("7. download header: OK");

// Cleanup
await fetch(`${BASE}/api/images/${image.id}`, { method: "DELETE", headers: { cookie } });
console.log("cleanup: test image deleted");

console.log("\nAll detail tests passed.");
