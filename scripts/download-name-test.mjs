// Verifies that downloads keep their file extension even with very long
// filenames (the bug: a 160-char AI-generated name lost its ".mp4" tail).
// Usage: node scripts/download-name-test.mjs [baseUrl]
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

const png = Buffer.from(
  "iVBORw0KGgoAAAABAAAAAQCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==".replace("AAAABAAAAAQ", "AAAAAQAAAAE"),
  "base64"
);
const longName =
  "freepik_alan-wearing-black-shades-and-a-red-and-blue-hoodie-lies-unconscious-and-immobile-on-the-bathroom-stall-floor-both-hands-gripping-the-base-of-the-toilet.png";

const form = new FormData();
form.append("file", new Blob([png], { type: "image/png" }), longName);
form.append("thumbnail", new Blob([png], { type: "image/webp" }), "t.webp");
form.append("hash", "dl-name-test-" + Date.now());
form.append("width", "1");
form.append("height", "1");
const upRes = await fetch(`${BASE}/api/images`, {
  method: "POST",
  headers: { cookie },
  body: form,
});
if (upRes.status !== 201) throw new Error(`Upload failed: ${upRes.status}`);
const { image } = await upRes.json();

const dlRes = await fetch(
  `${BASE}/api/media/${image.storage_key}?download=1&name=${encodeURIComponent(longName)}`,
  { headers: { cookie } }
);
const disposition = dlRes.headers.get("content-disposition") ?? "";
console.log("content-disposition:", disposition);

const filename = disposition.match(/filename="([^"]+)"/)?.[1];
if (!filename) throw new Error("No filename in Content-Disposition!");
if (!filename.endsWith(".png")) {
  throw new Error(`Extension lost! Got: ${filename}`);
}
if (filename.length > 130) throw new Error(`Filename still too long: ${filename.length}`);
console.log(`filename (${filename.length} chars) keeps its extension. OK`);

await fetch(`${BASE}/api/images/${image.id}`, { method: "DELETE", headers: { cookie } });
console.log("Download filename test passed.");
