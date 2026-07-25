import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Navbar } from "@/components/layout/Navbar";
import {
  Search,
  Upload,
  Clock,
  MapPin,
  Tag,
  Edit2,
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
  useListReviewItems,
  useResolveReviewItem,
  useGetStats,
  useUploadVideo,
  getListVideosQueryKey,
  getListReviewItemsQueryKey,
  getGetStatsQueryKey,
} from "@workspace/api-client-react";
import { Button, Card } from "@/components/ui";
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
    if (
      data &&
      typeof data === "object" &&
      typeof (data as { error?: unknown }).error === "string"
    ) {
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
  status: "queued" | "uploading" | "done" | "error";
  error?: string;
  /** Pre-marked as not uploadable (e.g. over the size cap) — never sent. */
  skipped?: boolean;
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

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"library" | "review">("library");

  // ---- Batch upload state ----
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [batch, setBatch] = useState<BatchItem[]>([]);
  const [urlsText, setUrlsText] = useState("");
  const [privacyRequest, setPrivacyRequest] = useState("");
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const { data: videos = [], isLoading: isLoadingVideos } = useListVideos(
    undefined,
    {
      query: {
        queryKey: getListVideosQueryKey(),
        // Poll while any video is still being ingested by VideoDB.
        refetchInterval: (query) =>
          query.state.data?.some((v) => v.status === "processing") ? 4000 : false,
      },
    },
  );
  const anyProcessing = videos.some((v) => v.status === "processing");

  const { data: reviewItems = [], isLoading: isLoadingReview } =
    useListReviewItems({
      query: {
        queryKey: getListReviewItemsQueryKey(),
        refetchInterval: anyProcessing ? 4000 : false,
      },
    });
  const { data: stats } = useGetStats();

  const uploadVideo = useUploadVideo();
  const resolveReview = useResolveReviewItem();

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

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      setLocation(`/search?q=${encodeURIComponent(searchQuery)}`);
    }
  };

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
      const seen = new Set(
        prev.map((i) => (i.kind === "file" && i.file ? fileSig(i.file) : i.url ?? "")),
      );
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
    setUploadNote(
      skipped > 0 ? `Skipped ${skipped} non-video file${skipped === 1 ? "" : "s"}.` : null,
    );
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
    const pr = privacyRequest.trim();
    const queue = [...queued];
    const setItem = (key: string, patch: Partial<BatchItem>) =>
      setBatch((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i)));
    let failures = 0;

    const worker = async () => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        setItem(item.key, { status: "uploading" });
        try {
          await uploadVideo.mutateAsync({
            data: {
              ...(item.kind === "file" ? { file: item.file! } : { url: item.url! }),
              ...(pr ? { privacyRequest: pr } : {}),
            },
          });
          setItem(item.key, { status: "done" });
        } catch (err) {
          failures += 1;
          setItem(item.key, { status: "error", error: apiErrorMessage(err) });
        }
        // Each accepted upload appears in the grid immediately as "Indexing".
        queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
      }
    };

    await Promise.all(
      [...Array(Math.min(UPLOAD_CONCURRENCY, queue.length))].map(() => worker()),
    );
    setIsBatchRunning(false);
    // Only auto-close on FULL success — no failed uploads and no skipped
    // rows the user might not have noticed (e.g. files over the size cap).
    const skippedCount = batch.filter((i) => i.skipped).length;
    if (failures === 0 && skippedCount === 0) {
      setIsUploadOpen(false);
      setBatch([]);
      setUrlsText("");
      setPrivacyRequest("");
      setActiveTab("library");
    } else {
      const parts: string[] = [];
      if (failures > 0) {
        parts.push(`${failures} upload${failures === 1 ? "" : "s"} failed`);
      }
      if (skippedCount > 0) {
        parts.push(
          `${skippedCount} file${skippedCount === 1 ? " was" : "s were"} skipped (larger than 2 GB)`,
        );
      }
      setUploadNote(`${parts.join(" and ")} — everything else went through.`);
    }
  };

  const resolveItem = (id: number, status: "accepted" | "discarded") => {
    resolveReview.mutate(
      { id, data: { status } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListReviewItemsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
        },
      },
    );
  };

  const queuedCount = batch.filter((i) => i.status === "queued").length;
  const doneCount = batch.filter((i) => i.status === "done").length;
  const activeTotal = batch.filter((i) => !i.skipped).length;

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background relative pb-20">
      <Navbar variant="app" />

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-6 md:px-10 pt-32 relative z-10">
        {/* Search Hero */}
        <div className="max-w-3xl mx-auto text-center mb-16">
          <form onSubmit={handleSearch} className="relative group">
            <div className="absolute inset-y-0 left-6 flex items-center pointer-events-none">
              <Search className="w-6 h-6 text-muted-foreground group-focus-within:text-primary transition-colors" />
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Ask anything about your memories..."
              className="w-full h-20 pl-16 pr-8 rounded-full bg-card border border-border shadow-[0_8px_30px_-10px_rgba(0,0,0,0.08)] text-xl font-medium focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-all placeholder:text-muted-foreground/60"
            />
            <Button
              type="submit"
              className="absolute right-3 top-3 bottom-3 rounded-full px-8 text-base font-bold shadow-md"
              disabled={!searchQuery.trim()}
            >
              Search
            </Button>
          </form>

          {stats && (
            <div className="mt-8 flex items-center justify-center gap-6 text-sm font-semibold text-muted-foreground">
              <span className="flex items-center gap-1.5"><Play className="w-4 h-4" /> {stats.totalVideos} videos</span>
              <span className="w-1 h-1 rounded-full bg-border" />
              <span className="flex items-center gap-1.5"><Clock className="w-4 h-4" /> {Math.round(stats.totalHoursIndexed)} hours indexed</span>
              <span className="w-1 h-1 rounded-full bg-border" />
              <span className="flex items-center gap-1.5"><Tag className="w-4 h-4" /> {stats.totalScenes} scenes</span>
            </div>
          )}
        </div>

        {/* Tabs & Actions */}
        <div className="flex items-center justify-between mb-8 border-b border-border pb-4">
          <div className="flex items-center gap-8">
            <button
              onClick={() => setActiveTab("library")}
              className={`text-lg font-bold pb-4 -mb-[17px] border-b-2 transition-colors ${activeTab === "library" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-primary"}`}
            >
              Library
            </button>
            <button
              onClick={() => setActiveTab("review")}
              className={`text-lg font-bold pb-4 -mb-[17px] border-b-2 transition-colors flex items-center gap-2 ${activeTab === "review" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-primary"}`}
            >
              Needs Review
              {reviewItems.length > 0 && (
                <span className="bg-accent text-accent-foreground text-[10px] px-2 py-0.5 rounded-full">{reviewItems.length}</span>
              )}
            </button>
          </div>

          <Button onClick={() => setIsUploadOpen(true)} className="rounded-full shadow-md font-bold px-6">
            <Upload className="w-4 h-4 mr-2" /> Upload
          </Button>
        </div>

        {/* Content */}
        {activeTab === "library" && (
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
                <div key={video.id} className="group cursor-pointer">
                  <div className="aspect-video bg-secondary rounded-2xl mb-4 overflow-hidden relative border border-border shadow-sm group-hover:shadow-md transition-all group-hover:-translate-y-1">
                    {video.thumbnailUrl ? (
                      <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-secondary to-border">
                        <Film className="w-8 h-8 text-muted-foreground/50" />
                      </div>
                    )}
                    <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <div className="w-12 h-12 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center">
                        <Play className="w-5 h-5 text-white fill-white" />
                      </div>
                    </div>
                    {video.status !== "indexed" && (
                      <div
                        title={video.status === "failed" ? (video.indexError ?? undefined) : undefined}
                        className={`absolute top-3 left-3 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider backdrop-blur-md flex items-center gap-1.5 text-white ${
                          video.status === "processing"
                            ? "bg-amber-500/90"
                            : video.status === "flagged"
                              ? "bg-orange-600/90"
                              : "bg-red-600/90"
                        }`}
                      >
                        {video.status === "processing" && (
                          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                        )}
                        {video.status === "processing"
                          ? "Indexing"
                          : video.status === "flagged"
                            ? "Needs review"
                            : "Failed"}
                      </div>
                    )}
                    <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="w-8 h-8 bg-black/50 backdrop-blur-md rounded-full flex items-center justify-center text-white hover:bg-black/70">
                        <Edit2 className="w-4 h-4" />
                      </div>
                    </div>
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
                      <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {video.location}</span>
                    )}
                  </div>
                  {video.status === "failed" && video.indexError && (
                    <p className="mt-1 text-xs font-medium text-red-600 line-clamp-2">{video.indexError}</p>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === "review" && (
          <div className="bg-secondary/30 rounded-[24px] border border-border p-8 min-h-[400px]">
            {isLoadingReview ? (
              <div className="text-center py-20 text-muted-foreground font-medium">Loading review items...</div>
            ) : reviewItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-16 h-16 bg-card rounded-full flex items-center justify-center mb-4 shadow-sm border border-border">
                  <Check className="w-8 h-8 text-accent" />
                </div>
                <h3 className="text-xl font-bold mb-2">All caught up</h3>
                <p className="text-muted-foreground font-medium">No items need your review right now.</p>
              </div>
            ) : (
              <div className="space-y-4 max-w-4xl mx-auto">
                {reviewItems.map((item) => (
                  <div key={item.id} className="bg-card rounded-2xl p-4 flex flex-col sm:flex-row gap-6 border border-border shadow-sm items-center">
                    <div className="w-40 aspect-video rounded-xl overflow-hidden bg-secondary shrink-0 relative">
                      {item.thumbnailUrl ? (
                        <img src={item.thumbnailUrl} className="w-full h-full object-cover" alt="" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Film className="w-6 h-6 text-muted-foreground/50" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider mb-2 ${
                          item.reason.startsWith("Your request:")
                            ? "bg-blue-100 text-blue-800"
                            : "bg-orange-100 text-orange-800"
                        }`}
                      >
                        <AlertCircle className="w-3 h-3" />
                        {item.reason.startsWith("Your request:") ? "Your request" : "Flagged"}
                      </div>
                      <h4 className="font-bold text-base mb-1">{item.videoTitle}</h4>
                      <p className="text-sm font-medium text-muted-foreground">{item.reason}</p>
                      {item.detail && (
                        <p className="text-xs font-medium text-muted-foreground/80 mt-1 line-clamp-2">{item.detail}</p>
                      )}
                    </div>
                    <div className="flex sm:flex-col gap-2 shrink-0 w-full sm:w-auto">
                      <Button
                        onClick={() => resolveItem(item.id, "accepted")}
                        disabled={resolveReview.isPending}
                        className="flex-1 sm:flex-none rounded-xl font-bold h-10 shadow-sm"
                      >
                        Accept
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => resolveItem(item.id, "discarded")}
                        disabled={resolveReview.isPending}
                        className="flex-1 sm:flex-none rounded-xl font-bold h-10"
                      >
                        Discard
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

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
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isBatchRunning}
                  className="rounded-xl font-bold px-6 shadow-sm"
                >
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
                    placeholder={"https://youtube.com/…\nhttps://…/clip.mp4"}
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
                        {item.status === "uploading" && (
                          <Loader2 className="w-4 h-4 text-accent animate-spin" />
                        )}
                        {item.status === "done" && <Check className="w-4 h-4 text-accent" />}
                        {item.status === "error" && <AlertCircle className="w-4 h-4 text-red-600" />}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* The one pre-process field */}
            <div className="mt-6">
              <label htmlFor="privacy-request" className="block font-bold text-sm mb-1">
                Anything you don't want processed?{" "}
                <span className="font-medium text-muted-foreground">(optional)</span>
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
                  <>Upload {queuedCount > 0 ? queuedCount : ""} video{queuedCount === 1 ? "" : "s"}</>
                )}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
