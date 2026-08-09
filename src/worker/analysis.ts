import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";

// ---------------------------------------------------------------------------
// What Claude must return, validated strictly (spec section 40).
// ---------------------------------------------------------------------------

const analysisSchema = z.object({
  description: z.string().min(1),
  characters: z.array(z.string()).max(4).default([]),
  activities: z.array(z.string()).max(6).default([]),
  location: z.string().nullable().default(null),
  mood: z.array(z.string()).max(4).default([]),
  time_of_day: z.string().nullable().default(null),
  shot_type: z.string().nullable().default(null),
  camera_angle: z.string().nullable().default(null),
  pose: z.array(z.string()).max(4).default([]),
  objects: z.array(z.string()).max(12).default([]),
  visual_tags: z.array(z.string()).max(10).default([]),
});

type Analysis = z.infer<typeof analysisSchema>;

// Cheapest Claude model with vision — analysis costs well under 1 cent per image.
const CLAUDE_MODEL = "claude-haiku-4-5";

interface Tag {
  id: number;
  canonical_name: string;
  category: string;
}

type Taxonomy = Map<string, Tag>; // key: "CATEGORY:lowercase name"

const taxonomyKey = (category: string, name: string) =>
  `${category}:${name.trim().toLowerCase()}`;

async function loadTaxonomy(env: Env): Promise<Taxonomy> {
  const { results } = await env.DB.prepare(
    "SELECT id, canonical_name, category FROM tags"
  ).all<Tag>();
  const map: Taxonomy = new Map();
  for (const tag of results) {
    map.set(taxonomyKey(tag.category, tag.canonical_name), tag);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Prompt construction — includes the controlled vocabulary so Claude prefers
// known tag values instead of inventing synonyms (spec section 12).
// ---------------------------------------------------------------------------

function buildPrompt(taxonomy: Taxonomy): string {
  const byCategory: Record<string, string[]> = {};
  for (const tag of taxonomy.values()) {
    (byCategory[tag.category] ??= []).push(tag.canonical_name);
  }
  const list = (category: string) =>
    (byCategory[category] ?? []).join(", ") || "(none yet)";

  return `You are analyzing an image for "Alan Library", the private media library of a creative AI-generated video project.

Project context — the two recurring characters have consistent visual signatures:
- ALAN (main character): an adult man with BLACK hair, almost always wearing BLACK sunglasses/shades, typically dressed in a red and blue hoodie or jacket (sometimes with white lettering/numbers). A musician/streamer type.
- MIA: an adult woman with BLOND hair, typically wearing dark sunglasses.

Character rules (follow strictly):
1. FIRST check whether a person is actually visible: a face, a body, or a clearly human figure. Extreme close-ups of objects, vehicles, rooms, landscapes, or shots showing no human figure have NO characters — "characters" MUST be [] and no character name may appear anywhere in the output, including visual_tags. Never assume an off-screen or implied character.
2. If a person IS visible: a man matching Alan's signature is "Alan"; a woman matching Mia's signature is "Mia". A man appearing alone is almost certainly Alan even if the outfit differs.
3. Use "Unknown character" only when a visible person clearly matches neither signature.

Describe ONLY what is visually present. If something is uncertain, use null or an empty list. Never invent story context.

Return ONLY a JSON object — no markdown fences, no commentary — with exactly these fields:
{
  "description": one or two concise sentences describing the scene,
  "characters": array of names ("Alan", "Mia", "Unknown character"), empty if no person is visible,
  "activities": array of activities,
  "location": single location string or null,
  "mood": array describing the visually apparent emotional state of the character(s),
  "time_of_day": string or null,
  "shot_type": string or null,
  "camera_angle": string or null,
  "pose": array,
  "objects": array of notable visible objects,
  "visual_tags": 3 to 8 additional searchable keywords (may repeat key concepts above)
}

Strongly prefer these known values when they fit; introduce a new simple term only when nothing in the list matches:
- activities: ${list("ACTIVITY")}
- location: ${list("LOCATION")}
- mood: ${list("MOOD")}
- time_of_day: ${list("TIME")}
- shot_type: ${list("SHOT_TYPE")}
- camera_angle: ${list("CAMERA_ANGLE")}
- pose: ${list("POSE")}
- objects: ${list("OBJECT")}`;
}

// ---------------------------------------------------------------------------
// Claude API call
// ---------------------------------------------------------------------------

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function callClaude(
  env: Env,
  imageBase64: string,
  mediaType: string,
  taxonomy: Taxonomy
): Promise<Analysis> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 900,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: imageBase64,
              },
            },
            { type: "text", text: buildPrompt(taxonomy) },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`Claude API error (${response.status}): ${body}`);
  }

  const payload = await response.json<{
    content?: Array<{ type: string; text?: string }>;
  }>();
  const text = payload.content?.find((c) => c.type === "text")?.text ?? "";

  // Be tolerant of accidental markdown fences around the JSON.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Claude did not return valid JSON.");
  }

  const validated = analysisSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error("Claude returned JSON in an unexpected format.");
  }
  return validated.data;
}

