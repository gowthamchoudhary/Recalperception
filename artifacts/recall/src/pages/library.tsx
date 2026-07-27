import { useEffect, useRef, useState } from "react";
import {
  Upload,
  Clock,
  MapPin,
  Play,
  Check,
  X,
  AlertCircle,
  Film,
  Link2,
  Loader2,
  FolderOpen,
} from "lucide-react";
import {
  useListVideos,
  useGetStats,
  useUploadVideo,
  useDeleteVideo,
  getListVideosQueryKey,
  getListReviewItemsQueryKey,
  getGetStatsQueryKey,
} from "@workspace/api-client-react";
import { Button, Card } from "@/components/ui";
import { AppShell } from "@/components/layout/AppShell";
import { VideoActions } from "@/components/video-actions";
import { useQueryClient } from "@tanstack/react-query";

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB (matches the API limit)
const UPLOAD_CONCURRENCY = 3;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv|3gp|mpe?g)$/i;

function isVideoFile(f: File): boolean {
  return f.type.startsWith("video/") || VIDEO_EXT.test(f.name);
}

function apiErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
      return (data as { error: string }).error;
    }
    if (err instanceof Error && err.message) {
      return err.message;
    }
  }
  return "Upload failed. Please try again.";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

type BatchItem = {
  key: string;
  kind: "file" | "url";
  file?: File;
  url?: string;
  label: string;
  sizeLabel?: string;
  status: "queued" | "uploading" | "done" | "error" | "cancelled";
  error?: string;
  /** Pre-marked as not uploadable (e.g. over the size cap) — never sent. */
  skipped?: boolean;
  /** Server-side video id, once the upload was accepted (202). */
  videoId?: number;
};

/**
 * Identity for de-duping re-picked files. Includes the folder-relative path
 * and mtime so same-named files from different subfolders are NOT dropped.
 */
function fileSig(f: File): string {
  return `${f.webkitRelativePath || f.name}:${f.size}:${f.lastModified}`;
}

/** Attributes for folder selection; not in React's input typings. */
const folderInputProps = {
  webkitdirectory: "",
} as unknown as React.InputHTMLAttributes<HTMLInputElement>;

