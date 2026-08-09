// Tests the bulk-import batch tracking against the LOCAL dev server.
// Simulates a 3-file import: 1 uploads fine, 1 fails, 1 is skipped as duplicate.
// Then analyzes the uploaded one (one real sub-cent Claude call) and checks
// that the batch completes. Usage:  node scripts/batch-test.mjs

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
if (!loginRes.ok) fail("login", await loginRes.text());
const cookie = loginRes.headers.get("set-cookie").split(";")[0];
const jsonHeaders = { "content-type": "application/json", cookie };

// 1. Create batch
const batchRes = await fetch(`${BASE}/api/batches`, {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ filenames: ["a.png", "b.png", "c.png"] }),
});
if (batchRes.status !== 201) fail("create batch", await batchRes.text());
const { batchId, items } = await batchRes.json();
console.log("1. batch created:", batchId);

// 2. Upload file for item 0
const png = Buffer.concat([
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  ),
  randomBytes(8),
]);
const form = new FormData();
form.append("file", new Blob([png], { type: "image/png" }), "a.png");
form.append("hash", createHash("sha256").update(png).digest("hex"));
form.append("width", "1");
form.append("height", "1");
form.append("batch_item_id", items[0].id);
const uploadRes = await fetch(`${BASE}/api/images`, {
  method: "POST",
  headers: { cookie },
  body: form,
});
if (uploadRes.status !== 201) fail("upload", await uploadRes.text());
const { image } = await uploadRes.json();
console.log("2. item 0 uploaded:", image.id);

// 3. Mark item 1 failed, item 2 skipped
await fetch(`${BASE}/api/batches/items/${items[1].id}/fail`, {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ error: "Simulated network failure" }),
});
await fetch(`${BASE}/api/batches/items/${items[2].id}/skip`, {
  method: "POST",
  headers: { cookie },
});
console.log("3. item 1 marked failed, item 2 marked skipped");

// 4. Check progress
let res = await fetch(`${BASE}/api/batches/${batchId}`, { headers: { cookie } });
let data = await res.json();
console.log("4. progress:", JSON.stringify(data.progress));
if (
  data.progress.uploaded !== 1 ||
  data.progress.uploadFailed !== 1 ||
  data.progress.skipped !== 1 ||
  data.progress.pendingUpload !== 0
)
  fail("progress", data.progress);
if (data.batch.status !== "ACTIVE") fail("status should be ACTIVE", data.batch);

// 5. Active batch endpoint should find it
res = await fetch(`${BASE}/api/batches/active`, { headers: { cookie } });
data = await res.json();
if (data.batch?.id !== batchId) fail("active batch", data);
console.log("5. active batch endpoint: OK");

// 6. Analyze the uploaded image (real Claude call)
res = await fetch(`${BASE}/api/images/${image.id}/analyze`, {
  method: "POST",
  headers: { cookie },
});
if (!res.ok) fail("analyze", await res.text());
console.log("6. analysis: OK");

// 7. Batch should now be DONE with analysis counted
res = await fetch(`${BASE}/api/batches/${batchId}`, { headers: { cookie } });
data = await res.json();
console.log("7. final progress:", JSON.stringify(data.progress));
if (data.progress.analyzed !== 1) fail("analyzed count", data.progress);
if (data.batch.status !== "DONE") fail("batch should be DONE", data.batch);

// 8. No more active batch
res = await fetch(`${BASE}/api/batches/active`, { headers: { cookie } });
data = await res.json();
if (data.batch !== null) fail("active should be null", data);
console.log("8. batch closed correctly");

console.log("\nAll batch tests passed.");
