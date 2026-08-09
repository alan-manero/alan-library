// Quick end-to-end test of the upload API against the LOCAL dev server.
// Usage:  node scripts/smoke-test.mjs
// Requires `npm run dev` to be running.

import { createHash } from "node:crypto";

const BASE = "http://localhost:5173";
const PASSWORD = "alan-dev";

// A tiny valid 1x1 PNG.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function fail(step, detail) {
  console.error(`FAIL at ${step}:`, detail);
  process.exit(1);
}

// 1. Login
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: PASSWORD }),
});
if (!loginRes.ok) fail("login", await loginRes.text());
const cookie = loginRes.headers.get("set-cookie").split(";")[0];
console.log("1. login: OK");

// 2. Duplicate check for a hash that should not exist yet
const hash = createHash("sha256").update(png).digest("hex");
const dupRes = await fetch(`${BASE}/api/images/check-hash`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ hash }),
});
const dupBefore = await dupRes.json();
console.log("2. duplicate check before upload:", dupBefore);

// 3. Upload
const form = new FormData();
form.append("file", new Blob([png], { type: "image/png" }), "smoke-test.png");
form.append("thumbnail", new Blob([png], { type: "image/webp" }), "t.webp");
form.append("hash", hash);
form.append("width", "1");
form.append("height", "1");
const uploadRes = await fetch(`${BASE}/api/images`, {
  method: "POST",
  headers: { cookie },
  body: form,
});
if (uploadRes.status !== 201) fail("upload", await uploadRes.text());
const { image } = await uploadRes.json();
console.log("3. upload: OK →", image.id, image.storage_key);

// 4. List
const listRes = await fetch(`${BASE}/api/images`, { headers: { cookie } });
const list = await listRes.json();
if (!list.images.some((i) => i.id === image.id)) fail("list", "uploaded image missing");
console.log(`4. list: OK (${list.total} images total)`);

// 5. Fetch the stored file back from R2
const mediaRes = await fetch(`${BASE}/api/media/${image.storage_key}`, {
  headers: { cookie },
});
const body = Buffer.from(await mediaRes.arrayBuffer());
if (!mediaRes.ok || !body.equals(png)) fail("media", `status ${mediaRes.status}`);
console.log("5. media download: OK (bytes identical)");

// 6. Duplicate check should now find it
const dupRes2 = await fetch(`${BASE}/api/images/check-hash`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ hash }),
});
const dupAfter = await dupRes2.json();
if (!dupAfter.duplicate) fail("duplicate-after", dupAfter);
console.log("6. duplicate detection: OK");

console.log("\nAll smoke tests passed.");