// ---------------------------------------------------------------------------
// Saving results: normalize values against the taxonomy, write tags + fields
// ---------------------------------------------------------------------------

const ARRAY_FIELD_CATEGORIES: Array<[keyof Analysis, string]> = [
  ["characters", "CHARACTER"],
  ["activities", "ACTIVITY"],
  ["mood", "MOOD"],
  ["pose", "POSE"],
  ["objects", "OBJECT"],
  ["visual_tags", "VISUAL"],
];

const SINGLE_FIELD_CATEGORIES: Array<[keyof Analysis, string]> = [
  ["location", "LOCATION"],
  ["time_of_day", "TIME"],
  ["shot_type", "SHOT_TYPE"],
  ["camera_angle", "CAMERA_ANGLE"],
];

function cleanValue(raw: string): string | null {
  const value = raw.trim().slice(0, 60);
  return value.length > 0 ? value : null;
}

async function saveAnalysis(
  env: Env,
  image: { id: string; description_edited: number },
  data: Analysis,
  taxonomy: Taxonomy
): Promise<void> {
  // Collect every (category, value) pair the AI produced, normalized to the
  // canonical spelling when the taxonomy already knows the term.
  const pairs = new Map<string, { category: string; name: string }>();
  const normalized: Record<string, string | null> = {};

  const normalize = (category: string, raw: string): string | null => {
    const value = cleanValue(raw);
    if (!value) return null;
    const known = taxonomy.get(taxonomyKey(category, value));
    const name = known ? known.canonical_name : value;
    pairs.set(taxonomyKey(category, name), { category, name });
    return name;
  };

  for (const [field, category] of ARRAY_FIELD_CATEGORIES) {
    const values = (data[field] as string[]) ?? [];
    const names = values
      .map((v) => normalize(category, v))
      .filter((v): v is string => v !== null);
    normalized[field] = names.join(field === "characters" ? " + " : ", ") || null;
  }
  for (const [field, category] of SINGLE_FIELD_CATEGORIES) {
    const raw = data[field] as string | null;
    normalized[field] = raw ? normalize(category, raw) : null;
  }

  // 1. Create any genuinely new tags.
  const newPairs = [...pairs.values()].filter(
    (p) => !taxonomy.has(taxonomyKey(p.category, p.name))
  );
  if (newPairs.length > 0) {
    await env.DB.batch(
      newPairs.map((p) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO tags (canonical_name, category) VALUES (?1, ?2)"
        ).bind(p.name, p.category)
      )
    );
  }

  // 2. Re-read the taxonomy so we have ids for everything.
  const fresh = await loadTaxonomy(env);
  const tagIds = [...pairs.values()]
    .map((p) => fresh.get(taxonomyKey(p.category, p.name))?.id)
    .filter((id): id is number => id !== undefined);

  // 3. Replace AI tags (never touching tags you added yourself) and update
  //    the image record. Your manually edited description is preserved.
  const statements = [
    env.DB.prepare(
      "DELETE FROM image_tags WHERE image_id = ?1 AND source = 'AI'"
    ).bind(image.id),
    ...tagIds.map((tagId) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO image_tags (image_id, tag_id, source) VALUES (?1, ?2, 'AI')"
      ).bind(image.id, tagId)
    ),
    env.DB.prepare(
      `UPDATE images SET
         description = CASE WHEN description_edited = 1 THEN description ELSE ?2 END,
         character = ?3, location = ?4, mood = ?5, time_of_day = ?6,
         shot_type = ?7, camera_angle = ?8, pose = ?9,
         analysis_status = 'READY', analysis_error = NULL,
         updated_at = datetime('now')
       WHERE id = ?1`
    ).bind(
      image.id,
      data.description.trim().slice(0, 500),
      normalized.characters,
      normalized.location,
      normalized.mood,
      normalized.time_of_day,
      normalized.shot_type,
      normalized.camera_angle,
      normalized.pose
    ),
  ];
  await env.DB.batch(statements);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

