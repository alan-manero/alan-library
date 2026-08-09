// Checks the GET /api/videos listing endpoint (Videos page).
// Usage: node scripts/videos-list-test.mjs [baseUrl]
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

for (const qs of ["", "?q=zzz-no-match-zzz", "?limit=2"]) {
  const res = await fetch(`${BASE}/api/videos${qs}`, { headers: { cookie } });
  const data = await res.json();
  console.log(
    `GET /api/videos${qs} -> status=${res.status} total=${data.total} returned=${data.videos?.length}`
  );
  if (res.status !== 200) throw new Error("Unexpected status");
}
console.log("Videos list endpoint OK.");
