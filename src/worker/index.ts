import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  createSessionToken,
  isValidSessionToken,
  safeEqual,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "./auth";
import { imagesApp } from "./images";
import { analysisApp } from "./analysis";
import { batchesApp } from "./batches";
import { videosApp } from "./videos";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  /** The login password. Secret — set via .dev.vars locally, wrangler secret in production. */
  APP_PASSWORD: string;
  /** Random string used to sign session cookies. Secret. */
  APP_AUTH_SECRET: string;
  /** Anthropic API key used for image analysis. Secret. */
  ANTHROPIC_API_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Auth routes (these are the only API routes reachable without a session)
// ---------------------------------------------------------------------------

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ password?: string }>().catch(() => null);
  const password = body?.password ?? "";

  if (!c.env.APP_PASSWORD || !c.env.APP_AUTH_SECRET) {
    return c.json(
      { error: "Server is missing APP_PASSWORD / APP_AUTH_SECRET secrets." },
      500
    );
  }

  if (!safeEqual(password, c.env.APP_PASSWORD)) {
    return c.json({ error: "Wrong password." }, 401);
  }

  const token = await createSessionToken(c.env.APP_AUTH_SECRET);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // HTTPS-only in production; plain HTTP is only used on localhost during development.
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return c.json({ ok: true });
});

app.post("/api/auth/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/auth/me", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const valid = await isValidSessionToken(token, c.env.APP_AUTH_SECRET ?? "");
  return valid ? c.json({ ok: true }) : c.json({ error: "Not logged in." }, 401);
});

// ---------------------------------------------------------------------------
// Session check for every other /api route
// ---------------------------------------------------------------------------

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/")) return next();
  const token = getCookie(c, SESSION_COOKIE);
  const valid = await isValidSessionToken(token, c.env.APP_AUTH_SECRET ?? "");
  if (!valid) return c.json({ error: "Not logged in." }, 401);
  return next();
});

// ---------------------------------------------------------------------------
// Health check: proves the Worker runs and the D1 database is reachable
// ---------------------------------------------------------------------------

app.get("/api/health", async (c) => {
  let database = "not connected";
  try {
    const row = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM images"
    ).first<{ n: number }>();
    database = `connected (${row?.n ?? 0} images)`;
  } catch (err) {
    database = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  return c.json({ app: "alan-library", status: "ok", database });
});

app.route("/api", imagesApp);
app.route("/api", analysisApp);
app.route("/api", batchesApp);
app.route("/api", videosApp);

app.all("/api/*", (c) => c.json({ error: "Unknown API route." }, 404));

export default app;
