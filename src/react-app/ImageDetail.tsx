import { useCallback, useEffect, useRef, useState } from "react";
import type { ImageRecord, TagRecord } from "./Library";
import {
  ACCEPTED_VIDEO_TYPES,
  processVideo,
  uploadWithProgress,
} from "./lib/media";

interface ImageTag {
  id: number;
  canonical_name: string;
  category: string;
  source: "AI" | "USER";
}

export interface VideoRecord {
  id: string;
  original_filename: string;
  storage_key: string;
  thumbnail_key: string | null;
  mime_type: string;
  file_size: number;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  title: string | null;
  model: string | null;
  prompt: string | null;
  notes: string | null;
  created_at: string;
}

interface DetailData {
  image: ImageRecord & {
    file_size: number;
    width: number | null;
    height: number | null;
    character: string | null;
    location: string | null;
    mood: string | null;
    time_of_day: string | null;
    shot_type: string | null;
    camera_angle: string | null;
    pose: string | null;
    analysis_error: string | null;
    mime_type: string;
  };
  tags: ImageTag[];
  videos: VideoRecord[];
}

const ADDABLE_CATEGORIES: Array<{ value: string; label: string }> = [
  { value: "PROJECT", label: "Project tag" },
  { value: "CHARACTER", label: "Character" },
  { value: "ACTIVITY", label: "Activity" },
  { value: "LOCATION", label: "Location" },
  { value: "MOOD", label: "Mood" },
  { value: "OBJECT", label: "Object" },
  { value: "VISUAL", label: "Visual keyword" },
];

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "";
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return minutes > 0 ? `${minutes}:${String(secs).padStart(2, "0")}` : `${secs}s`;
}