async function getFullImage(env: Env, id: string) {
  return env.DB.prepare(
    `SELECT i.*,
            (SELECT COUNT(*) FROM videos v
              WHERE v.parent_image_id = i.id AND v.archived = 0) AS video_count
       FROM images i WHERE i.id = ?1`
  )
    .bind(id)
    .first();
}

export const analysisApp = new Hono<{ Bindings: Env }>();

analysisApp.post("/images/:id/analyze", async (c) => {
  const id = c.req.param("id");
  const force = c.req.query("force") === "1";

  const image = await c.env.DB.prepare("SELECT * FROM images WHERE id = ?1")
    .bind(id)
    .first<{
      id: string;
      storage_key: string;
      thumbnail_key: string | null;
      mime_type: string;
      analysis_status: string;
      description_edited: number;
    }>();

  if (!image) return c.json({ error: "Image not found." }, 404);

  // Cost guard (spec 42): never silently reanalyze an image that is done.
  if (image.analysis_status === "READY" && !force) {
    return c.json({ image: await getFullImage(c.env, id) });
  }

  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json(
      { error: "ANTHROPIC_API_KEY is not configured on the server." },
      500
    );
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE images SET analysis_status = 'ANALYZING', analysis_error = NULL WHERE id = ?1"
    ).bind(id),
    c.env.DB.prepare(
      "UPDATE import_items SET analysis_status = 'ANALYZING' WHERE image_id = ?1"
    ).bind(id),
  ]);

  try {
    // Analyze the small thumbnail, not the original: faster, cheaper, and
    // safely under Claude's 5 MB image limit.
    const key = image.thumbnail_key ?? image.storage_key;
    const object = await c.env.MEDIA.get(key);
    if (!object) throw new Error("Stored file is missing from R2.");

    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength > 5 * 1024 * 1024) {
      throw new Error("Image is too large for AI analysis (over 5 MB).");
    }
    const mediaType = object.httpMetadata?.contentType ?? image.mime_type;

    const taxonomy = await loadTaxonomy(c.env);
    const result = await callClaude(
      c.env,
      base64Encode(bytes),
      mediaType,
      taxonomy
    );
    await saveAnalysis(c.env, image, result, taxonomy);
    await c.env.DB.prepare(
      "UPDATE import_items SET analysis_status = 'DONE', error = NULL WHERE image_id = ?1"
    )
      .bind(id)
      .run();

    return c.json({ image: await getFullImage(c.env, id) });
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(
      0,
      500
    );
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE images SET analysis_status = 'ERROR', analysis_error = ?2 WHERE id = ?1"
      ).bind(id, message),
      c.env.DB.prepare(
        "UPDATE import_items SET analysis_status = 'ERROR', error = ?2 WHERE image_id = ?1"
      ).bind(id, message),
    ]);
    return c.json({ error: message, image: await getFullImage(c.env, id) }, 502);
  }
});
