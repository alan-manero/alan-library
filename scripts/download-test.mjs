// Verifies that ?download=1 media URLs actually return an attachment.
// Usage: node scripts/download-test.mjs [baseUrl]
import { readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:5173";

const devVars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
const password = devVars.match(/^APP_PASSWORD\s*=\s*"?([^"\r\n]+)"?/m)?.[1];
if (!password) throw new Error("APP_PASSWORD not found in .dev.vars");

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status}`);
const cookie = loginRes.headers.get("set-cookie").split(";")[0];
console.log("Logged in.");

// Tiny 1x1 PNG
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const form = new FormData();
form.append("file", new Blob([png], { type: "image/png" }), "dl-test.png");
form.append("thumbnail", new Blob([png], { type: "image/webp" }), "t.webp");
form.append("hash", "dl-test-" + Date.now());
form.append("width", "1");
form.append("height", "1");

const upRes = await fetch(`${BASE}/api/images`, {
  method: "POST",
  headers: { cookie },
  body: form,
});
if (upRes.status !== 201) throw new Error(`Upload failed: ${upRes.status}`);
const { image } = await upRes.json();
console.log("Uploaded:", image.storage_key);

for (const [label, url] of [
  ["inline ", `${BASE}/api/media/${image.storage_key}`],
  [
    "download",
    `${BASE}/api/media/${image.storage_key}?download=1&name=${encodeURIComponent("my file.png")}`,
  ],
]) {
  const res = await fetch(url, { headers: { cookie } });
  console.log(
    `${label} -> status=${res.status}`,
    `type=${res.headers.get("content-type")}`,
    `disposition=${res.headers.get("content-disposition")}`
  );
  await res.arrayBuffer();
}

// Simulate a top-level navigation (no cookie header) to see what the
// browser would get if the session cookie were missing.
const noCookieRes = await fetch(
  `${BASE}/api/media/${image.storage_key}?download=1`,
  { redirect: "manual" }
);
console.log(
  `no-cookie -> status=${noCookieRes.status}`,
  `type=${noCookieRes.headers.get("content-type")}`,
  `location=${noCookieRes.headers.get("location")}`
);

// Clean up
await fetch(`${BASE}/api/images/${image.id}`, {
  method: "DELETE",
  headers: { cookie },
});
console.log("Cleaned up.");