export function ImageDetail({
  imageId,
  allTags,
  onClose,
  onChanged,
  onDelete,
  onPrev,
  onNext,
}: {
  imageId: string;
  allTags: TagRecord[];
  onClose: () => void;
  onChanged: (image: ImageRecord) => void;
  onDelete: () => Promise<boolean>;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const [data, setData] = useState<DetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [newTagName, setNewTagName] = useState("");
  const [newTagCategory, setNewTagCategory] = useState("PROJECT");
  const [busy, setBusy] = useState(false);
  const [playingVideo, setPlayingVideo] = useState<VideoRecord | null>(null);
  const [previewVideoId, setPreviewVideoId] = useState<string | null>(null);
  const [videoDragActive, setVideoDragActive] = useState(false);
  const videoDragDepth = useRef(0);
  const [videoUpload, setVideoUpload] = useState<{
    name: string;
    percent: number;
    status: "processing" | "uploading" | "error";
    message?: string;
  } | null>(null);
  const [editingVideoId, setEditingVideoId] = useState<string | null>(null);
  const [videoDraft, setVideoDraft] = useState({
    title: "",
    model: "",
    prompt: "",
    notes: "",
  });
  const videoInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/images/${imageId}`);
    if (!res.ok) {
      setError("Could not load this image.");
      return;
    }
    const detail = await res.json<DetailData>();
    setData(detail);
    setDescriptionDraft(detail.image.description ?? "");
  }, [imageId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT");
      if (e.key === "Escape") {
        if (playingVideo) {
          setPlayingVideo(null);
        } else {
          onClose();
        }
        return;
      }
      if (typing || playingVideo) return;
      if (e.key === "ArrowLeft" && onPrev) onPrev();
      if (e.key === "ArrowRight" && onNext) onNext();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext, playingVideo]);

  if (error) {
    return (
      <div className="detail-overlay" onClick={onClose}>
        <div className="detail-panel centered-block muted">{error}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="detail-overlay">
        <div className="detail-panel centered-block muted">Loading…</div>
      </div>
    );
  }

  const { image, tags } = data;
  const aiTags = tags.filter((t) => t.category !== "PROJECT");
  const projectTags = tags.filter((t) => t.category === "PROJECT");
  const date = image.created_at
    ? new Date(image.created_at.replace(" ", "T") + "Z").toLocaleString()
    : "";
  const sizeMb = image.file_size
    ? `${(image.file_size / (1024 * 1024)).toFixed(2)} MB`
    : "";

  const metadataCells: Array<[string, string | null]> = [
    ["Character", image.character],
    ["Location", image.location],
    ["Mood", image.mood],
    ["Time of day", image.time_of_day],
    ["Shot type", image.shot_type],
    ["Camera angle", image.camera_angle],
    ["Pose", image.pose],
    [
      "Resolution",
      image.width && image.height ? `${image.width} × ${image.height}` : null,
    ],
  ];

  async function refreshAndNotify() {
    const res = await fetch(`/api/images/${imageId}`);
    if (!res.ok) return;
    const detail = await res.json<DetailData>();
    setData(detail);
    setDescriptionDraft(detail.image.description ?? "");
    onChanged(detail.image);
  }

  async function saveDescription() {
    setBusy(true);
    await fetch(`/api/images/${imageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: descriptionDraft }),
    });
    setEditingDescription(false);
    await refreshAndNotify();
    setBusy(false);
  }

  async function addTag() {
    const name = newTagName.trim();
    if (!name) return;
    setBusy(true);
    const res = await fetch(`/api/images/${imageId}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, category: newTagCategory }),
    });
    if (res.ok) {
      const { tags: updated } = await res.json<{ tags: ImageTag[] }>();
      setData((prev) => (prev ? { ...prev, tags: updated } : prev));
      setNewTagName("");
    }
    setBusy(false);
  }

  async function removeTag(tagId: number) {
    await fetch(`/api/images/${imageId}/tags/${tagId}`, { method: "DELETE" });
    setData((prev) =>
      prev ? { ...prev, tags: prev.tags.filter((t) => t.id !== tagId) } : prev
    );
  }

  async function reanalyze() {
    const confirmed = window.confirm(
      "Re-run AI analysis on this image?\n\nThis makes a new (very small) API call and replaces AI tags. Tags you added yourself and an edited description are kept."
    );
    if (!confirmed) return;
    setBusy(true);
    await fetch(`/api/images/${imageId}/analyze?force=1`, { method: "POST" });
    await refreshAndNotify();
    setBusy(false);
  }

  async function handleDelete() {
    const deleted = await onDelete();
    if (deleted) onClose();
  }

  // ---- Videos ----

  async function uploadVideo(file: File) {
    if (!ACCEPTED_VIDEO_TYPES.includes(file.type)) {
      alert(`"${file.name}" is not a supported video (use MP4, WEBM or MOV).`);
      return;
    }
    if (file.size > 95 * 1024 * 1024) {
      alert(
        `"${file.name}" is ${(file.size / (1024 * 1024)).toFixed(0)} MB — the current upload limit is 95 MB per video.`
      );
      return;
    }

    setVideoUpload({ name: file.name, percent: 0, status: "processing" });
    try {
      const { duration, width, height, thumbnail } = await processVideo(file);

      const form = new FormData();
      form.append("file", file);
      if (thumbnail) form.append("thumbnail", thumbnail, "thumbnail.webp");
      form.append("parent_image_id", imageId);
      form.append("duration", String(duration));
      form.append("width", String(width));
      form.append("height", String(height));

      setVideoUpload({ name: file.name, percent: 0, status: "uploading" });
      const result = await uploadWithProgress("/api/videos", form, (percent) =>
        setVideoUpload((prev) => (prev ? { ...prev, percent } : prev))
      );
      if (result.status !== 201) {
        const message =
          (result.body as { error?: string } | null)?.error ??
          `Upload failed (${result.status}).`;
        throw new Error(message);
      }
      setVideoUpload(null);
      await refreshAndNotify();
    } catch (err) {
      setVideoUpload({
        name: file.name,
        percent: 0,
        status: "error",
        message: err instanceof Error ? err.message : "Upload failed.",
      });
    }
  }

  async function handleVideoFiles(files: FileList | File[]) {
    for (const file of [...files]) {
      await uploadVideo(file);
    }
  }

  async function deleteVideo(video: VideoRecord) {
    const confirmed = window.confirm(
      `Delete video "${video.title ?? video.original_filename}"?\n\nThe file will be PERMANENTLY removed from cloud storage.`
    );
    if (!confirmed) return;
    const res = await fetch(`/api/videos/${video.id}`, { method: "DELETE" });
    if (res.ok) {
      if (playingVideo?.id === video.id) setPlayingVideo(null);
      await refreshAndNotify();
    } else {
      alert("Could not delete the video. Please try again.");
    }
  }

  function startEditVideo(video: VideoRecord) {
    setEditingVideoId(video.id);
    setVideoDraft({
      title: video.title ?? "",
      model: video.model ?? "",
      prompt: video.prompt ?? "",
      notes: video.notes ?? "",
    });
  }

  async function saveVideoMeta(videoId: string) {
    setBusy(true);
    await fetch(`/api/videos/${videoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(videoDraft),
    });
    setEditingVideoId(null);
    await refreshAndNotify();
    setBusy(false);
  }

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div
        className="detail-panel"
        onClick={(e) => e.stopPropagation()}
        onDragEnter={(e) => {
          if (!e.dataTransfer?.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          videoDragDepth.current++;
          setVideoDragActive(true);
        }}
        onDragLeave={(e) => {
          e.stopPropagation();
          videoDragDepth.current = Math.max(0, videoDragDepth.current - 1);
          if (videoDragDepth.current === 0) setVideoDragActive(false);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          videoDragDepth.current = 0;
          setVideoDragActive(false);
          if (e.dataTransfer?.files?.length) {
            handleVideoFiles(e.dataTransfer.files);
          }
        }}
      >
        <header className="detail-header">
          <div className="detail-header-info">
            <h2 className="detail-filename" title={image.original_filename}>
              {image.original_filename}
            </h2>
            <p className="detail-fileinfo muted">
              {date}
              {sizeMb ? ` · ${sizeMb}` : ""}
              {data.videos.length > 0
                ? ` · ${data.videos.length} video${data.videos.length === 1 ? "" : "s"}`
                : ""}
            </p>
          </div>
          <div className="detail-header-actions">
            <a
              className="button-link"
              href={`/api/media/${image.storage_key}?download=1&name=${encodeURIComponent(image.original_filename)}`}
            >
              Download original
            </a>
            <button className="ghost-button" disabled={busy} onClick={reanalyze}>
              Re-run AI
            </button>
            <button className="ghost-button danger" onClick={handleDelete}>
              Delete
            </button>
            <button className="ghost-button detail-close" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        <div className="detail-media">
          <img
            src={`/api/media/${image.storage_key}`}
            alt={image.original_filename}
          />
          {onPrev && (
            <button
              className="nav-arrow nav-arrow-left"
              title="Previous image (←)"
              onClick={onPrev}
            >
              ‹
            </button>
          )}
          {onNext && (
            <button
              className="nav-arrow nav-arrow-right"
              title="Next image (→)"
              onClick={onNext}
            >
              ›
            </button>
          )}
        </div>

        <div className="detail-body">
          <section className="detail-description-block">
            {editingDescription ? (
              <>
                <textarea
                  value={descriptionDraft}
                  rows={3}
                  autoFocus
                  onChange={(e) => setDescriptionDraft(e.target.value)}
                />
                <div className="button-row">
                  <button disabled={busy} onClick={saveDescription}>
                    Save
                  </button>
                  <button
                    className="ghost-button"
                    onClick={() => {
                      setEditingDescription(false);
                      setDescriptionDraft(image.description ?? "");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <p className="detail-description">
                {image.description ?? (
                  <span className="muted">No description yet.</span>
                )}{" "}
                <button
                  className="inline-edit"
                  onClick={() => setEditingDescription(true)}
                >
                  Edit
                </button>
              </p>
            )}
          </section>

          <section>
            <h3 className="section-title">Tags</h3>
            <div className="pill-row">
              {aiTags.length === 0 && (
                <span className="muted small-note">No AI tags yet.</span>
              )}
              {aiTags.map((t) => (
                <span key={t.id} className={`pill cat-${t.category}`}>
                  {t.canonical_name}
                  <button
                    className="pill-remove"
                    title="Remove tag"
                    onClick={() => removeTag(t.id)}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </section>

          <section>
            <h3 className="section-title">Details</h3>
            <div className="meta-grid">
              {metadataCells.map(([label, value]) => (
                <div key={label} className="meta-cell">
                  <span className="meta-label">{label}</span>
                  <span className="meta-value">{value ?? "—"}</span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3 className="section-title">Project tags</h3>
            <div className="pill-row">
              {projectTags.length === 0 && (
                <span className="muted small-note">
                  Your own labels — e.g. "Streamer Alan", "Negative moments".
                </span>
              )}
              {projectTags.map((t) => (
                <span key={t.id} className="pill pill-project">
                  {t.canonical_name}
                  <button
                    className="pill-remove"
                    title="Remove tag"
                    onClick={() => removeTag(t.id)}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <div className="add-tag-row">
              <select
                value={newTagCategory}
                onChange={(e) => setNewTagCategory(e.target.value)}
              >
                {ADDABLE_CATEGORIES.map((cat) => (
                  <option key={cat.value} value={cat.value}>
                    {cat.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Add tag and press Enter"
                value={newTagName}
                list="tag-suggestions"
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addTag();
                }}
              />
              <datalist id="tag-suggestions">
                {allTags
                  .filter((t) => t.category === newTagCategory)
                  .map((t) => (
                    <option key={t.id} value={t.canonical_name} />
                  ))}
              </datalist>
            </div>
          </section>

          <section>
            <div className="section-header">
              <h3 className="section-title">
                Videos generated from this image
              </h3>
              <button
                className="ghost-button small"
                onClick={() => videoInputRef.current?.click()}
              >
                + Add video
              </button>
            </div>
            <input
              ref={videoInputRef}
              type="file"
              accept={ACCEPTED_VIDEO_TYPES.join(",")}
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) handleVideoFiles(e.target.files);
                e.target.value = "";
              }}
            />

            {videoUpload && (
              <div
                className={`video-upload-status ${videoUpload.status === "error" ? "error" : ""}`}
              >
                {videoUpload.status === "processing" &&
                  `Preparing "${videoUpload.name}"…`}
                {videoUpload.status === "uploading" && (
                  <>
                    Uploading "{videoUpload.name}" — {videoUpload.percent}%
                    <div className="progress-track">
                      <div
                        className="progress-fill"
                        style={{ width: `${videoUpload.percent}%` }}
                      />
                    </div>
                  </>
                )}
                {videoUpload.status === "error" && (
                  <>
                    {videoUpload.message}{" "}
                    <button
                      className="ghost-button small"
                      onClick={() => setVideoUpload(null)}
                    >
                      Dismiss
                    </button>
                  </>
                )}
              </div>
            )}

            {data.videos.length === 0 && !videoUpload && (
              <p className="muted small-note">
                None yet. Click "+ Add video" or drop one or more video files
                anywhere on this panel.
              </p>
            )}

            <div className="videos-grid">
              {data.videos.map((video) => (
                <div key={video.id} className="video-card">
                  <button
                    className="video-thumb"
                    title="Open in full view"
                    onMouseEnter={() => setPreviewVideoId(video.id)}
                    onMouseLeave={() => setPreviewVideoId(null)}
                    onClick={() => setPlayingVideo(video)}
                  >
                    {previewVideoId === video.id ? (
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
                    {previewVideoId === video.id ? (
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
                    <span
                      className="video-title"
                      title={video.original_filename}
                    >
                      {video.title ?? video.original_filename}
                    </span>
                    <span className="muted video-meta">
                      {[
                        video.model,
                        `${(video.file_size / (1024 * 1024)).toFixed(1)} MB`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {video.prompt && editingVideoId !== video.id && (
                      <p className="muted video-prompt" title={video.prompt}>
                        {video.prompt}
                      </p>
                    )}
                    <div className="video-actions">
                      <button
                        className="ghost-button small"
                        onClick={() => startEditVideo(video)}
                      >
                        Edit
                      </button>
                      <a
                        className="ghost-button small video-download"
                        href={`/api/media/${video.storage_key}?download=1&name=${encodeURIComponent(video.original_filename)}`}
                      >
                        Download
                      </a>
                      <button
                        className="ghost-button small danger"
                        onClick={() => deleteVideo(video)}
                      >
                        Delete
                      </button>
                    </div>
                    {editingVideoId === video.id && (
                      <div className="video-edit-form">
                        <input
                          type="text"
                          placeholder="Title (e.g. Alan falls asleep)"
                          value={videoDraft.title}
                          onChange={(e) =>
                            setVideoDraft((d) => ({
                              ...d,
                              title: e.target.value,
                            }))
                          }
                        />
                        <input
                          type="text"
                          placeholder="Generation model (e.g. Kling)"
                          value={videoDraft.model}
                          onChange={(e) =>
                            setVideoDraft((d) => ({
                              ...d,
                              model: e.target.value,
                            }))
                          }
                        />
                        <textarea
                          rows={2}
                          placeholder="Generation prompt"
                          value={videoDraft.prompt}
                          onChange={(e) =>
                            setVideoDraft((d) => ({
                              ...d,
                              prompt: e.target.value,
                            }))
                          }
                        />
                        <textarea
                          rows={2}
                          placeholder="Notes"
                          value={videoDraft.notes}
                          onChange={(e) =>
                            setVideoDraft((d) => ({
                              ...d,
                              notes: e.target.value,
                            }))
                          }
                        />
                        <div className="button-row">
                          <button
                            disabled={busy}
                            onClick={() => saveVideoMeta(video.id)}
                          >
                            Save
                          </button>
                          <button
                            className="ghost-button"
                            onClick={() => setEditingVideoId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {image.analysis_status === "ERROR" && image.analysis_error && (
            <p className="panel-note error">
              AI analysis failed: {image.analysis_error}
            </p>
          )}
        </div>
      </div>

      {videoDragActive && (
        <div className="video-drop-overlay">
          <div className="drop-overlay-inner">
            Drop videos to add them to this image
          </div>
        </div>
      )}

      {playingVideo && (
        <div
          className="video-lightbox"
          onClick={(e) => {
            e.stopPropagation();
            setPlayingVideo(null);
          }}
        >
          <div
            className="video-lightbox-inner"
            onClick={(e) => e.stopPropagation()}
          >
            <video
              key={playingVideo.id}
              src={`/api/media/${playingVideo.storage_key}`}
              controls
              autoPlay
            />
            <div className="video-lightbox-caption">
              <span>{playingVideo.title ?? playingVideo.original_filename}</span>
              <button
                className="ghost-button small"
                onClick={() => setPlayingVideo(null)}
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
