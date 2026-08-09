import { Hono } from "hono";
import type { Env } from "./index";

// Derived videos (spec sections 18-22): each video belongs to one parent image.

const ALLOWED_VIDEO_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

// The Workers free plan caps request bodies at 100 MB; stay safely under it.
const MAX_VIDEO_BYTES = 95 * 1024 * 1024;

export const videosApp = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// All videos in the library (for the Videos page), newest first.
//   ?q=...            free text across title/filename/model/prompt/notes
//                     and the parent image's filename/description
//   ?limit / ?offset  pagination
// ---------------------------------------------------------------------------

videosApp.get("/videos", async (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 48, 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const q = (c.req.query("q") ?? "").trim();

  const where: string[] = ["v.archived = 0"];
  const binds: unknown[] = [];
  for (const word of q.split(/\s+/).filter(Boolean).slice(0, 8)) {
    const like = `%${word}%`;
    where.push(
      `(v.title LIKE ? OR v.original_filename LIKE ? OR v.model LIKE ?
        OR v.prompt LIKE ? OR v.notes LIKE ?
        OR i.original_filename LIKE ? OR i.description LIKE ?)`
    );
    binds.push(like, like, like, like, like, like, like);
  }
  const whereSql = where.join(" AND ");

  const [rows, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT v.*, i.original_filename AS image_filename,
              i.thumbnail_key AS image_thumbnail_key
         FROM videos v JOIN images i ON i.id = v.parent_image_id
        WHERE ${whereSql}
        ORDER BY v.created_at DESC, v.id DESC
        LIMIT ? OFFSET ?`
    )
      .bind(...binds, limit, offset)
      .all(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total
         FROM videos v JOIN images i ON i.id = v.parent_image_id
        WHERE ${whereSql}`
    )
      .bind(...binds)
      .first<{ total: number }>(),
  ]);

  return c.json({ videos: rows.results, total: count?.total ?? 0 });
});

videosApp.post("/videos", async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Invalid upload request." }, 400);

  const file = form.get("file");
  const thumbnail = form.get("thumbnail");
  const parentImageId = String(form.get("parent_image_id") ?? "");
  const duration = Number(form.get("duration")) || null;
  const width = Number(form.get("width")) || null;
  const height = Number(form.get("height")) || null;

  if (!(file instanceof File)) {
    return c.json({ error: "No video file received." }, 400);
  }
  const extension = ALLOWED_VIDEO_TYPES[file.type];
  if (!extension) {
    return c.json(
      { error: `Unsupported video type "${file.type}". Use MP4, WEBM or MOV.` },
      400
    );
  }
  if (file.size > MAX_VIDEO_BYTES) {
    return c.json(
      { error: "Video is larger than the 95 MB upload limit." },
      400
    );
  }

  const parent = await c.env.DB.prepare(
    "SELECT id FROM images WHERE id = ?1 AND archived = 0"
  )
    .bind(parentImageId)
    .first();
  if (!parent) return c.json({ error: "Parent image not found." }, 404);

  const id = crypto.randomUUID();
  const storageKey = `videos/originals/${id}.${extension}`;
  const thumbnailKey =
    thumbnail instanceof File ? `videos/thumbnails/${id}.webp` : null;

  await c.env.MEDIA.put(storageKey, file.stream(), {
    httpMetadata: { contentType: file.type },
  });
  if (thumbnail instanceof File && thumbnailKey) {
    await c.env.MEDIA.put(thumbnailKey, thumbnail.stream(), {
      httpMetadata: { contentType: "image/webp" },
    });
  }

  await c.env.DB.prepare(
    `INSERT INTO videos
       (id, parent_image_id, original_filename, storage_key, thumbnail_key,
        mime_type, file_size, duration_seconds, width, height)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
  )
    .bind(
      id,
      parentImageId,
      file.name,
      storageKey,
      thumbnailKey,
      file.type,
      file.size,
      duration,
      width,
      height
    )
    .run();

  const video = await c.env.DB.prepare("SELECT * FROM videos WHERE id = ?1")
    .bind(id)
    .first();
  return c.json({ video }, 201);
});

// Replace a video's thumbnail (used to repair black poster frames captured
// from fade-in videos). The key is versioned because media responses are
// cached as immutable in the browser.
videosApp.put("/videos/:id/thumbnail", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.formData().catch(() => null);
  const thumbnail = form?.get("thumbnail");
  if (!(thumbnail instanceof File) || thumbnail.size === 0) {
    return c.json({ error: "No thumbnail received." }, 400);
  }
  if (thumbnail.size > 2 * 1024 * 1024) {
    return c.json({ error: "Thumbnail is too large." }, 400);
  }

  const video = await c.env.DB.prepare(
    "SELECT thumbnail_key FROM videos WHERE id = ?1"
  )
    .bind(id)
    .first<{ thumbnail_key: string | null }>();
  if (!video) return c.json({ error: "Video not found." }, 404);

  const newKey = `videos/thumbnails/${id}-${Date.now()}.webp`;
  await c.env.MEDIA.put(newKey, thumbnail.stream(), {
    httpMetadata: { contentType: "image/webp" },
  });
  await c.env.DB.prepare(
    "UPDATE videos SET thumbnail_key = ?2 WHERE id = ?1"
  )
    .bind(id, newKey)
    .run();
  if (video.thumbnail_key && video.thumbnail_key !== newKey) {
    await c.env.MEDIA.delete(video.thumbnail_key);
  }

  const updated = await c.env.DB.prepare("SELECT * FROM videos WHERE id = ?1")
    .bind(id)
    .first();
  return c.json({ video: updated });
});

// Edit video metadata (title, generation model, prompt, notes).
videosApp.patch("/videos/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req
    .json<{
      title?: string | null;
      model?: string | null;
      prompt?: string | null;
      notes?: string | null;
    }>()
    .catch(() => null);
  if (!body) return c.json({ error: "Nothing to update." }, 400);

  const clean = (v: string | null | undefined, max: number) =>
    typeof v === "string" ? v.trim().slice(0, max) || null : null;

  const result = await c.env.DB.prepare(
    "UPDATE videos SET title = ?2, model = ?3, prompt = ?4, notes = ?5 WHERE id = ?1"
  )
    .bind(
      id,
      clean(body.title, 150),
      clean(body.model, 60),
      clean(body.prompt, 2000),
      clean(body.notes, 2000)
    )
    .run();
  if (result.meta.changes === 0) return c.json({ error: "Video not found." }, 404);

  const video = await c.env.DB.prepare("SELECT * FROM videos WHERE id = ?1")
    .bind(id)
    .first();
  return c.json({ video });
});

// Delete one video (R2 files first, then the record).
videosApp.delete("/videos/:id", async (c) => {
  const id = c.req.param("id");
  const video = await c.env.DB.prepare(
    "SELECT storage_key, thumbnail_key FROM videos WHERE id = ?1"
  )
    .bind(id)
    .first<{ storage_key: string; thumbnail_key: string | null }>();
  if (!video) return c.json({ error: "Video not found." }, 404);

  const keys = [video.storage_key, video.thumbnail_key].filter(
    (k): k is string => Boolean(k)
  );
  await c.env.MEDIA.delete(keys);
  await c.env.DB.prepare("DELETE FROM videos WHERE id = ?1").bind(id).run();
  return c.json({ ok: true });
});
