// Checks that editing Details fields updates the image AND syncs its tags.
// Usage: node scripts/details-edit-test.mjs [baseUrl]
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
const headers = { cookie, "Content-Type": "application/json" };

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const form = new FormData();
form.append("file", new Blob([png], { type: "image/png" }), "details-test.png");
form.append("thumbnail", new Blob([png], { type: "image/webp" }), "t.webp");
form.append("hash", "details-test-" + Date.now());
form.append("width", "1");
form.append("height", "1");
const upRes = await fetch(`${BASE}/api/images`, {
  method: "POST",
  headers: { cookie },
  body: form,
});
if (upRes.status !== 201) throw new Error(`Upload failed: ${upRes.status}`);
const { image } = await upRes.json();

async function getDetail() {
  const res = await fetch(`${BASE}/api/images/${image.id}`, { headers: { cookie } });
  return res.json();
}
function characterTags(detail) {
  return detail.tags
    .filter((t) => t.category === "CHARACTER")
    .map((t) => t.canonical_name)
    .sort();
}

// 1. Set character to Alan and mood to two values
let res = await fetch(`${BASE}/api/images/${image.id}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ character: "Alan", mood: "Focused, Calm" }),
});
if (!res.ok) throw new Error(`PATCH 1 failed: ${res.status}`);
let detail = await getDetail();
console.log("after set:", detail.image.character, "| char tags:", characterTags(detail),
  "| mood tags:", detail.tags.filter((t) => t.category === "MOOD").map((t) => t.canonical_name).sort());

// 2. Correct Alan -> Mia
res = await fetch(`${BASE}/api/images/${image.id}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ character: "Mia" }),
});
if (!res.ok) throw new Error(`PATCH 2 failed: ${res.status}`);
detail = await getDetail();
const chars = characterTags(detail);
console.log("after fix:", detail.image.character, "| char tags:", chars);
if (detail.image.character !== "Mia" || chars.join() !== "Mia") {
  throw new Error("Character correction did not sync tags!");
}

// 3. Clear the field
res = await fetch(`${BASE}/api/images/${image.id}`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ character: "" }),
});
if (!res.ok) throw new Error(`PATCH 3 failed: ${res.status}`);
detail = await getDetail();
console.log("after clear:", detail.image.character, "| char tags:", characterTags(detail));
if (detail.image.character !== null || characterTags(detail).length !== 0) {
  throw new Error("Clearing the field did not remove the tag link!");
}

await fetch(`${BASE}/api/images/${image.id}`, { method: "DELETE", headers: { cookie } });
console.log("Details edit + tag sync OK.");
