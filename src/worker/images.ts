import { Hono } from "hono";
import type { Env } from "./index";

// Only these image types are accepted (spec section 7.2).
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const MAX_IMAGE_BYTES = 30 * 1024 * 1024; // 30 MB per image

export const imagesApp = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Duplicate check: the browser sends the file's SHA-256 hash before uploading
// ---------------------------------------------------------------------------

imagesApp.post("/images/check-hash", async (c) => {
  const body = await c.req.json<{ hash?: string }>().catch(() => null);
  const hash = body?.hash;
  if (!hash) return c.json({ duplicate: false });

  const existing = await c.env.DB.prepare(
    "SELECT id, original_filename FROM images WHERE file_hash = ?1 AND archived = 0 LIMIT 1"
  )
    .bind(hash)
    .first<{ id: string; original_filename: string }>();

  return c.json(
    existing ? { duplicate: true, image: existing } : { duplicate: false }
  );
});

// ---------------------------------------------------------------------------
// Upload one image (original file + browser-generated WebP thumbnail)
// ---------------------------------------------------------------------------

imagesApp.post("/images", async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Invalid upload request." }, 400);

  const file = form.get("file");
  const thumbnail = form.get("thumbnail");
  const hash = String(form.get("hash") ?? "");
  const width = Number(form.get("width")) || null;
  const height = Number(form.get("height")) || null;
  const batchItemId = String(form.get("batch_item_id") ?? "");

  if (!(file instanceof File)) {
    return c.json({ error: "No image file received." }, 400);
  }

  const extension = ALLOWED_IMAGE_TYPES[file.type];
  if (!extension) {
    return c.json(
      { error: `Unsupported image type "${file.type}". Use JPG, PNG or WEBP.` },
      400
    );
  }

  if (file.size > MAX_IMAGE_BYTES) {
    return c.json({ error: "Image is larger than the 30 MB limit." }, 400);
  }

  const id = crypto.randomUUID();
  const storageKey = `images/originals/${id}.${extension}`;
  const thumbnailKey =
    thumbnail instanceof File ? `images/thumbnails/${id}.webp` : null;

  // Store files in R2 first; only create the database record if storage worked.
  await c.env.MEDIA.put(storageKey, file.stream(), {
    httpMetadata: { contentType: file.type },
  });
  if (thumbnail instanceof File && thumbnailKey) {
    await c.env.MEDIA.put(thumbnailKey, thumbnail.stream(), {
      httpMetadata: { contentType: "image/webp" },
    });
  }

  await c.env.DB.prepare(
    `INSERT INTO images
       (id, original_filename, storage_key, thumbnail_key, mime_type,
        file_size, width, height, file_hash, analysis_status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'UPLOADED')`
  )
    .bind(
      id,
      file.name,
      storageKey,
      thumbnailKey,
      file.type,
      file.size,
      width,
      height,
      hash || null
    )
    .run();

  if (batchItemId) {
    await c.env.DB.prepare(
      `UPDATE import_items SET upload_status = 'DONE', image_id = ?2, error = NULL
        WHERE id = ?1`
    )
      .bind(batchItemId, id)
      .run();
  }

  const image = await c.env.DB.prepare(
    "SELECT *, 0 AS video_count FROM images WHERE id = ?1"
  )
    .bind(id)
    .first();

  return c.json({ image }, 201);
});

// ---------------------------------------------------------------------------
// List images for the library grid, with search and filters (spec 15, 16).
//   ?q=computer night     free text — every word must match somewhere
//   ?tags=3,17            tag ids — image must have ALL of them
//   ?has_videos=1|0
//   ?limit / ?offset      pagination
// ---------------------------------------------------------------------------

