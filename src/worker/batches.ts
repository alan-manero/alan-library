import { Hono } from "hono";
import type { Env } from "./index";

// Import batches make bulk uploads refresh-proof (spec sections 8, 9, 28, 29):
// every dropped file gets a row in import_items, so progress is computed from
// the database — not from browser memory.

export const batchesApp = new Hono<{ Bindings: Env }>();

interface ItemRow {
  id: string;
  upload_status: string;
  analysis_status: string;
  image_id: string | null;
  original_filename: string;
  error: string | null;
}

const ANALYSIS_TERMINAL = ["DONE", "ERROR", "SKIPPED"];

async function batchWithProgress(env: Env, id: string) {
  const batch = await env.DB.prepare(
    "SELECT id, total_items, status, created_at FROM import_batches WHERE id = ?1"
  )
    .bind(id)
    .first<{ id: string; total_items: number; status: string; created_at: string }>();
  if (!batch) return null;

  const { results: items } = await env.DB.prepare(
    `SELECT id, upload_status, analysis_status, image_id, original_filename, error
       FROM import_items WHERE batch_id = ?1`
  )
    .bind(id)
    .all<ItemRow>();

  const progress = {
    total: items.length,
    uploaded: items.filter((i) => i.upload_status === "DONE").length,
    uploadFailed: items.filter((i) => i.upload_status === "ERROR").length,
    skipped: items.filter((i) => i.upload_status === "SKIPPED").length,
    pendingUpload: items.filter(
      (i) => i.upload_status === "PENDING" || i.upload_status === "UPLOADING"
    ).length,
    analyzed: items.filter((i) => i.analysis_status === "DONE").length,
    analysisFailed: items.filter((i) => i.analysis_status === "ERROR").length,
  };

  // The batch is finished when nothing is still uploading and every uploaded
  // item has reached a final analysis state.
  const complete =
    progress.pendingUpload === 0 &&
    items.every(
      (i) =>
        i.upload_status !== "DONE" ||
        ANALYSIS_TERMINAL.includes(i.analysis_status)
    );

  if (complete && batch.status === "ACTIVE") {
    await env.DB.prepare(
      "UPDATE import_batches SET status = 'DONE' WHERE id = ?1"
    )
      .bind(id)
      .run();
    batch.status = "DONE";
  }

  const failedAnalysisImageIds = items
    .filter((i) => i.analysis_status === "ERROR" && i.image_id)
    .map((i) => i.image_id);

  return { batch, progress, failedAnalysisImageIds };
}

// Create a batch (called when files are dropped, before uploading starts).
batchesApp.post("/batches", async (c) => {
  const body = await c.req
    .json<{ filenames?: string[] }>()
    .catch(() => null);
  const filenames = (body?.filenames ?? []).slice(0, 500);
  if (filenames.length === 0) {
    return c.json({ error: "No files in batch." }, 400);
  }

  const batchId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO import_batches (id, total_items, status) VALUES (?1, ?2, 'ACTIVE')"
  )
    .bind(batchId, filenames.length)
    .run();

  const items = filenames.map((filename) => ({
    id: crypto.randomUUID(),
    filename,
  }));
  await c.env.DB.batch(
    items.map((item) =>
      c.env.DB.prepare(
        `INSERT INTO import_items (id, batch_id, original_filename, upload_status, analysis_status)
         VALUES (?1, ?2, ?3, 'PENDING', 'PENDING')`
      ).bind(item.id, batchId, item.filename)
    )
  );

  return c.json({ batchId, items }, 201);
});

// The most recent unfinished batch, if any (used to resume after a refresh).
batchesApp.get("/batches/active", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id FROM import_batches WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1"
  ).first<{ id: string }>();
  if (!row) return c.json({ batch: null });
  const data = await batchWithProgress(c.env, row.id);
  return c.json(data ?? { batch: null });
});

batchesApp.get("/batches/:id", async (c) => {
  const data = await batchWithProgress(c.env, c.req.param("id"));
  if (!data) return c.json({ error: "Batch not found." }, 404);
  return c.json(data);
});

// Give up on files that never finished uploading (e.g. page closed mid-import).
batchesApp.post("/batches/:id/dismiss", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE import_items SET upload_status = 'ERROR', error = 'Upload interrupted'
        WHERE batch_id = ?1 AND upload_status IN ('PENDING', 'UPLOADING')`
    ).bind(id),
    c.env.DB.prepare(
      "UPDATE import_batches SET status = 'DONE' WHERE id = ?1"
    ).bind(id),
  ]);
  return c.json({ ok: true });
});

// Called by the browser when a file was skipped as a duplicate.
batchesApp.post("/batches/items/:itemId/skip", async (c) => {
  await c.env.DB.prepare(
    `UPDATE import_items SET upload_status = 'SKIPPED', analysis_status = 'SKIPPED'
      WHERE id = ?1`
  )
    .bind(c.req.param("itemId"))
    .run();
  return c.json({ ok: true });
});

// Called by the browser when a file failed to upload.
batchesApp.post("/batches/items/:itemId/fail", async (c) => {
  const body = await c.req.json<{ error?: string }>().catch(() => null);
  await c.env.DB.prepare(
    `UPDATE import_items SET upload_status = 'ERROR', error = ?2 WHERE id = ?1`
  )
    .bind(c.req.param("itemId"), (body?.error ?? "Upload failed").slice(0, 300))
    .run();
  return c.json({ ok: true });
});
