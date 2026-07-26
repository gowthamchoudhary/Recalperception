import { useState, useEffect, useRef, useCallback } from "react";
import Hls from "hls.js";
import {
  Search as SearchIcon,
  Play,
  Calendar,
  Users,
  X,
  Quote,
  Scissors,
  Download,
  Loader2,
  Sparkles,
} from "lucide-react";
import {
  useGetVideo,
  useExportClip,
  useFindInVideo,
  getGetVideoQueryKey,
  getFindInVideoQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui";

/**
 * Structural shape shared by search results, chat result cards and
 * library entries — everything the player needs to show one moment.
 */
export interface PlayerResult {
  videoId: number;
  videoTitle: string;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  snippet: string;
  matchType: string;
  matchReason?: string | null;
  timestampSeconds: number;
  durationSeconds: number;
  people?: string[];
  recordedAt?: string | null;
  location?: string | null;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

/**
 * Real HLS playback for VideoDB streams. Seeks straight to the matched
 * moment once the stream is ready. Safari plays HLS natively; other
 * browsers go through hls.js. `onReady` hands the element up so the
 * overlay can drive later seeks (AI moment lookup).
 */
export function VideoPlayer({
  src,
  startAt,
  poster,
  onReady,
}: {
  src: string;
  startAt: number;
  poster?: string;
  onReady?: (el: HTMLVideoElement) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let hls: Hls | null = null;
    const seekToMatch = () => {
      video.currentTime = startAt;
      void video.play().catch(() => {
        // Autoplay blocked — the user can press play; we stay seeked.
      });
      onReady?.(video);
    };
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.addEventListener("loadedmetadata", seekToMatch, { once: true });
    } else if (Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, seekToMatch);
    } else {
      video.src = src;
      video.addEventListener("loadedmetadata", seekToMatch, { once: true });
    }
    return () => {
      video.removeEventListener("loadedmetadata", seekToMatch);
      if (hls) hls.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, startAt]);

  return (
    <video
      ref={videoRef}
      controls
      playsInline
      poster={poster}
      className="absolute inset-0 w-full h-full"
      data-testid="video-player"
    />
  );
}

const SHORT_VIDEO_SECONDS = 30;

/**
 * Timeline trim + export. Longer videos get a scrubber spanning the full
 * video with the matched segment highlighted and two draggable in/out
 * handles; short videos (< 30s) skip the scrubber and export the whole clip
 * with one click. Clips are rendered on demand via the export API.
 */
