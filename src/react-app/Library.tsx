import { useCallback, useEffect, useRef, useState } from "react";
import { ACCEPTED_IMAGE_TYPES, processImage, sha256Hex } from "./lib/media";
import { ImageDetail } from "./ImageDetail";

export interface ImageRecord {
  id: string;
  original_filename: string;
  storage_key: string;
  thumbnail_key: string | null;
  description: string | null;
  analysis_status: string;
  video_count: number;
  created_at: string;
}

type UploadStatus = "preparing" | "uploading" | "done" | "skipped" | "error";

interface UploadEntry {
  key: number;
  filename: string;
  status: UploadStatus;
  message?: string;
}

interface BatchProgress {
  total: number;
  uploaded: number;
  uploadFailed: number;
  skipped: number;
  pendingUpload: number;
  analyzed: number;
  analysisFailed: number;
}

interface BatchState {
  id: string;
  status: string;
  progress: BatchProgress;
}

export interface TagRecord {
  id: number;
  canonical_name: string;
  category: string;
  usage_count: number;
}

const FILTER_CATEGORIES: Array<{ category: string; label: string }> = [
  { category: "CHARACTER", label: "Character" },
  { category: "ACTIVITY", label: "Activity" },
  { category: "LOCATION", label: "Location" },
  { category: "MOOD", label: "Mood" },
  { category: "TIME", label: "Time" },
  { category: "SHOT_TYPE", label: "Shot type" },
  { category: "OBJECT", label: "Object" },
  { category: "PROJECT", label: "My tags" },
];

const PAGE_SIZE = 60;
const UPLOAD_CONCURRENCY = 3;
const ANALYSIS_CONCURRENCY = 2;

let uploadKeyCounter = 0;

