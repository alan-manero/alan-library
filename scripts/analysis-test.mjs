// Tests the AI analysis pipeline against the LOCAL dev server.
// Uploads a small generated image, asks the server to analyze it with Claude,
// and prints the resulting metadata. Costs a fraction of a cent.
// Usage:  node scripts/analysis-test.mjs

import { createHash, randomBytes } from "node:crypto";

const BASE = "http://localhost:5173";
const PASSWORD = "alan-dev";

// A tiny valid 1x1 PNG plus random trailing bytes so every run has a unique hash
// (PNG decoders ignore data after the IEND chunk).
const png = Buffer.concat([
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  ),
  randomBytes(8),
]);

const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: PASSWORD }),
});
if (!loginRes.ok) {
  console.error("Login failed:", await loginRes.text());
  process.exit(1);
}
const cookie = loginRes.headers.get("set-cookie").split(";")[0];

const form = new FormData();
form.append("file", new Blob([png], { type: "image/png" }), "analysis-test.png");
form.append("hash", createHash("sha256").update(png).digest("hex"));
form.append("width", "1");
form.append("height", "1");
const uploadRes = await fetch(`${BASE}/api/images`, {
  method: "POST",
  headers: { cookie },
  body: form,
});
if (uploadRes.status !== 201) {
  console.error("Upload failed:", await uploadRes.text());
  process.exit(1);
}
const { image } = await uploadRes.json();
console.log("Uploaded test image:", image.id);

console.log("Analyzing with Claude…");
const analyzeRes = await fetch(`${BASE}/api/images/${image.id}/analyze`, {
  method: "POST",
  headers: { cookie },
});
const result = await analyzeRes.json();
console.log("HTTP", analyzeRes.status);
console.log(JSON.stringify(result, null, 2));
process.exit(analyzeRes.ok ? 0 : 1);