export function ClipExporter({
  videoId,
  duration,
  matchStart,
  className,
}: {
  videoId: number;
  duration: number;
  matchStart: number;
  className?: string;
}) {
  const isShort = duration > 0 && duration < SHORT_VIDEO_SECONDS;
  // Default selection: a window around the matched moment.
  const defaultIn = isShort ? 0 : Math.max(0, Math.min(matchStart, Math.max(0, duration - 10)));
  const defaultOut = isShort ? duration : Math.min(duration, defaultIn + 15);
  const [inPoint, setInPoint] = useState(defaultIn);
  const [outPoint, setOutPoint] = useState(defaultOut);
  const [download, setDownload] = useState<{ url: string; name: string } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<"in" | "out" | null>(null);
  const exportClip = useExportClip();

  const matchPercent = duration > 0 ? (matchStart / duration) * 100 : 0;
  const inPercent = duration > 0 ? (inPoint / duration) * 100 : 0;
  const outPercent = duration > 0 ? (outPoint / duration) * 100 : 0;

  const secondsAtPointer = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || duration <= 0) return 0;
      const rect = track.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return frac * duration;
    },
    [duration],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const which = draggingRef.current;
      if (!which) return;
      const t = secondsAtPointer(e.clientX);
      // Any retiming invalidates a previously rendered clip.
      setDownload(null);
      if (which === "in") setInPoint(Math.min(t, outPoint - 1));
      else setOutPoint(Math.max(t, inPoint + 1));
    };
    const onUp = () => {
      draggingRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [secondsAtPointer, inPoint, outPoint]);

  const startExport = () => {
    setDownload(null);
    exportClip.mutate(
      {
        id: videoId,
        data: {
          startSeconds: isShort ? 0 : inPoint,
          endSeconds: isShort ? duration : outPoint,
        },
      },
      {
        onSuccess: (data) => setDownload({ url: data.downloadUrl, name: data.name }),
      },
    );
  };

  return (
    <div className={className ?? "px-8 md:px-12 py-6 border-b border-border/50 bg-secondary/20"}>
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
          <Scissors className="w-3.5 h-3.5" /> {isShort ? "Export clip" : "Trim & export clip"}
        </h4>
        {!isShort && (
          <span className="text-xs font-mono font-bold text-muted-foreground">
            {formatClock(inPoint)} – {formatClock(outPoint)} · {formatClock(outPoint - inPoint)} selected
          </span>
        )}
      </div>

      {!isShort && (
        <div className="mb-5 pt-2 pb-1">
          <div ref={trackRef} className="relative h-2 bg-border rounded-full select-none" data-testid="clip-trim-track">
            {/* Matched segment highlight */}
            <div
              className="absolute top-0 h-full bg-accent/40 rounded-full"
              style={{ left: `${Math.max(0, matchPercent - 2)}%`, width: "4%" }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 h-4 w-1 bg-accent rounded-full"
              style={{ left: `${matchPercent}%` }}
              title={`Matched moment @ ${formatClock(matchStart)}`}
            />
            {/* Selected range */}
            <div
              className="absolute top-0 h-full bg-primary/70 rounded-full"
              style={{ left: `${inPercent}%`, width: `${Math.max(0, outPercent - inPercent)}%` }}
            />
            {/* Handles */}
            <button
              type="button"
              aria-label="Clip start"
              data-testid="clip-handle-in"
              onPointerDown={(e) => {
                e.preventDefault();
                draggingRef.current = "in";
              }}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-card border-2 border-primary shadow-md cursor-ew-resize touch-none"
              style={{ left: `${inPercent}%` }}
            />
            <button
              type="button"
              aria-label="Clip end"
              data-testid="clip-handle-out"
              onPointerDown={(e) => {
                e.preventDefault();
                draggingRef.current = "out";
              }}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-card border-2 border-primary shadow-md cursor-ew-resize touch-none"
              style={{ left: `${outPercent}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] font-mono font-bold text-muted-foreground mt-2">
            <span>0:00</span>
            <span>{formatClock(duration)}</span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <Button
          onClick={startExport}
          disabled={exportClip.isPending}
          className="rounded-full font-bold px-6 shadow-sm"
          data-testid="export-clip-button"
        >
          {exportClip.isPending ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Rendering clip…
            </>
          ) : (
            <>
              <Scissors className="w-4 h-4 mr-2" /> {isShort ? "Export whole clip" : "Export clip"}
            </>
          )}
        </Button>
        {exportClip.isPending && (
          <span className="text-sm font-medium text-muted-foreground">
            Cutting {isShort ? "the whole video" : `${formatClock(outPoint - inPoint)}`} — this can take a minute for longer clips.
          </span>
        )}
        {exportClip.isError && (
          <span className="text-sm font-semibold text-red-600">
            {(exportClip.error as { message?: string })?.message || "Export failed. Try again."}
          </span>
        )}
        {download && !exportClip.isPending && (
          <a
            href={download.url}
            download={download.name}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full px-6 h-10 bg-accent text-accent-foreground text-sm font-bold shadow-sm hover:opacity-90 transition-opacity"
            data-testid="download-clip-link"
          >
            <Download className="w-4 h-4" /> Download clip
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * In-player AI lookup: ask for a moment inside THIS video; a hit jumps the
 * playhead straight there. Misses are a normal answer, not an error.
 */
function MomentLookup({
  videoId,
  canSeek,
  onSeek,
}: {
  videoId: number;
  canSeek: boolean;
  onSeek: (seconds: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { data, isFetching, isError } = useFindInVideo(
    videoId,
    { q: submitted },
    {
      query: {
        enabled: !!submitted,
        queryKey: getFindInVideoQueryKey(videoId, { q: submitted }),
        staleTime: 5 * 60 * 1000,
      },
    },
  );

  // Jump as soon as a fresh hit lands.
  const lastJump = useRef<string>("");
  useEffect(() => {
    if (!data?.found || typeof data.timestampSeconds !== "number") return;
    const sig = `${submitted}:${data.timestampSeconds}`;
    if (lastJump.current === sig) return;
    lastJump.current = sig;
    onSeek(data.timestampSeconds);
  }, [data, submitted, onSeek]);

  return (
    <div className="px-8 md:px-12 py-5 border-b border-border/50">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) setSubmitted(draft.trim());
        }}
        className="flex items-center gap-3"
      >
        <div className="relative flex-1">
          <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
            <Sparkles className={`w-4 h-4 ${isFetching ? "text-accent animate-pulse" : "text-muted-foreground"}`} />
          </div>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Find a moment in this video — “when the cake comes out”…"
            className="w-full h-11 pl-11 pr-4 rounded-full bg-secondary/50 border border-border text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-all placeholder:text-muted-foreground/60"
            data-testid="moment-lookup-input"
          />
        </div>
        <Button
          type="submit"
          disabled={!draft.trim() || isFetching}
          className="rounded-full font-bold px-5 h-11"
          data-testid="moment-lookup-submit"
        >
          {isFetching ? <Loader2 className="w-4 h-4 animate-spin" /> : "Jump to it"}
        </Button>
      </form>
      {submitted && !isFetching && (
        <p className="mt-2.5 text-sm font-medium pl-2" data-testid="moment-lookup-result">
          {isError ? (
            <span className="text-red-600">Couldn't look that up — try again.</span>
          ) : data?.found ? (
            <span className="text-accent font-semibold">
              Found it at {formatClock(data.timestampSeconds ?? 0)}
              {!canSeek && " (open the stream to jump)"} — “{(data.snippet ?? "").slice(0, 120)}
              {(data.snippet ?? "").length > 120 ? "…" : ""}”
            </span>
          ) : data ? (
            <span className="text-muted-foreground">
              Nothing like that in this video — it might be in another memory.
            </span>
          ) : null}
        </p>
      )}
    </div>
  );
}

export function PlayerOverlay({ result, onClose }: { result: PlayerResult; onClose: () => void }) {
  const { data: videoDetail } = useGetVideo(result.videoId, {
    query: { enabled: !!result.videoId, queryKey: getGetVideoQueryKey(result.videoId) },
  });
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  /** Seek requested before the HLS player finished attaching. */
  const pendingSeekRef = useRef<number | null>(null);

  // Calculate position of the match on the timeline
  const matchPercent = result.durationSeconds > 0 ? (result.timestampSeconds / result.durationSeconds) * 100 : 0;

  const seekTo = useCallback((seconds: number) => {
    const el = videoElRef.current;
    if (!el) {
      pendingSeekRef.current = seconds;
      return;
    }
    el.currentTime = seconds;
    void el.play().catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-10 animate-in fade-in duration-200">
      <div className="absolute inset-0 bg-background/90 backdrop-blur-xl" onClick={onClose} />

      <div className="w-full max-w-[1200px] bg-card border border-border shadow-2xl rounded-[32px] overflow-hidden flex flex-col relative z-10 max-h-full">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
          <h3 className="font-bold text-lg truncate pr-4">{result.videoTitle}</h3>
          <button
            onClick={onClose}
            className="p-2 bg-secondary rounded-full hover:bg-secondary/80 transition-colors"
            aria-label="Close player"
            data-testid="close-player"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Player: real HLS stream when available, facade for seeded demos */}
          <div className="w-full bg-black aspect-video relative group">
            {result.videoUrl ? (
              <VideoPlayer
                src={result.videoUrl}
                startAt={result.timestampSeconds}
                poster={result.thumbnailUrl || undefined}
                onReady={(el) => {
                  videoElRef.current = el;
                  if (pendingSeekRef.current !== null) {
                    const t = pendingSeekRef.current;
                    pendingSeekRef.current = null;
                    el.currentTime = t;
                    void el.play().catch(() => {});
                  }
                }}
              />
            ) : (
              <>
                <div className="absolute inset-0 bg-black">
                  {result.thumbnailUrl && (
                    <img src={result.thumbnailUrl} className="w-full h-full object-cover opacity-80" alt="Video" />
                  )}
                </div>
                <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                  <div className="w-20 h-20 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center cursor-pointer hover:bg-white/30 hover:scale-105 transition-all">
                    <Play className="w-8 h-8 text-white fill-white ml-1" />
                  </div>
                </div>

                {/* Player Controls overlay */}
                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent pt-12 pb-6 px-8 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                  <div className="flex items-center justify-between text-white font-mono text-xs font-bold mb-3">
                    <span>{formatClock(result.timestampSeconds)}</span>
                    <span>{formatClock(result.durationSeconds)}</span>
                  </div>

                  {/* Timeline Scrubber */}
                  <div className="w-full h-2 bg-white/30 rounded-full relative cursor-pointer group/scrubber">
                    {/* Progress fill */}
                    <div className="absolute top-0 left-0 h-full bg-white rounded-l-full" style={{ width: `${matchPercent}%` }} />

                    {/* Highlighted match segment */}
                    <div
                      className="absolute top-1/2 -translate-y-1/2 h-4 w-1 bg-accent rounded-full shadow-[0_0_8px_rgba(28,138,62,1)]"
                      style={{ left: `${matchPercent}%` }}
                    />
                    <div
                      className="absolute top-1/2 -translate-y-1/2 h-1 bg-accent/40 rounded-full"
                      style={{ left: `${Math.max(0, matchPercent - 2)}%`, width: "4%" }}
                    />
                  </div>
                </div>
              </>
            )}
          </div>

          {/* AI moment lookup inside this video */}
          <MomentLookup videoId={result.videoId} canSeek={!!result.videoUrl} onSeek={seekTo} />

          {/* Trim & export */}
          {result.videoUrl && result.durationSeconds > 0 && (
            <ClipExporter videoId={result.videoId} duration={result.durationSeconds} matchStart={result.timestampSeconds} />
          )}

          {/* Metadata Section */}
          <div className="p-8 md:p-12">
            <div className="flex items-center gap-2 mb-6">
              <span
                className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${
                  result.matchType === "title" ? "bg-amber-100 text-amber-900 border border-amber-300" : "bg-accent text-accent-foreground"
                }`}
              >
                <SearchIcon className="w-3 h-3" /> {result.matchType === "title" ? "Matched by title only" : "Exact match found"}
              </span>
              {result.matchType !== "title" && (
                <span className="text-sm font-mono font-bold text-muted-foreground px-3 py-1 bg-secondary rounded-full">
                  @ {formatClock(result.timestampSeconds)}
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
              <div className="md:col-span-2 space-y-6">
                <div>
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-2">
                    <Quote className="w-3.5 h-3.5" /> {result.matchType === "title" ? "Match note" : "Transcript excerpt"}
                  </h4>
                  <div className="text-lg font-serif italic text-primary/90 leading-relaxed p-6 bg-secondary/30 rounded-[20px] border border-border">
                    {result.matchType === "title"
                      ? "This video's title matched your search — no specific moment was pinpointed, so playback starts at the beginning."
                      : `"… ${result.snippet} …"`}
                  </div>
                </div>

                {videoDetail?.tags && videoDetail.tags.length > 0 && (
                  <div>
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3">Topics</h4>
                    <div className="flex flex-wrap gap-2">
                      {videoDetail.tags.map((tag: string) => (
                        <span key={tag} className="px-3 py-1.5 bg-card border border-border rounded-lg text-sm font-semibold shadow-sm">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-8">
                <div>
                  <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-2">
                    <Calendar className="w-3.5 h-3.5" /> Date & Location
                  </h4>
                  <div className="space-y-2 text-sm font-medium">
                    <div className="flex items-center justify-between py-2 border-b border-border/50">
                      <span className="text-muted-foreground">Recorded</span>
                      <span className="font-bold">{result.recordedAt ? new Date(result.recordedAt).toLocaleDateString() : "Unknown"}</span>
                    </div>
                    <div className="flex items-center justify-between py-2 border-b border-border/50">
                      <span className="text-muted-foreground">Location</span>
                      <span className="font-bold">{result.location || "Unknown"}</span>
                    </div>
                  </div>
                </div>

                {result.people && result.people.length > 0 ? (
                  <div>
                    <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-2">
                      <Users className="w-3.5 h-3.5" /> People in scene
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {result.people.map((person: string) => (
                        <span
                          key={person}
                          className="px-3 py-1.5 bg-card border border-border rounded-lg text-sm font-semibold flex items-center gap-2 shadow-sm"
                        >
                          <div className="w-4 h-4 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-[8px]">
                            {person[0]}
                          </div>
                          {person}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
