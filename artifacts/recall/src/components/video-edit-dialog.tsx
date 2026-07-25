import { useEffect, useState } from "react";
import { AlertCircle, Clock, Film, Loader2, MicOff, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetVideo,
  useUpdateVideo,
  getGetVideoQueryKey,
  getListVideosQueryKey,
  getSearchMemoriesQueryKey,
  getGetStatsQueryKey,
  getListPeopleQueryKey,
  getListReviewItemsQueryKey,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button, Input, cn } from "@/components/ui";

/** Shared glass treatment for popups — translucent card + heavy blur. */
export const glassContent =
  "rounded-[28px] sm:rounded-[28px] border border-white/60 bg-card/80 backdrop-blur-2xl shadow-[0_24px_80px_-24px_rgba(0,0,0,0.35)] ring-1 ring-black/5";
export const glassOverlay = "bg-black/30 backdrop-blur-md";

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  indexed: { label: "Indexed", cls: "bg-emerald-100 text-emerald-800" },
  processing: { label: "Indexing", cls: "bg-amber-100 text-amber-800" },
  flagged: { label: "Needs review", cls: "bg-orange-100 text-orange-800" },
  failed: { label: "Failed", cls: "bg-red-100 text-red-800" },
};

function ChipsField({
  label,
  values,
  onChange,
  placeholder,
  testId,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  testId: string;
}) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const parts = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      setDraft("");
      return;
    }
    const next = [...values];
    for (const part of parts) {
      const dupe = next.some(
        (v) => v.trim().toLowerCase() === part.toLowerCase(),
      );
      if (!dupe) next.push(part);
    }
    onChange(next);
    setDraft("");
  };

  return (
    <div>
      <label className="mb-1.5 block text-sm font-bold">{label}</label>
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-[22px] border border-input bg-background/70 px-3 py-2 transition-all focus-within:ring-2 focus-within:ring-accent">
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1 text-xs font-bold text-secondary-foreground"
          >
            {value}
            <button
              type="button"
              aria-label={`Remove ${value}`}
              className="text-muted-foreground transition-colors hover:text-red-600"
              onClick={() => onChange(values.filter((v) => v !== value))}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          data-testid={testId}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !draft && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          placeholder={values.length === 0 ? placeholder : "Add more…"}
          className="h-7 min-w-[120px] flex-1 border-0 bg-transparent text-sm font-medium placeholder:text-muted-foreground/60 focus:outline-none"
        />
      </div>
    </div>
  );
}

/**
 * Glassmorphism popup for enriching a video: shows what Recall extracted
 * (transcript excerpt, scenes, duration, status) and lets the user rename
 * the file and tag people, a place, and free-form tags.
 */
