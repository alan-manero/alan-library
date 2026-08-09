// Browser-side file processing, done before upload:
// - SHA-256 hash (for duplicate detection)
// - WebP thumbnail (max 500px), so the library grid loads fast
//   and the server never has to resize anything.

export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

const THUMBNAIL_MAX_PX = 500;

export async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface ProcessedImage {
  width: number;
  height: number;
  thumbnail: Blob;
}

export async function processImage(file: File): Promise<ProcessedImage> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;

  const scale = Math.min(1, THUMBNAIL_MAX_PX / Math.max(width, height));
  const thumbWidth = Math.max(1, Math.round(width * scale));
  const thumbHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = thumbWidth;
  canvas.height = thumbHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a drawing context.");
  context.drawImage(bitmap, 0, 0, thumbWidth, thumbHeight);
  bitmap.close();

  const thumbnail = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Thumbnail creation failed.")),
      "image/webp",
      0.85
    )
  );

  return { width, height, thumbnail };
}

// ---------------------------------------------------------------------------
// Video processing: read duration/resolution and capture a frame as thumbnail.
// All in the browser — the server never needs video processing libraries.
// Many videos start with a black fade-in, so a single frame at t=0.5s often
// comes out black: we try several timestamps and keep the first bright one.
// ---------------------------------------------------------------------------

export interface ProcessedVideo {
  duration: number;
  width: number;
  height: number;
  thumbnail: Blob | null;
}

export interface VideoPoster {
  blob: Blob;
  duration: number;
  width: number;
  height: number;
}

// Average pixel luminance (0-255) below which a frame counts as "black".
const FRAME_BRIGHTNESS_OK = 18;

function waitFor(
  target: HTMLMediaElement,
  event: string,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onEvent = () => {
      cleanup();
      resolve(true);
    };
    const onError = () => {
      cleanup();
      resolve(false);
    };
    function cleanup() {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener("error", onError);
    }
    target.addEventListener(event, onEvent);
    target.addEventListener("error", onError);
  });
}

function sourceBrightness(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number
): number {
  const sample = document.createElement("canvas");
  sample.width = 32;
  sample.height = 18;
  const context = sample.getContext("2d");
  if (!context) return 255;
  context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, 32, 18);
  const { data } = context.getImageData(0, 0, 32, 18);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  return sum / (data.length / 4);
}

/** Average luminance (0-255) of an encoded image, e.g. a stored thumbnail. */
export async function imageBrightness(blob: Blob): Promise<number> {
  const bitmap = await createImageBitmap(blob);
  try {
    return sourceBrightness(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function grabFrame(
  video: HTMLVideoElement
): Promise<{ blob: Blob; brightness: number } | null> {
  try {
    const scale = Math.min(
      1,
      500 / Math.max(video.videoWidth || 1, video.videoHeight || 1)
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const brightness = sourceBrightness(canvas, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.8)
    );
    return blob ? { blob, brightness } : null;
  } catch {
    return null;
  }
}

/**
 * Load a video (local object URL or same-origin media URL) and capture a
 * representative poster frame, skipping black fade-ins where possible.
 */
export async function captureVideoPoster(
  src: string
): Promise<VideoPoster | null> {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = src;

  const loaded = await waitFor(video, "loadedmetadata", 10000);
  if (!loaded || !video.videoWidth) return null;

  const rawDuration = video.duration;
  const duration =
    Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const d = duration || 1;
  const candidates = [d * 0.2, d * 0.45, d * 0.7].map((t) =>
    Math.min(Math.max(t, 0.1), Math.max(d - 0.05, 0.1))
  );

  const width = video.videoWidth;
  const height = video.videoHeight;

  let best: { blob: Blob; brightness: number } | null = null;
  for (const time of candidates) {
    video.currentTime = time;
    const seeked = await waitFor(video, "seeked", 5000);
    if (!seeked) continue;
    const shot = await grabFrame(video);
    if (!shot) continue;
    if (!best || shot.brightness > best.brightness) best = shot;
    if (shot.brightness >= FRAME_BRIGHTNESS_OK) break;
  }
  video.removeAttribute("src");
  video.load();

  if (!best) return null;
  return { blob: best.blob, duration, width, height };
}

export async function processVideo(file: File): Promise<ProcessedVideo> {
  const url = URL.createObjectURL(file);
  try {
    const poster = await captureVideoPoster(url);
    return {
      duration: poster?.duration ?? 0,
      width: poster?.width ?? 0,
      height: poster?.height ?? 0,
      thumbnail: poster?.blob ?? null,
    };
  } catch {
    // If anything goes wrong, upload proceeds without thumbnail/metadata.
    return { duration: 0, width: 0, height: 0, thumbnail: null };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Upload with progress percentage (fetch cannot report upload progress).
// ---------------------------------------------------------------------------

export function uploadWithProgress(
  url: string,
  form: FormData,
  onProgress: (percent: number) => void
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // non-JSON response body
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.send(form);
  });
}
