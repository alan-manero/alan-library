// Tests video endpoints + range streaming against the LOCAL dev server.
// Usage:  node scripts/video-test.mjs

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

// Parent image
const png = Buffer.concat([
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  ),
  randomBytes(8),
]);
const imgForm = new FormData();
imgForm.append("file", new Blob([png], { type: "image/png" }), "parent.png");
imgForm.append("hash", createHash("sha256").update(png).digest("hex"));
const up = await fetch(`${BASE}/api/images`, {
  method: "POST",
  headers: { cookie },
  body: imgForm,
});
const { image } = await up.json();
console.log("parent image:", image.id);

// 1. Upload a "video" (recognizable bytes so range slicing is verifiable)
const videoBytes = Buffer.from(
  Array.from({ length: 100 }, (_, i) => i % 256)
);
const vidForm = new FormData();
vidForm.append("file", new Blob([videoBytes], { type: "video/mp4" }), "clip.mp4");
vidForm.append("thumbnail", new Blob([png], { type: "image/webp" }), "t.webp");
vidForm.append("parent_image_id", image.id);
vidForm.append("duration", "5.2");
vidForm.append("width", "1280");
vidForm.append("height", "720");
let res = await fetch(`${BASE}/api/videos`, {
  method: "POST",
  headers: { cookie },
  body: vidForm,
});
if (res.status !== 201) fail("video upload", await res.text());
const { video } = await res.json();
console.log("1. video upload: OK →", video.id);
if (video.duration_seconds !== 5.2 || video.width !== 1280)
  fail("video metadata", JSON.stringify(video));

// 2. Wrong type rejected
const badForm = new FormData();
badForm.append("file", new Blob([videoBytes], { type: "text/plain" }), "x.txt");
badForm.append("parent_image_id", image.id);
res = await fetch(`${BASE}/api/videos`, { method: "POST", headers: { cookie }, body: badForm });
if (res.status !== 400) fail("bad type", `${res.status}`);
console.log("2. wrong file type rejected: OK");

// 3. Detail includes the video + video_count
res = await fetch(`${BASE}/api/images/${image.id}`, { headers: { cookie } });
let detail = await res.json();
if (detail.videos.length !== 1 || detail.image.video_count !== 1)
  fail("detail videos", JSON.stringify({ n: detail.videos.length, c: detail.image.video_count }));
console.log("3. detail includes video + count: OK");

// 4. Range request → 206 with the exact requested bytes
res = await fetch(`${BASE}/api/media/${video.storage_key}`, {
  headers: { cookie, range: "bytes=10-19" },
});
const slice = Buffer.from(await res.arrayBuffer());
if (res.status !== 206) fail("range status", res.status);
if (res.headers.get("content-range") !== "bytes 10-19/100")
  fail("content-range", res.headers.get("content-range"));
if (!slice.equals(videoBytes.subarray(10, 20))) fail("range bytes", slice);
console.log("4. range streaming (206 + correct slice): OK");

// 5. Full fetch still works
res = await fetch(`${BASE}/api/media/${video.storage_key}`, { headers: { cookie } });
if (res.status !== 200 || Number(res.headers.get("content-length")) !== 100)
  fail("full fetch", `${res.status} ${res.headers.get("content-length")}`);
console.log("5. full fetch with content-length: OK");

// 6. Edit metadata
res = await fetch(`${BASE}/api/videos/${video.id}`, {
  method: "PATCH",
  headers: jsonHeaders,
  body: JSON.stringify({
    title: "Alan falls asleep",
    model: "Kling",
    prompt: "Alan slowly falls asleep at his desk",
    notes: "",
  }),
});
const patched = await res.json();
if (patched.video.title !== "Alan falls asleep" || patched.video.model !== "Kling")
  fail("patch video", JSON.stringify(patched));
console.log("6. video metadata edit: OK");

// 7. Deleting parent image asks first (409), then works with with_videos=1
res = await fetch(`${BASE}/api/images/${image.id}`, { method: "DELETE", headers: { cookie } });
if (res.status !== 409) fail("parent delete should 409", res.status);
res = await fetch(`${BASE}/api/images/${image.id}?with_videos=1`, {
  method: "DELETE",
  headers: { cookie },
});
if (!res.ok) fail("parent delete with videos", await res.text());
res = await fetch(`${BASE}/api/media/${video.storage_key}`, { headers: { cookie } });
if (res.status !== 404) fail("video file should be gone from R2", res.status);
console.log("7. parent delete flow removes video files too: OK");

console.log("\nAll video tests passed.");