export function EditVideoDialog({
  videoId,
  open,
  onOpenChange,
}: {
  videoId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const {
    data: detail,
    isLoading,
    error: loadError,
  } = useGetVideo(videoId, {
    query: { queryKey: getGetVideoQueryKey(videoId), enabled: open },
  });
  const updateVideo = useUpdateVideo();

  const [title, setTitle] = useState("");
  const [place, setPlace] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (!open) {
      setSeeded(false);
      updateVideo.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && !seeded && detail) {
      setTitle(detail.title);
      setPlace(detail.location ?? "");
      setPeople(detail.people ?? []);
      setTags(detail.tags ?? []);
      setSeeded(true);
    }
  }, [open, seeded, detail]);

  const save = () => {
    updateVideo.mutate(
      {
        id: videoId,
        data: {
          title: title.trim(),
          location: place.trim(),
          people,
          tags,
        },
      },
      {
        onSuccess: (updated) => {
          // Merge the PATCH response into the detail cache so an instant
          // reopen never shows pre-save values while the refetch is in flight.
          queryClient.setQueryData(
            getGetVideoQueryKey(videoId),
            (old: object | undefined) => (old ? { ...old, ...updated } : old),
          );
          void queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getGetVideoQueryKey(videoId) });
          void queryClient.invalidateQueries({ queryKey: getSearchMemoriesQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getListReviewItemsQueryKey() });
          onOpenChange(false);
        },
      },
    );
  };

  const pill = detail ? STATUS_PILL[detail.status] : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(glassContent, "max-w-xl")}
        overlayClassName={glassOverlay}
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-extrabold">Edit video</DialogTitle>
          <DialogDescription className="font-medium">
            Rename this memory and add the details Recall can't guess.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3 py-2" aria-busy="true">
            <div className="h-20 animate-pulse rounded-2xl bg-secondary/70" />
            <div className="h-11 animate-pulse rounded-full bg-secondary/70" />
            <div className="h-11 animate-pulse rounded-full bg-secondary/70" />
          </div>
        ) : loadError || !detail ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Couldn't load this video — it may have been deleted.</span>
          </div>
        ) : (
          <>
            {/* What Recall extracted */}
            <div className="rounded-2xl border border-border/60 bg-secondary/40 p-4">
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                What Recall extracted
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs font-semibold text-muted-foreground">
                {pill && (
                  <span className={cn("rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", pill.cls)}>
                    {pill.label}
                  </span>
                )}
                {detail.durationSeconds > 0 && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> {formatDuration(detail.durationSeconds)}
                  </span>
                )}
                {typeof detail.sceneCount === "number" && detail.sceneCount > 0 && (
                  <span className="flex items-center gap-1">
                    <Film className="h-3.5 w-3.5" /> {detail.sceneCount} scene
                    {detail.sceneCount === 1 ? "" : "s"} analyzed
                  </span>
                )}
              </div>
              {detail.transcriptExcerpt?.trim() ? (
                <blockquote className="mt-3 max-h-28 overflow-y-auto border-l-2 border-accent/40 pl-3 font-serif text-sm italic text-muted-foreground/90">
                  “{detail.transcriptExcerpt.trim()}”
                </blockquote>
              ) : (
                <p className="mt-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <MicOff className="h-4 w-4 shrink-0" />
                  No speech detected — this video is indexed by its visuals only.
                </p>
              )}
              {detail.status === "failed" && detail.indexError && (
                <p className="mt-3 flex items-start gap-2 text-sm font-medium text-red-600">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  {detail.indexError}
                </p>
              )}
            </div>

            {/* Editable fields */}
            <div className="space-y-4">
              <div>
                <label htmlFor="edit-video-title" className="mb-1.5 block text-sm font-bold">
                  File name
                </label>
                <Input
                  id="edit-video-title"
                  data-testid="edit-title-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Rename this video…"
                  className="font-medium"
                />
              </div>
              <div>
                <label htmlFor="edit-video-place" className="mb-1.5 block text-sm font-bold">
                  Place
                </label>
                <Input
                  id="edit-video-place"
                  data-testid="edit-place-input"
                  value={place}
                  onChange={(e) => setPlace(e.target.value)}
                  placeholder="Add a place…"
                  className="font-medium"
                />
              </div>
              <ChipsField
                label="People"
                values={people}
                onChange={setPeople}
                placeholder="Add people… (press Enter)"
                testId="edit-people-input"
              />
              <ChipsField
                label="Tags"
                values={tags}
                onChange={setTags}
                placeholder="Add tags… (press Enter)"
                testId="edit-tags-input"
              />
            </div>

            {updateVideo.isError && (
              <p className="flex items-start gap-2 text-sm font-medium text-red-600">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                Couldn't save your changes. Please try again.
              </p>
            )}

            <div className="flex items-center justify-end gap-3">
              <Button
                variant="outline"
                className="rounded-full font-bold"
                onClick={() => onOpenChange(false)}
                disabled={updateVideo.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={save}
                data-testid="save-video"
                disabled={!title.trim() || updateVideo.isPending}
                className="rounded-full px-8 font-bold shadow-sm"
              >
                {updateVideo.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
                  </>
                ) : (
                  "Save changes"
                )}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