export default function LibraryPage() {
  const queryClient = useQueryClient();

  // ---- Batch upload state ----
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [batch, setBatch] = useState<BatchItem[]>([]);
  const [urlsText, setUrlsText] = useState("");
  const [privacyRequest, setPrivacyRequest] = useState("");
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [isCancellingBatch, setIsCancellingBatch] = useState(false);
  const cancelBatchRef = useRef(false);
  const [cancellingIds, setCancellingIds] = useState<Set<number>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const { data: videos = [], isLoading: isLoadingVideos } = useListVideos(undefined, {
    query: {
      queryKey: getListVideosQueryKey(),
      // Poll while any video is still being ingested by VideoDB.
      refetchInterval: (query) => (query.state.data?.some((v) => v.status === "processing") ? 4000 : false),
    },
  });
  const anyProcessing = videos.some((v) => v.status === "processing");
  const { data: stats } = useGetStats({ query: { queryKey: getGetStatsQueryKey() } });

  const uploadVideo = useUploadVideo();
  const deleteVideo = useDeleteVideo();

  /**
   * Cancel = delete: processing is fully server-side, so removing the row
   * tells the pipeline to stop at its next stage boundary and clean up.
   */
  const cancelVideo = (id: number) => {
    setCancellingIds((prev) => new Set(prev).add(id));
    deleteVideo.mutate(
      { id },
      {
        onSettled: () => {
          setCancellingIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
        },
      },
    );
  };

  // When ingestion finishes (processing -> indexed/flagged/failed), refresh
  // the review queue and stats once more so nothing is left stale.
  const wasProcessing = useRef(false);
  useEffect(() => {
    if (wasProcessing.current && !anyProcessing) {
      queryClient.invalidateQueries({ queryKey: getListReviewItemsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
    }
    wasProcessing.current = anyProcessing;
  }, [anyProcessing, queryClient]);

  const closeUpload = () => {
    if (isBatchRunning) return;
    setIsUploadOpen(false);
    setBatch([]);
    setUrlsText("");
    setPrivacyRequest("");
    setUploadNote(null);
  };

  /** Add files (from picker, folder picker, or drag-drop) to the batch. */
  const addFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    const videosOnly = files.filter(isVideoFile);
    const skipped = files.length - videosOnly.length;
    setBatch((prev) => {
      const seen = new Set(prev.map((i) => (i.kind === "file" && i.file ? fileSig(i.file) : i.url ?? "")));
      const next = [...prev];
      for (const f of videosOnly) {
        const sig = fileSig(f);
        if (seen.has(sig)) continue;
        seen.add(sig);
        const tooBig = f.size > MAX_FILE_BYTES;
        next.push({
          key: `${sig}:${Math.random().toString(36).slice(2)}`,
          kind: "file",
          file: f,
          label: f.name,
          sizeLabel: formatBytes(f.size),
          status: tooBig ? "error" : "queued",
          error: tooBig ? "Larger than 2 GB — will be skipped" : undefined,
          skipped: tooBig,
        });
      }
      return next;
    });
    setUploadNote(skipped > 0 ? `Skipped ${skipped} non-video file${skipped === 1 ? "" : "s"}.` : null);
  };

  /** Add pasted links (one per line) to the same batch. */
  const addUrls = () => {
    const lines = urlsText
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    const invalid: string[] = [];
    const valid: string[] = [];
    for (const line of lines) {
      try {
        new URL(line);
        valid.push(line);
      } catch {
        invalid.push(line);
      }
    }
    setBatch((prev) => {
      const seen = new Set(prev.map((i) => (i.kind === "url" ? i.url ?? "" : "")));
      const next = [...prev];
      for (const url of valid) {
        if (seen.has(url)) continue;
        seen.add(url);
        next.push({
          key: `url:${url}:${Math.random().toString(36).slice(2)}`,
          kind: "url",
          url,
          label: url,
          status: "queued",
        });
      }
      return next;
    });
    setUrlsText(invalid.join("\n"));
    setUploadNote(
      invalid.length > 0
        ? `${invalid.length} line${invalid.length === 1 ? " is" : "s are"} not a valid link — fix or remove ${invalid.length === 1 ? "it" : "them"}.`
        : null,
    );
  };

  const removeItem = (key: string) => {
    setBatch((prev) => prev.filter((i) => i.key !== key));
  };

  /**
   * Upload the whole batch: every video is its own request and its own
   * ingestion pipeline, so one flagged or failed video never blocks the rest.
   */
  const startBatch = async () => {
    const queued = batch.filter((i) => i.status === "queued");
    if (queued.length === 0 || isBatchRunning) return;
    setIsBatchRunning(true);
    setUploadNote(null);
    cancelBatchRef.current = false;
    setIsCancellingBatch(false);
    const pr = privacyRequest.trim();
    const queue = [...queued];
    const setItem = (key: string, patch: Partial<BatchItem>) =>
      setBatch((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
    let failures = 0;
    const uploaded: Array<{ key: string; id: number }> = [];

    const worker = async () => {
      for (;;) {
        // Stop picking up new work once the batch is cancelled.
        if (cancelBatchRef.current) return;
        const item = queue.shift();
        if (!item) return;
        setItem(item.key, { status: "uploading" });
        try {
          const created = await uploadVideo.mutateAsync({
            data: {
              ...(item.kind === "file" ? { file: item.file! } : { url: item.url! }),
              ...(pr ? { privacyRequest: pr } : {}),
            },
          });
          uploaded.push({ key: item.key, id: created.id });
          setItem(item.key, { status: "done", videoId: created.id });
        } catch (err) {
          failures += 1;
          setItem(item.key, { status: "error", error: apiErrorMessage(err) });
        }
        // Each accepted upload appears in the grid immediately as "Indexing".
        queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
      }
    };

    await Promise.all([...Array(Math.min(UPLOAD_CONCURRENCY, queue.length))].map(() => worker()));

    if (cancelBatchRef.current) {
      // Remove everything this batch already created server-side; the
      // pipeline notices the deletion and stops cleanly.
      const results = await Promise.allSettled(uploaded.map(({ id }) => deleteVideo.mutateAsync({ id })));
      const removed = results.filter((r) => r.status === "fulfilled").length;
      const uploadedKeys = new Set(uploaded.map((u) => u.key));
      setBatch((prev) =>
        prev.map((i) =>
          i.status === "queued" || (i.status === "done" && uploadedKeys.has(i.key))
            ? { ...i, status: "cancelled" as const, error: undefined }
            : i,
        ),
      );
      queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
      setUploadNote(`Batch cancelled — ${removed} upload${removed === 1 ? "" : "s"} removed, nothing kept.`);
      cancelBatchRef.current = false;
      setIsCancellingBatch(false);
      setIsBatchRunning(false);
      return;
    }

    setIsBatchRunning(false);
    // Only auto-close on FULL success — no failed uploads and no skipped
    // rows the user might not have noticed (e.g. files over the size cap).
    const skippedCount = batch.filter((i) => i.skipped).length;
    if (failures === 0 && skippedCount === 0) {
      setIsUploadOpen(false);
      setBatch([]);
      setUrlsText("");
      setPrivacyRequest("");
    } else {
      const parts: string[] = [];
      if (failures > 0) {
        parts.push(`${failures} upload${failures === 1 ? "" : "s"} failed`);
      }
      if (skippedCount > 0) {
        parts.push(`${skippedCount} file${skippedCount === 1 ? " was" : "s were"} skipped (larger than 2 GB)`);
      }
      setUploadNote(`${parts.join(" and ")} — everything else went through.`);
    }
  };

  const queuedCount = batch.filter((i) => i.status === "queued").length;
  const doneCount = batch.filter((i) => i.status === "done").length;
  const activeTotal = batch.filter((i) => !i.skipped && i.status !== "cancelled").length;

  return (
    <AppShell>
      <div className="flex-1 max-w-[1400px] w-full mx-auto px-5 md:px-10 py-10 relative">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
          <div>
            <div className="text-[11px] font-mono font-bold uppercase tracking-[0.18em] text-muted-foreground mb-2">Your memories</div>
            <h1 className="text-3xl font-extrabold tracking-tight">Library</h1>
            {stats && (
              <div className="mt-2 flex items-center gap-4 text-[12.5px] font-semibold text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Play className="w-3.5 h-3.5" /> {stats.totalVideos} videos
                </span>
                <span className="flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" /> {Math.round(stats.totalHoursIndexed)} hours indexed
                </span>
              </div>
            )}
          </div>
          <Button onClick={() => setIsUploadOpen(true)} className="rounded-full shadow-md font-bold px-6" data-testid="open-upload">
            <Upload className="w-4 h-4 mr-2" /> Upload
          </Button>
        </div>

        {/* Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {isLoadingVideos ? (
            [...Array(8)].map((_, i) => (
              <div key={i} className="animate-pulse">
                <div className="aspect-video bg-secondary rounded-2xl mb-3" />
                <div className="h-5 bg-secondary rounded w-3/4 mb-2" />
                <div className="h-4 bg-secondary rounded w-1/2" />
              </div>
            ))
          ) : videos.length === 0 ? (
            <div className="col-span-full py-20 text-center text-muted-foreground font-medium">
              No videos yet. Upload your first memory to get started.
            </div>
          ) : (
            videos.map((video) => (
              <div key={video.id} className="group">
                <div className="aspect-video bg-secondary rounded-2xl mb-4 overflow-hidden relative border border-border shadow-sm group-hover:shadow-md transition-all group-hover:-translate-y-1">
                  {video.thumbnailUrl ? (
                    <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-secondary to-border">
                      <Film className="w-8 h-8 text-muted-foreground/50" />
                    </div>
                  )}
                  {video.status !== "indexed" && (
                    <div
                      title={video.status === "failed" ? (video.indexError ?? undefined) : undefined}
                      className={`absolute top-3 left-3 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider backdrop-blur-md flex items-center gap-1.5 text-white ${
                        video.status === "processing" ? "bg-amber-500/90" : video.status === "flagged" ? "bg-orange-600/90" : "bg-red-600/90"
                      }`}
                    >
                      {video.status === "processing" && <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
                      {video.status === "processing" ? "Indexing" : video.status === "flagged" ? "Needs review" : "Failed"}
                    </div>
                  )}
                  {video.status === "processing" ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        cancelVideo(video.id);
                      }}
                      disabled={cancellingIds.has(video.id)}
                      title="Stop processing and remove this video"
                      data-testid={`cancel-video-${video.id}`}
                      className="absolute top-3 right-3 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider bg-black/60 backdrop-blur-md text-white hover:bg-red-600 transition-colors disabled:opacity-60"
                    >
                      {cancellingIds.has(video.id) ? "Cancelling…" : "Cancel"}
                    </button>
                  ) : (
                    <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <VideoActions video={video} variant="overlay" />
                    </div>
                  )}
                  {video.durationSeconds > 0 && (
                    <div className="absolute bottom-3 right-3 px-2 py-1 bg-black/60 backdrop-blur-md rounded-md text-[10px] font-mono font-bold text-white">
                      {Math.floor(video.durationSeconds / 60)}:{(video.durationSeconds % 60).toString().padStart(2, "0")}
                    </div>
                  )}
                </div>
                <h3 className="font-bold text-base mb-1 truncate group-hover:text-accent transition-colors">{video.title}</h3>
                <div className="flex items-center gap-3 text-xs font-semibold text-muted-foreground">
                  <span>{new Date(video.uploadedAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })}</span>
                  {video.location && (
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" /> {video.location}
                    </span>
                  )}
                </div>
                {video.status === "failed" && video.indexError && (
                  <p className="mt-1 text-xs font-medium text-red-600 line-clamp-2">{video.indexError}</p>
                )}
              </div>
            ))
          )}
        </div>

        {/* Batch Upload Overlay */}
        {isUploadOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
            <div className="absolute inset-0" onClick={closeUpload} />
            <Card className="w-full max-w-2xl p-8 relative z-10 rounded-[24px] shadow-2xl border-border animate-in fade-in zoom-in duration-200 max-h-[90dvh] overflow-y-auto">
              <button
                onClick={closeUpload}
                className="absolute top-6 right-6 text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                disabled={isBatchRunning}
                aria-label="Close upload dialog"
              >
                <X className="w-6 h-6" />
              </button>
              <h2 className="text-2xl font-extrabold mb-2">Upload memories</h2>
              <p className="text-muted-foreground font-medium mb-6">
                Select a whole folder or several files at once — the batch uploads together, and every video indexes independently.
              </p>

              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                multiple
                className="hidden"
                data-testid="file-input"
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <input
                ref={folderInputRef}
                type="file"
                multiple
                className="hidden"
                data-testid="folder-input"
                {...folderInputProps}
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />

              {/* Selection zone */}
              <div
                className="border-2 border-dashed border-border rounded-2xl p-8 flex flex-col items-center justify-center text-center bg-secondary/30 transition-colors hover:bg-secondary/50 hover:border-primary/30"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!isBatchRunning) addFiles(e.dataTransfer.files);
                }}
              >
                <div className="w-14 h-14 bg-card rounded-full shadow-sm flex items-center justify-center mb-4">
                  <Upload className="w-6 h-6 text-primary" />
                </div>
                <h3 className="font-bold text-lg mb-1">Drag and drop videos</h3>
                <p className="text-sm font-medium text-muted-foreground mb-5">MP4, MOV and friends — up to 2 GB each</p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <Button onClick={() => fileInputRef.current?.click()} disabled={isBatchRunning} className="rounded-xl font-bold px-6 shadow-sm">
                    <Film className="w-4 h-4 mr-2" /> Select files
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => folderInputRef.current?.click()}
                    disabled={isBatchRunning}
                    className="rounded-xl font-bold px-6"
                  >
                    <FolderOpen className="w-4 h-4 mr-2" /> Select folder
                  </Button>
                </div>
              </div>

              {/* Paste links */}
              <div className="mt-5">
                <div className="flex items-center gap-4 mb-3">
                  <div className="h-px flex-1 bg-border" />
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">or paste links — one per line</span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <div className="flex gap-3 items-start">
                  <div className="relative flex-1">
                    <div className="absolute top-4 left-4 pointer-events-none">
                      <Link2 className="w-4 h-4 text-muted-foreground" />
                    </div>
                    <textarea
                      value={urlsText}
                      onChange={(e) => setUrlsText(e.target.value)}
                      disabled={isBatchRunning}
                      rows={2}
                      placeholder={"https://example.com/clip.mp4\nhttps://…/clip.mov"}
                      className="w-full pl-11 pr-4 py-3 rounded-xl bg-card border border-border text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-all placeholder:text-muted-foreground/60 resize-none"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={addUrls}
                    disabled={!urlsText.trim() || isBatchRunning}
                    className="rounded-xl font-bold px-5 h-12"
                  >
                    Add to batch
                  </Button>
                </div>
              </div>

              {/* Queue */}
              {batch.length > 0 && (
                <div className="mt-6 border border-border rounded-2xl overflow-hidden">
                  <div className="px-4 py-2.5 bg-secondary/40 border-b border-border text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    Batch · {batch.length} video{batch.length === 1 ? "" : "s"}
                  </div>
                  <ul className="max-h-52 overflow-y-auto divide-y divide-border/60">
                    {batch.map((item) => (
                      <li key={item.key} className="flex items-center gap-3 px-4 py-2.5" data-testid={`batch-item-${item.status}`}>
                        {item.kind === "file" ? (
                          <Film className="w-4 h-4 text-muted-foreground shrink-0" />
                        ) : (
                          <Link2 className="w-4 h-4 text-muted-foreground shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold truncate">{item.label}</p>
                          {item.error ? (
                            <p className="text-xs font-medium text-red-600 truncate">{item.error}</p>
                          ) : item.sizeLabel ? (
                            <p className="text-xs font-medium text-muted-foreground">{item.sizeLabel}</p>
                          ) : null}
                        </div>
                        <div className="shrink-0 flex items-center">
                          {item.status === "queued" && !isBatchRunning && (
                            <button
                              onClick={() => removeItem(item.key)}
                              className="text-muted-foreground hover:text-red-600 transition-colors"
                              aria-label={`Remove ${item.label}`}
                            >
                              <X className="w-4 h-4" />
                            </button>
                          )}
                          {item.status === "queued" && isBatchRunning && (
                            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Queued</span>
                          )}
                          {item.status === "uploading" && <Loader2 className="w-4 h-4 text-accent animate-spin" />}
                          {item.status === "done" && <Check className="w-4 h-4 text-accent" />}
                          {item.status === "error" && <AlertCircle className="w-4 h-4 text-red-600" />}
                          {item.status === "cancelled" && (
                            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Cancelled</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* The one pre-process field */}
              <div className="mt-6">
                <label htmlFor="privacy-request" className="block font-bold text-sm mb-1">
                  Anything you don't want processed? <span className="font-medium text-muted-foreground">(optional)</span>
                </label>
                <p className="text-xs font-medium text-muted-foreground mb-2.5">
                  Describe it and we'll flag matching videos for your review instead of auto-including them.
                </p>
                <textarea
                  id="privacy-request"
                  value={privacyRequest}
                  onChange={(e) => setPrivacyRequest(e.target.value)}
                  disabled={isBatchRunning}
                  maxLength={500}
                  rows={2}
                  placeholder={'e.g. "skip anything with my ex", "no medical stuff", "flag any screen recordings"'}
                  className="w-full px-4 py-3 rounded-xl bg-card border border-border text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-all placeholder:text-muted-foreground/60 resize-none"
                />
              </div>

              {uploadNote && (
                <div className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm font-medium text-amber-800">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{uploadNote}</span>
                </div>
              )}

              {/* Footer */}
              <div className="mt-6 flex items-center justify-between gap-4">
                <p className="text-sm font-semibold text-muted-foreground">
                  {isBatchRunning
                    ? `Uploading ${Math.min(doneCount + 1, activeTotal)} of ${activeTotal}…`
                    : queuedCount > 0
                      ? `${queuedCount} video${queuedCount === 1 ? "" : "s"} ready`
                      : "Nothing queued yet"}
                </p>
                <div className="flex items-center gap-3">
                  {isBatchRunning && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        cancelBatchRef.current = true;
                        setIsCancellingBatch(true);
                      }}
                      disabled={isCancellingBatch}
                      className="rounded-xl font-bold h-12"
                      data-testid="cancel-batch"
                    >
                      {isCancellingBatch ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Cancelling…
                        </>
                      ) : (
                        "Cancel batch"
                      )}
                    </Button>
                  )}
                  <Button
                    onClick={startBatch}
                    disabled={queuedCount === 0 || isBatchRunning}
                    className="rounded-xl font-bold px-8 h-12 shadow-sm"
                    data-testid="start-batch"
                  >
                    {isBatchRunning ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Uploading…
                      </>
                    ) : (
                      <>
                        Upload {queuedCount > 0 ? queuedCount : ""} video{queuedCount === 1 ? "" : "s"}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}