imagesApp.get("/images", async (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 60, 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const q = (c.req.query("q") ?? "").trim();
  const tagIds = (c.req.query("tags") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 12);
  const hasVideos = c.req.query("has_videos");

  const where: string[] = ["i.archived = 0"];
  const binds: unknown[] = [];

  // Text search: each word must appear in at least one searchable place.
  for (const word of q.split(/\s+/).filter(Boolean).slice(0, 8)) {
    const like = `%${word}%`;
    where.push(
      `(i.description LIKE ? OR i.original_filename LIKE ? OR i.character LIKE ?
        OR i.location LIKE ? OR i.mood LIKE ? OR i.time_of_day LIKE ?
        OR i.shot_type LIKE ? OR i.pose LIKE ?
        OR EXISTS (SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id
                    WHERE it.image_id = i.id AND t.canonical_name LIKE ?))`
    );
    binds.push(like, like, like, like, like, like, like, like, like);
  }

  for (const tagId of tagIds) {
    where.push(
      "EXISTS (SELECT 1 FROM image_tags it WHERE it.image_id = i.id AND it.tag_id = ?)"
    );
    binds.push(tagId);
  }

  const videosExists =
    "EXISTS (SELECT 1 FROM videos v WHERE v.parent_image_id = i.id AND v.archived = 0)";
  if (hasVideos === "1") where.push(videosExists);
  if (hasVideos === "0") where.push(`NOT ${videosExists}`);

  const whereSql = where.join(" AND ");

  const [rows, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT i.*,
              (SELECT COUNT(*) FROM videos v
                WHERE v.parent_image_id = i.id AND v.archived = 0) AS video_count
         FROM images i
        WHERE ${whereSql}
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ? OFFSET ?`
    )
      .bind(...binds, limit, offset)
      .all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM images i WHERE ${whereSql}`)
      .bind(...binds)
      .first<{ total: number }>(),
  ]);

  return c.json({ images: rows.results, total: count?.total ?? 0 });
});

// ---------------------------------------------------------------------------
// Image detail: the full record plus all of its tags
// ---------------------------------------------------------------------------

imagesApp.get("/images/:id", async (c) => {
  const id = c.req.param("id");
  const image = await c.env.DB.prepare(
    `SELECT i.*,
            (SELECT COUNT(*) FROM videos v
              WHERE v.parent_image_id = i.id AND v.archived = 0) AS video_count
       FROM images i WHERE i.id = ?1`
  )
    .bind(id)
    .first();
  if (!image) return c.json({ error: "Image not found." }, 404);

  const [{ results: tags }, { results: videos }] = await Promise.all([
    c.env.DB.prepare(
      `SELECT t.id, t.canonical_name, t.category, it.source
         FROM image_tags it JOIN tags t ON t.id = it.tag_id
        WHERE it.image_id = ?1
        ORDER BY t.category, t.canonical_name`
    )
      .bind(id)
      .all(),
    c.env.DB.prepare(
      `SELECT * FROM videos WHERE parent_image_id = ?1 AND archived = 0
        ORDER BY created_at DESC`
    )
      .bind(id)
      .all(),
  ]);

  return c.json({ image, tags, videos });
});

// ---------------------------------------------------------------------------
// Edit the description. Marks it as manually edited so AI reprocessing
// never overwrites your correction (spec 14).
// ---------------------------------------------------------------------------

