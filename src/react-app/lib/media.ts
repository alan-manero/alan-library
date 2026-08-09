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
// ---------------------------------------------------------------------------

export interface ProcessedVideo {
  duration: number;
  width: number;
  height: number;
  thumbnail: Blob | null;
}

export function processVideo(file: File): Promise<ProcessedVideo> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;

    const fallback: ProcessedVideo = {
      duration: 0,
      width: 0,
      height: 0,
      thumbnail: null,
    };
    let settled = false;
    const finish = (result: ProcessedVideo) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(result);
    };
    // If anything goes wrong, upload proceeds without thumbnail/metadata.
    const timer = setTimeout(() => finish(fallback), 10000);

    video.onloadedmetadata = () => {
      // Seek slightly into the video for a more representative frame.
      video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
    };
    video.onseeked = () => {
      try {
        const scale = Math.min(
          1,
          500 / Math.max(video.videoWidth || 1, video.videoHeight || 1)
        );
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("no context");
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) =>
            finish({
              duration: video.duration || 0,
              width: video.videoWidth,
              height: video.videoHeight,
              thumbnail: blob,
            }),
          "image/webp",
          0.8
        );
      } catch {
        finish({
          duration: video.duration || 0,
          width: video.videoWidth,
          height: video.videoHeight,
          thumbnail: null,
        });
      }
    };
    video.onerror = () => finish(fallback);
    video.src = url;
  });
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
