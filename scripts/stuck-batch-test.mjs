// Simulates the "stuck import panel" bug: a batch whose image was uploaded
// but whose AI analysis never completed (page closed mid-import).
// Verifies: (1) dismiss closes an ACTIVE batch, (2) deleting the image lets
// the batch auto-complete.
// Usage: node scripts/stuck-batch-test.mjs [baseUrl]
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
const jsonHeaders = { cookie, "Content-Type": "application/json" };

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function uploadStuckBatch(label) {
  const batchRes = await fetch(`${BASE}/api/batches`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ filenames: [`${label}.png`] }),
  });
  const { batchId, items } = await batchRes.json();

  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), `${label}.png`);
  form.append("thumbnail", new Blob([png], { type: "image/webp" }), "t.webp");
  form.append("hash", `${label}-` + Date.now());
  form.append("width", "1");
  form.append("height", "1");
  form.append("batch_item_id", items[0].id);
  const upRes = await fetch(`${BASE}/api/images`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  if (upRes.status !== 201) throw new Error(`Upload failed: ${upRes.status}`);
  const { image } = await upRes.json();
  // Deliberately never call /analyze: the item stays stuck mid-analysis.
  return { batchId, image };
}

async function activeBatch() {
  const res = await fetch(`${BASE}/api/batches/active`, { headers: { cookie } });
  return (await res.json()).batch;
}

// Case 1: stuck ACTIVE batch can be dismissed
const a = await uploadStuckBatch("stuck-dismiss");
let active = await activeBatch();
if (!active || active.status !== "ACTIVE") throw new Error("Expected an ACTIVE batch");
console.log("case 1: batch is ACTIVE (stuck), dismissing...");
const dismissRes = await fetch(`${BASE}/api/batches/${a.batchId}/dismiss`, {
  method: "POST",
  headers: { cookie },
});
if (!dismissRes.ok) throw new Error(`Dismiss failed: ${dismissRes.status}`);
active = await activeBatch();
if (active) throw new Error("Batch still active after dismiss!");
console.log("case 1: dismissed, no active batch remains. OK");
await fetch(`${BASE}/api/images/${a.image.id}`, { method: "DELETE", headers: { cookie } });

// Case 2: deleting the image completes the batch on its own
const b = await uploadStuckBatch("stuck-delete");
active = await activeBatch();
if (!active || active.status !== "ACTIVE") throw new Error("Expected an ACTIVE batch");
console.log("case 2: batch is ACTIVE, deleting its image...");
await fetch(`${BASE}/api/images/${b.image.id}`, { method: "DELETE", headers: { cookie } });
active = await activeBatch();
if (active) throw new Error("Batch still active after its image was deleted!");
console.log("case 2: batch auto-completed after image deletion. OK");

console.log("Stuck batch fixes verified.");