imagesApp.patch("/images/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ description?: string }>().catch(() => null);
  if (!body || typeof body.description !== "string") {
    return c.json({ error: "Nothing to update." }, 400);
  }

  const result = await c.env.DB.prepare(
    `UPDATE images SET description = ?2, description_edited = 1,
            updated_at = datetime('now')
      WHERE id = ?1`
  )
    .bind(id, body.description.trim().slice(0, 1000))
    .run();
  if (result.meta.changes === 0) return c.json({ error: "Image not found." }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Add a tag to an image (project tags and manual corrections).
// Reuses an existing tag when the name already exists in that category,
// so tags stay shared across images (spec 48/49).
// ---------------------------------------------------------------------------

const TAG_CATEGORIES = [
  "PROJECT",
  "CHARACTER",
  "ACTIVITY",
  "LOCATION",
  "MOOD",
  "TIME",
  "SHOT_TYPE",
  "CAMERA_ANGLE",
  "POSE",
  "OBJECT",
  "VISUAL",
];

imagesApp.post("/images/:id/tags", async (c) => {
  const id = c.req.param("id");
  const body = await c.req
    .json<{ name?: string; category?: string }>()
    .catch(() => null);
  const name = (body?.name ?? "").trim().slice(0, 60);
  const category = TAG_CATEGORIES.includes(body?.category ?? "")
    ? body!.category!
    : "PROJECT";
  if (!name) return c.json({ error: "Tag name is empty." }, 400);

  let tag = await c.env.DB.prepare(
    "SELECT id FROM tags WHERE lower(canonical_name) = lower(?1) AND category = ?2"
  )
    .bind(name, category)
    .first<{ id: number }>();

  if (!tag) {
    const inserted = await c.env.DB.prepare(
      "INSERT INTO tags (canonical_name, category) VALUES (?1, ?2)"
    )
      .bind(name, category)
      .run();
    tag = { id: Number(inserted.meta.last_row_id) };
  }

  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO image_tags (image_id, tag_id, source) VALUES (?1, ?2, 'USER')"
  )
    .bind(id, tag.id)
    .run();

  const { results: tags } = await c.env.DB.prepare(
    `SELECT t.id, t.canonical_name, t.category, it.source
       FROM image_tags it JOIN tags t ON t.id = it.tag_id
      WHERE it.image_id = ?1
      ORDER BY t.category, t.canonical_name`
  )
    .bind(id)
    .all();
  return c.json({ tags });
});

imagesApp.delete("/images/:id/tags/:tagId", async (c) => {
  await c.env.DB.prepare(
    "DELETE FROM image_tags WHERE image_id = ?1 AND tag_id = ?2"
  )
    .bind(c.req.param("id"), Number(c.req.param("tagId")))
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// All tags with usage counts (feeds the filter dropdowns)
// ---------------------------------------------------------------------------

imagesApp.get("/tags", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.canonical_name, t.category, COUNT(it.image_id) AS usage_count
       FROM tags t
       LEFT JOIN image_tags it ON it.tag_id = t.id
      GROUP BY t.id
      ORDER BY t.category, t.canonical_name`
  ).all();
  return c.json({ tags: results });
});

// ---------------------------------------------------------------------------
// Permanent deletion (spec 23 + owner's rule):
// - image without videos: deletes after one confirmation (client side)
// - image with videos: server answers 409 so the client can explicitly ask
//   whether the videos should be deleted too; retry with ?with_videos=1
// - R2 files are deleted BEFORE database records, so a half-failed delete
//   never leaves records pointing at existing files you can't see.
// ---------------------------------------------------------------------------

imagesApp.delete("/images/:id", async (c) => {
  const id = c.req.param("id");
  const withVideos = c.req.query("with_videos") === "1";

  const image = await c.env.DB.prepare("SELECT * FROM images WHERE id = ?1")
    .bind(id)
    .first<{ storage_key: string; thumbnail_key: string | null }>();
  if (!image) return c.json({ error: "Image not found." }, 404);

  const { results: videos } = await c.env.DB.prepare(
    "SELECT id, storage_key, thumbnail_key FROM videos WHERE parent_image_id = ?1"
  )
    .bind(id)
    .all<{ id: string; storage_key: string; thumbnail_key: string | null }>();

  if (videos.length > 0 && !withVideos) {
    return c.json(
      {
        error: "This image has linked videos.",
        videoCount: videos.length,
        requiresVideoConfirmation: true,
      },
      409
    );
  }

  const keys = [
    image.storage_key,
    image.thumbnail_key,
    ...videos.flatMap((v) => [v.storage_key, v.thumbnail_key]),
  ].filter((k): k is string => Boolean(k));
  await c.env.MEDIA.delete(keys);

  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE import_items SET image_id = NULL WHERE image_id = ?1"
    ).bind(id),
    c.env.DB.prepare("DELETE FROM videos WHERE parent_image_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM image_tags WHERE image_id = ?1").bind(id),
    c.env.DB.prepare("DELETE FROM images WHERE id = ?1").bind(id),
  ]);

  return c.json({ ok: true, deletedVideos: videos.length });
});

// ---------------------------------------------------------------------------
// Serve stored files (thumbnails, originals) from R2 — login required,
// because this route sits behind the same /api session check.
// ---------------------------------------------------------------------------

imagesApp.get("/media/*", async (c) => {
  const key = decodeURIComponent(
    c.req.path.replace(/^\/api\/media\//, "")
  );
  if (!key.startsWith("images/") && !key.startsWith("videos/")) {
    return c.json({ error: "Invalid media path." }, 400);
  }

  // Range requests let the browser stream/scrub videos without downloading
  // the entire file first (spec 21). R2 parses the Range header for us.
  const rangeHeader = c.req.raw.headers.get("range");
  const object = await c.env.MEDIA.get(
    key,
    rangeHeader ? { range: c.req.raw.headers } : undefined
  );
  if (!object) return c.json({ error: "File not found." }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  // Keys are unique per file, so browsers can cache aggressively.
  headers.set("cache-control", "private, max-age=31536000, immutable");

  // ?download=1&name=... turns the response into a file download with a
  // human-friendly filename instead of displaying it in the browser tab.
  if (c.req.query("download") === "1") {
    const rawName = c.req.query("name") || key.split("/").pop() || "file";
    const safeName = rawName.replace(/[\r\n"\\]/g, "_").slice(0, 150);
    headers.set(
      "content-disposition",
      `attachment; filename="${safeName}"`
    );
    headers.set("cache-control", "private, no-store");
  }

  if (rangeHeader && object.range && "offset" in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set(
      "content-range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`
    );
    headers.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
});