export function Library({
  hidden = false,
  openImageId = null,
  onOpenImageHandled,
}: {
  hidden?: boolean;
  openImageId?: string | null;
  onOpenImageHandled?: () => void;
}) {
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [query, setQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [tagFilters, setTagFilters] = useState<Record<string, string>>({});
  const [hasVideosFilter, setHasVideosFilter] = useState("");
  const [allTags, setAllTags] = useState<TagRecord[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // While the detail panel is open, dropped files belong to it (videos),
  // not to the library-wide image import.
  const detailOpenRef = useRef(false);
  useEffect(() => {
    detailOpenRef.current = selectedImageId !== null;
  }, [selectedImageId]);

  // While another page (Videos) is shown, ignore window-level image drops.
  const hiddenRef = useRef(hidden);
  useEffect(() => {
    hiddenRef.current = hidden;
  }, [hidden]);

  // "Source image" on the Videos page jumps here with an image to open.
  useEffect(() => {
    if (openImageId) {
      setSelectedImageId(openImageId);
      onOpenImageHandled?.();
    }
  }, [openImageId, onOpenImageHandled]);

  // Warm the browser cache for the neighbours of the open image, so
  // prev/next navigation in the detail view feels instant.
  useEffect(() => {
    if (!selectedImageId) return;
    const index = images.findIndex((i) => i.id === selectedImageId);
    for (const neighbour of [images[index - 1], images[index + 1]]) {
      if (neighbour) {
        const img = new Image();
        img.src = `/api/media/${neighbour.storage_key}`;
      }
    }
  }, [selectedImageId, images]);

  const filtersActive =
    query.trim() !== "" ||
    hasVideosFilter !== "" ||
    Object.values(tagFilters).some((v) => v !== "");

  // ---- AI analysis queue: a couple of images at a time, in the background ----
  const analysisQueue = useRef<string[]>([]);
  const analysisActive = useRef(0);
  const analysisSeen = useRef(new Set<string>());

  const replaceImage = useCallback((updated: ImageRecord) => {
    setImages((prev) =>
      prev.map((img) => (img.id === updated.id ? updated : img))
    );
  }, []);

  const pumpAnalysis = useCallback(() => {
    while (
      analysisActive.current < ANALYSIS_CONCURRENCY &&
      analysisQueue.current.length > 0
    ) {
      const id = analysisQueue.current.shift()!;
      analysisActive.current++;
      setImages((prev) =>
        prev.map((img) =>
          img.id === id ? { ...img, analysis_status: "ANALYZING" } : img
        )
      );
      fetch(`/api/images/${id}/analyze`, { method: "POST" })
        .then(async (res) => {
          const data = await res
            .json<{ image?: ImageRecord }>()
            .catch(() => ({ image: undefined }));
          if (data.image) replaceImage(data.image);
        })
        .catch(() => {
          setImages((prev) =>
            prev.map((img) =>
              img.id === id ? { ...img, analysis_status: "ERROR" } : img
            )
          );
        })
        .finally(() => {
          analysisActive.current--;
          pumpAnalysis();
        });
    }
  }, [replaceImage]);

  const enqueueAnalysis = useCallback(
    (id: string) => {
      if (analysisSeen.current.has(id)) return;
      analysisSeen.current.add(id);
      analysisQueue.current.push(id);
      pumpAnalysis();
    },
    [pumpAnalysis]
  );

  const retryAnalysis = useCallback(
    (id: string) => {
      analysisSeen.current.delete(id);
      enqueueAnalysis(id);
    },
    [enqueueAnalysis]
  );

  const loadImages = useCallback(
    async (offset: number) => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (query.trim()) params.set("q", query.trim());
      const tagIds = Object.values(tagFilters).filter((v) => v !== "");
      if (tagIds.length > 0) params.set("tags", tagIds.join(","));
      if (hasVideosFilter !== "") params.set("has_videos", hasVideosFilter);

      const res = await fetch(`/api/images?${params}`);
      if (!res.ok) return;
      const data = await res.json<{ images: ImageRecord[]; total: number }>();
      setTotal(data.total);
      setImages((prev) =>
        offset === 0 ? data.images : [...prev, ...data.images]
      );
      setLoading(false);
      // Pick up where a previous session left off: anything still waiting
      // for analysis gets queued automatically (survives page refreshes).
      for (const img of data.images) {
        if (
          img.analysis_status === "UPLOADED" ||
          img.analysis_status === "QUEUED"
        ) {
          enqueueAnalysis(img.id);
        }
      }
    },
    [enqueueAnalysis, query, tagFilters, hasVideosFilter]
  );

  // Reload with a short delay while typing (debounce).
  useEffect(() => {
    const timer = setTimeout(() => loadImages(0), 300);
    return () => clearTimeout(timer);
  }, [loadImages]);

  const refreshTags = useCallback(() => {
    fetch("/api/tags")
      .then((res) => res.json<{ tags: TagRecord[] }>())
      .then((data) => setAllTags(data.tags))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshTags();
    // Resume: if a batch was interrupted by a refresh, show its progress again.
    fetch("/api/batches/active")
      .then((res) =>
        res.json<{
          batch: { id: string; status: string } | null;
          progress?: BatchProgress;
        }>()
      )
      .then((data) => {
        if (data.batch) {
          setBatch({
            id: data.batch.id,
            status: data.batch.status,
            progress: data.progress!,
          });
        }
      })
      .catch(() => {});
  }, [refreshTags]);

  // While a batch is active, poll its progress from the database every 2.5s
  // (spec 28/29: progress must survive refreshes, polling is fine for V0).
  useEffect(() => {
    if (!batch || batch.status !== "ACTIVE") return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/batches/${batch.id}`).catch(() => null);
      if (!res?.ok) return;
      const data = await res.json<{
        batch: { id: string; status: string };
        progress: BatchProgress;
      }>();
      setBatch({
        id: data.batch.id,
        status: data.batch.status,
        progress: data.progress,
      });
    }, 2500);
    return () => clearInterval(timer);
  }, [batch?.id, batch?.status]);

  async function retryFailedAnalyses() {
    if (!batch) return;
    const res = await fetch(`/api/batches/${batch.id}`).catch(() => null);
    if (!res?.ok) return;
    const data = await res.json<{ failedAnalysisImageIds: string[] }>();
    for (const id of data.failedAnalysisImageIds) retryAnalysis(id);
    setBatch((prev) => (prev ? { ...prev, status: "ACTIVE" } : prev));
  }

  async function dismissBatch() {
    if (!batch) return;
    await fetch(`/api/batches/${batch.id}/dismiss`, { method: "POST" }).catch(
      () => {}
    );
    setBatch(null);
    setUploads([]);
  }

  async function deleteImage(image: ImageRecord): Promise<boolean> {
    const confirmed = window.confirm(
      `Delete "${image.original_filename}"?\n\nThe file will be PERMANENTLY removed from cloud storage.`
    );
    if (!confirmed) return false;

    let res = await fetch(`/api/images/${image.id}`, { method: "DELETE" });

    if (res.status === 409) {
      const data = await res
        .json<{ videoCount?: number }>()
        .catch(() => ({ videoCount: undefined }));
      const count = data.videoCount ?? image.video_count;
      const alsoVideos = window.confirm(
        `This image has ${count} linked video${count === 1 ? "" : "s"}.\n\n` +
          `Delete the image AND its video${count === 1 ? "" : "s"} permanently?\n\n` +
          `Choose Cancel to keep everything.`
      );
      if (!alsoVideos) return false;
      res = await fetch(`/api/images/${image.id}?with_videos=1`, {
        method: "DELETE",
      });
    }

    if (res.ok) {
      setImages((prev) => prev.filter((img) => img.id !== image.id));
      setTotal((prev) => Math.max(0, prev - 1));
      return true;
    }
    const data = await res.json<{ error?: string }>().catch(() => ({}));
    alert(data.error ?? "Deletion failed. Please try again.");
    return false;
  }

  function updateUpload(key: number, patch: Partial<UploadEntry>) {
    setUploads((prev) =>
      prev.map((u) => (u.key === key ? { ...u, ...patch } : u))
    );
  }

  async function uploadOne(file: File, entryKey: number, itemId: string) {
    try {
      const hash = await sha256Hex(file);

      const checkRes = await fetch("/api/images/check-hash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash }),
      });
      const check = await checkRes.json<{ duplicate: boolean }>();
      if (check.duplicate) {
        const uploadAnyway = window.confirm(
          `"${file.name}" already exists in your library.\n\nUpload it anyway?`
        );
        if (!uploadAnyway) {
          await fetch(`/api/batches/items/${itemId}/skip`, { method: "POST" });
          updateUpload(entryKey, {
            status: "skipped",
            message: "Already in library",
          });
          return;
        }
      }

      const { width, height, thumbnail } = await processImage(file);

      updateUpload(entryKey, { status: "uploading" });
      const form = new FormData();
      form.append("file", file);
      form.append("thumbnail", thumbnail, "thumbnail.webp");
      form.append("hash", hash);
      form.append("width", String(width));
      form.append("height", String(height));
      form.append("batch_item_id", itemId);

      const res = await fetch("/api/images", { method: "POST", body: form });
      if (!res.ok) {
        const data = await res.json<{ error?: string }>().catch(() => ({}));
        throw new Error(data.error ?? `Upload failed (${res.status}).`);
      }

      const { image } = await res.json<{ image: ImageRecord }>();
      setImages((prev) => [image, ...prev]);
      setTotal((prev) => prev + 1);
      updateUpload(entryKey, { status: "done" });
      enqueueAnalysis(image.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed.";
      await fetch(`/api/batches/items/${itemId}/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: message }),
      }).catch(() => {});
      updateUpload(entryKey, { status: "error", message });
    }
  }

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = [...fileList].filter((f) =>
        ACCEPTED_IMAGE_TYPES.includes(f.type)
      );
      const rejected = [...fileList].length - files.length;
      if (rejected > 0) {
        alert(
          `${rejected} file(s) were skipped — only JPG, PNG and WEBP images are supported.`
        );
      }
      if (files.length === 0) return;

      // Register the batch in the database first, so progress survives
      // refreshes and interrupted imports are visible later.
      const batchRes = await fetch("/api/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filenames: files.map((f) => f.name) }),
      });
      if (!batchRes.ok) {
        alert("Could not start the import. Please try again.");
        return;
      }
      const { batchId, items } = await batchRes.json<{
        batchId: string;
        items: Array<{ id: string; filename: string }>;
      }>();

      setBatch({
        id: batchId,
        status: "ACTIVE",
        progress: {
          total: files.length,
          uploaded: 0,
          uploadFailed: 0,
          skipped: 0,
          pendingUpload: files.length,
          analyzed: 0,
          analysisFailed: 0,
        },
      });

      const entries = files.map((file, index) => ({
        key: ++uploadKeyCounter,
        filename: file.name,
        status: "preparing" as UploadStatus,
        file,
        itemId: items[index].id,
      }));
      setUploads((prev) => [
        ...prev.filter(
          (u) => u.status === "preparing" || u.status === "uploading"
        ),
        ...entries.map(({ file: _f, itemId: _i, ...entry }) => entry),
      ]);

      // Simple upload pool: a few files at a time, so 50 files don't fire at once.
      let next = 0;
      const workerLoop = async () => {
        while (next < entries.length) {
          const item = entries[next++];
          await uploadOne(item.file, item.key, item.itemId);
        }
      };
      for (let i = 0; i < UPLOAD_CONCURRENCY; i++) void workerLoop();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Window-level drag & drop
  useEffect(() => {
    function onDragEnter(e: DragEvent) {
      if (detailOpenRef.current || hiddenRef.current) return;
      if (!e.dataTransfer?.types.includes("Files")) return;
      dragDepth.current++;
      setDragActive(true);
    }
    function onDragLeave() {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragActive(false);
    }
    function onDragOver(e: DragEvent) {
      e.preventDefault();
    }
    function onDrop(e: DragEvent) {
      e.preventDefault();
      dragDepth.current = 0;
      setDragActive(false);
      if (detailOpenRef.current || hiddenRef.current) return;
      if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    }
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [handleFiles]);

  const activeUploads = uploads.filter(
    (u) => u.status === "preparing" || u.status === "uploading"
  ).length;

  return (
    <div className="library">
      <div className="library-toolbar">
        <h1 className="library-title">
          Library{" "}
          <span className="muted count">
            {total} image{total === 1 ? "" : "s"}
          </span>
        </h1>
        <input
          className="search-input"
          type="text"
          placeholder="Search — e.g. computer night, guitar, streamer…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className={`ghost-button ${showFilters || filtersActive ? "active" : ""}`}
          onClick={() => {
            setShowFilters((v) => !v);
            refreshTags();
          }}
        >
          Filters
        </button>
        <button onClick={() => fileInputRef.current?.click()}>
          Upload images
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(",")}
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {showFilters && (
        <div className="filter-bar">
          {FILTER_CATEGORIES.map(({ category, label }) => {
            const options = allTags.filter(
              (t) => t.category === category && t.usage_count > 0
            );
            if (options.length === 0) return null;
            return (
              <label key={category} className="filter-field">
                <span>{label}</span>
                <select
                  value={tagFilters[category] ?? ""}
                  onChange={(e) =>
                    setTagFilters((prev) => ({
                      ...prev,
                      [category]: e.target.value,
                    }))
                  }
                >
                  <option value="">Any</option>
                  {options.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.canonical_name} ({t.usage_count})
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          <label className="filter-field">
            <span>Videos</span>
            <select
              value={hasVideosFilter}
              onChange={(e) => setHasVideosFilter(e.target.value)}
            >
              <option value="">Any</option>
              <option value="1">Has videos</option>
              <option value="0">No videos</option>
            </select>
          </label>
          {filtersActive && (
            <button
              className="ghost-button small"
              onClick={() => {
                setTagFilters({});
                setHasVideosFilter("");
                setQuery("");
              }}
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="centered-block muted">Loading library…</div>
      ) : images.length === 0 && filtersActive ? (
        <div className="centered-block">
          <div className="empty-card">
            <h2>No images match</h2>
            <p className="muted">
              Try fewer words or remove some filters.
            </p>
            <button
              className="ghost-button"
              onClick={() => {
                setTagFilters({});
                setHasVideosFilter("");
                setQuery("");
              }}
            >
              Clear search & filters
            </button>
          </div>
        </div>
      ) : images.length === 0 ? (
        <div className="centered-block">
          <div className="empty-card">
            <div className="empty-icon">🖼</div>
            <h2>Your library is empty</h2>
            <p className="muted">
              Drag images anywhere on this page, or click "Upload images".
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="grid">
            {images.map((image) => (
              <ImageCard
                key={image.id}
                image={image}
                onOpen={() => setSelectedImageId(image.id)}
                onRetryAnalysis={() => retryAnalysis(image.id)}
                onDelete={() => deleteImage(image)}
              />
            ))}
          </div>
          {images.length < total && (
            <div className="load-more">
              <button
                className="ghost-button"
                onClick={() => loadImages(images.length)}
              >
                Load more ({total - images.length} remaining)
              </button>
            </div>
          )}
        </>
      )}

      {selectedImageId &&
        (() => {
          const index = images.findIndex((i) => i.id === selectedImageId);
          return (
            <ImageDetail
              imageId={selectedImageId}
              allTags={allTags}
              onClose={() => {
                setSelectedImageId(null);
                refreshTags();
              }}
              onChanged={(image) => {
                replaceImage(image);
                refreshTags();
              }}
              onDelete={async () => {
                const image = images.find((i) => i.id === selectedImageId);
                if (!image) return false;
                return deleteImage(image);
              }}
              onPrev={
                index > 0
                  ? () => setSelectedImageId(images[index - 1].id)
                  : undefined
              }
              onNext={
                index >= 0 && index < images.length - 1
                  ? () => setSelectedImageId(images[index + 1].id)
                  : undefined
              }
            />
          );
        })()}

      {dragActive && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">Drop images to import</div>
        </div>
      )}

      {batch && (
        <div className="upload-panel">
          <div className="upload-panel-header">
            <strong>
              {batch.status === "ACTIVE"
                ? `Importing ${batch.progress.total} image${batch.progress.total === 1 ? "" : "s"}`
                : "Import finished"}
            </strong>
            {batch.status !== "ACTIVE" && (
              <button className="ghost-button small" onClick={dismissBatch}>
                Dismiss
              </button>
            )}
          </div>

          <ProgressRow
            label="Uploading"
            done={
              batch.progress.uploaded +
              batch.progress.skipped +
              batch.progress.uploadFailed
            }
            total={batch.progress.total}
          />
          <ProgressRow
            label="AI analysis"
            done={batch.progress.analyzed + batch.progress.analysisFailed}
            total={batch.progress.uploaded}
          />

          {batch.progress.uploadFailed > 0 && (
            <p className="panel-note error">
              {batch.progress.uploadFailed} file
              {batch.progress.uploadFailed === 1 ? "" : "s"} failed to upload.
              Drop them again to retry — already-imported files are detected
              automatically.
            </p>
          )}
          {batch.progress.pendingUpload > 0 && activeUploads === 0 && (
            <p className="panel-note">
              {batch.progress.pendingUpload} file
              {batch.progress.pendingUpload === 1 ? " was" : "s were"} never
              uploaded (the page was closed during import). Drop them again to
              finish.{" "}
              <button className="ghost-button small" onClick={dismissBatch}>
                Dismiss
              </button>
            </p>
          )}
          {batch.progress.analysisFailed > 0 && (
            <p className="panel-note error">
              AI analysis failed for {batch.progress.analysisFailed} image
              {batch.progress.analysisFailed === 1 ? "" : "s"}.{" "}
              <button
                className="ghost-button small"
                onClick={retryFailedAnalyses}
              >
                Retry failed
              </button>
            </p>
          )}

          {uploads.length > 0 && (
            <ul>
              {uploads.slice(-6).map((u) => (
                <li key={u.key} className={`upload-item ${u.status}`}>
                  <span className="upload-name" title={u.filename}>
                    {u.filename}
                  </span>
                  <span className="upload-status">
                    {u.status === "preparing" && "Preparing…"}
                    {u.status === "uploading" && "Uploading…"}
                    {u.status === "done" && "✓"}
                    {u.status === "skipped" && (u.message ?? "Skipped")}
                    {u.status === "error" && (u.message ?? "Failed")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ProgressRow({
  label,
  done,
  total,
}: {
  label: string;
  done: number;
  total: number;
}) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress-row">
      <div className="progress-labels">
        <span>{label}</span>
        <span className="muted">
        {done} / {total}
        </span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function ImageCard({
  image,
  onOpen,
  onRetryAnalysis,
  onDelete,
}: {
  image: ImageRecord;
  onOpen: () => void;
  onRetryAnalysis: () => void;
  onDelete: () => void;
}) {
  const src = `/api/media/${image.thumbnail_key ?? image.storage_key}`;
  const date = image.created_at
    ? new Date(image.created_at.replace(" ", "T") + "Z").toLocaleDateString()
    : "";

  const status = image.analysis_status;

  return (
    <div className="card" onClick={onOpen}>
      <div className="thumb-wrap">
        <img src={src} alt={image.original_filename} loading="lazy" />
        <button
          className="card-delete"
          title="Delete image"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          ✕
        </button>
        {(status === "UPLOADED" || status === "QUEUED") && (
          <span className="badge badge-status">Waiting for AI</span>
        )}
        {status === "ANALYZING" && (
          <span className="badge badge-status">Analyzing…</span>
        )}
        {status === "ERROR" && (
          <span className="badge badge-error">AI failed</span>
        )}
        {image.video_count > 0 && (
          <span className="badge badge-videos">▶ {image.video_count}</span>
        )}
      </div>
      <div className="card-meta">
        <span className="card-title" title={image.original_filename}>
          {image.description ?? image.original_filename}
        </span>
        <span className="muted card-date">{date}</span>
        {status === "ERROR" && (
          <button
            className="ghost-button small retry-button"
            onClick={(e) => {
              e.stopPropagation();
              onRetryAnalysis();
            }}
          >
            Retry analysis
          </button>
        )}
      </div>
    </div>
  );
}
