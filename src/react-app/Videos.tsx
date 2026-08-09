import { useCallback, useEffect, useState } from "react";
import type { VideoRecord } from "./ImageDetail";

interface LibraryVideo extends VideoRecord {
  parent_image_id: string;
  image_filename: string;
  image_thumbnail_key: string | null;
}

const PAGE_SIZE = 48;

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "";
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return minutes > 0 ? `${minutes}:${String(secs).padStart(2, "0")}` : `${secs}s`;
}

export function Videos({
  onOpenImage,
}: {
  onOpenImage: (imageId: string) => void;
}) {
  const [videos, setVideos] = useState<LibraryVideo[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<LibraryVideo | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const load = useCallback(
    async (offset: number) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (query.trim()) params.set("q", query.trim());
      const res = await fetch(`/api/videos?${params}`);
      if (!res.ok) return;
      const data = await res.json<{ videos: LibraryVideo[]; total: number }>();
      setTotal(data.total);
      setVideos((prev) =>
        offset === 0 ? data.videos : [...prev, ...data.videos]
      );
      setLoading(false);
    },
    [query]
  );

  useEffect(() => {
    const timer = setTimeout(() => load(0), 300);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPlaying(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="library">
      <div className="library-toolbar">
        <h1 className="library-title">
          Videos{" "}
          <span className="muted count">
            {total} video{total === 1 ? "" : "s"}
          </span>
        </h1>
        <input
          className="search-input"
          type="text"
          placeholder="Search videos — title, prompt, model, source image…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="centered-block muted">Loading videos…</div>
      ) : videos.length === 0 ? (
        <div className="centered-block">
          <div className="empty-card">
            <div className="empty-icon">🎬</div>
            <h2>{query.trim() ? "No videos match" : "No videos yet"}</h2>
            <p className="muted">
              {query.trim()
                ? "Try fewer words."
                : "Open an image in the Library and add videos to it — they all show up here."}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="videos-grid">
            {videos.map((video) => (
              <div key={video.id} className="video-card">
                <button
                  className="video-thumb"
                  title="Open in full view"
                  onMouseEnter={() => setPreviewId(video.id)}
                  onMouseLeave={() => setPreviewId(null)}
                  onClick={() => setPlaying(video)}
                >
                  {previewId === video.id ? (
                    <video
                      src={`/api/media/${video.storage_key}`}
                      muted
                      loop
                      autoPlay
                      playsInline
                    />
                  ) : video.thumbnail_key ? (
                    <img
                      src={`/api/media/${video.thumbnail_key}`}
                      alt={video.title ?? video.original_filename}
                    />
                  ) : (
                    <span className="video-thumb-placeholder">🎬</span>
                  )}
                  {previewId === video.id ? (
                    <span className="video-expand-hint">⛶ Full view</span>
                  ) : (
                    <span className="video-play">▶</span>
                  )}
                  {video.duration_seconds ? (
                    <span className="video-duration">
                      {formatDuration(video.duration_seconds)}
                    </span>
                  ) : null}
                </button>
                <div className="video-info">
                  <span className="video-title" title={video.original_filename}>
                    {video.title ?? video.original_filename}
                  </span>
                  <span className="muted video-meta">
                    {[
                      video.created_at
                        ? new Date(
                            video.created_at.replace(" ", "T") + "Z"
                          ).toLocaleDateString()
                        : null,
                      video.model,
                      `${(video.file_size / (1024 * 1024)).toFixed(1)} MB`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {video.prompt && (
                    <p className="muted video-prompt" title={video.prompt}>
                      {video.prompt}
                    </p>
                  )}
                  <div className="video-actions">
                    <a
                      className="ghost-button small video-download"
                      href={`/api/media/${video.storage_key}?download=1&name=${encodeURIComponent(video.original_filename)}`}
                    >
                      Download
                    </a>
                    <button
                      className="ghost-button small"
                      title={`Open source image: ${video.image_filename}`}
                      onClick={() => onOpenImage(video.parent_image_id)}
                    >
                      Source image
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {videos.length < total && (
            <div className="load-more">
              <button
                className="ghost-button"
                onClick={() => load(videos.length)}
              >
                Load more ({total - videos.length} remaining)
              </button>
            </div>
          )}
        </>
      )}

      {playing && (
        <div className="video-lightbox" onClick={() => setPlaying(null)}>
          <div
            className="video-lightbox-inner"
            onClick={(e) => e.stopPropagation()}
          >
            <video
              key={playing.id}
              src={`/api/media/${playing.storage_key}`}
              controls
              autoPlay
            />
            <div className="video-lightbox-caption">
              <span>{playing.title ?? playing.original_filename}</span>
              <button
                className="ghost-button small"
                onClick={() => setPlaying(null)}
              >
                ✕ Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
