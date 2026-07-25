import { useEffect, useRef, useState } from "react";
import { Youtube, Image as ImageIcon, Loader2, X, Check, ExternalLink } from "lucide-react";
import {
  getSourcesStatus,
  createPhotosSession,
  getPhotosSession,
  listPhotosItems,
  useListYoutubeVideos,
  getListYoutubeVideosQueryKey,
} from "@workspace/api-client-react";
import { Button, Card } from "@/components/ui";

/**
 * "Add from Google Photos" + "Add from YouTube" for the batch upload dialog.
 *
 * Google Photos uses the Picker API — Google deprecated full library access
 * in 2025, so the user must hand-pick items in a Google Photos tab each time.
 * YouTube lists the user's own channel (public + unlisted) for multi-select.
 *
 * Both flows only ADD items to the caller's batch; they never upload
 * themselves, so all three sources combine into one batch.
 */

export type PhotosPick = { sessionId: string; itemId: string; filename: string };
export type YoutubePick = { videoId: string; title: string };

type Props = {
  disabled: boolean;
  onAddPhotos: (items: PhotosPick[]) => void;
  onAddYoutube: (items: YoutubePick[]) => void;
  /** Non-fatal messages (cancelled picker, failed connect, …). */
  onNote: (message: string) => void;
};

function apiPath(path: string): string {
  return `${import.meta.env.BASE_URL}api${path}`;
}

/** Opens the OAuth popup and resolves once it reports back or is closed. */
function connectService(
  service: "google_photos" | "youtube",
): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve) => {
    const popup = window.open(
      apiPath(`/oauth/google/start?service=${service}`),
      "recall-oauth",
      "width=540,height=680",
    );
    if (!popup) {
      resolve({ ok: false, message: "Your browser blocked the sign-in popup." });
      return;
    }
    let settled = false;
    const finish = (r: { ok: boolean; message?: string }) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(closedTimer);
      resolve(r);
    };
    const onMessage = (e: MessageEvent) => {
      // Only trust messages from our own popup on our own origin.
      if (e.origin !== window.location.origin || e.source !== popup) return;
      const d = e.data as { type?: string; ok?: boolean; message?: string };
      if (d && d.type === "recall-oauth") {
        finish({ ok: Boolean(d.ok), message: d.message });
      }
    };
    window.addEventListener("message", onMessage);
    const closedTimer = setInterval(() => {
      if (popup.closed) {
        // Give a just-arrived postMessage a beat before declaring cancel.
        setTimeout(() => finish({ ok: false, message: "Sign-in window was closed." }), 400);
      }
    }, 500);
  });
}

export function SourceButtons({ disabled, onAddPhotos, onAddYoutube, onNote }: Props) {
  const [photosState, setPhotosState] = useState<"idle" | "connecting" | "waiting">("idle");
  const [isYtOpen, setIsYtOpen] = useState(false);
  const [ytConnecting, setYtConnecting] = useState(false);
  const cancelPollRef = useRef(false);

  // ---- Google Photos flow -------------------------------------------------
  const startPhotos = async () => {
    setPhotosState("connecting");
    try {
      let status = await getSourcesStatus();
      if (!status.oauthConfigured) {
        onNote(
          "Google connections aren't configured yet — the GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET secrets are missing.",
        );
        setPhotosState("idle");
        return;
      }
      if (!status.googlePhotos) {
        const c = await connectService("google_photos");
        if (!c.ok) {
          onNote(c.message ?? "Google Photos connection failed.");
          setPhotosState("idle");
          return;
        }
      }
      const session = await createPhotosSession();
      const picker = window.open(session.pickerUri, "_blank");
      if (!picker) {
        onNote("Your browser blocked the Google Photos tab.");
        setPhotosState("idle");
        return;
      }
      setPhotosState("waiting");
      cancelPollRef.current = false;
      const interval = Math.min(Math.max(session.pollIntervalMs, 2000), 8000);
      const deadline = Date.now() + 5 * 60 * 1000;
      for (;;) {
        await new Promise((r) => setTimeout(r, interval));
        if (cancelPollRef.current) {
          onNote("Google Photos picking cancelled — nothing was added.");
          setPhotosState("idle");
          return;
        }
        if (Date.now() > deadline) {
          onNote("Google Photos picker timed out — nothing was added.");
          setPhotosState("idle");
          return;
        }
        const s = await getPhotosSession(session.sessionId);
        if (s.mediaItemsSet) break;
      }
      const items = await listPhotosItems({ sessionId: session.sessionId });
      if (items.length === 0) {
        onNote("No videos were picked (photos aren't supported) — nothing was added.");
      } else {
        onAddPhotos(
          items.map((i) => ({ sessionId: session.sessionId, itemId: i.id, filename: i.filename })),
        );
      }
      setPhotosState("idle");
    } catch (err) {
      onNote(err instanceof Error ? err.message : "Google Photos import failed.");
      setPhotosState("idle");
    }
  };

  // ---- YouTube flow -------------------------------------------------------
  const startYoutube = async () => {
    setYtConnecting(true);
    try {
      const status = await getSourcesStatus();
      if (!status.oauthConfigured) {
        onNote(
          "Google connections aren't configured yet — the GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET secrets are missing.",
        );
        return;
      }
      if (!status.youtube) {
        const c = await connectService("youtube");
        if (!c.ok) {
          onNote(c.message ?? "YouTube connection failed.");
          return;
        }
      }
      setIsYtOpen(true);
    } catch (err) {
      onNote(err instanceof Error ? err.message : "YouTube connection failed.");
    } finally {
      setYtConnecting(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button
          variant="outline"
          onClick={startPhotos}
          disabled={disabled || photosState !== "idle"}
          className="rounded-xl font-bold px-5"
          data-testid="add-google-photos"
        >
          {photosState === "idle" ? (
            <ImageIcon className="w-4 h-4 mr-2" />
          ) : (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          )}
          Google Photos
        </Button>
        <Button
          variant="outline"
          onClick={startYoutube}
          disabled={disabled || ytConnecting}
          className="rounded-xl font-bold px-5"
          data-testid="add-youtube"
        >
          {ytConnecting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Youtube className="w-4 h-4 mr-2" />
          )}
          YouTube
        </Button>
      </div>

      {photosState === "waiting" && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/40 px-4 py-3 text-sm font-medium">
          <span className="flex items-center gap-2 text-muted-foreground">
            <ExternalLink className="w-4 h-4" />
            Pick videos in the Google Photos tab, then hit "Done" there…
          </span>
          <button
            onClick={() => {
              cancelPollRef.current = true;
            }}
            className="font-bold text-red-600 hover:underline shrink-0"
            data-testid="cancel-photos-picker"
          >
            Cancel
          </button>
        </div>
      )}

      {isYtOpen && (
        <YoutubePickerDialog
          onClose={() => setIsYtOpen(false)}
          onAdd={(items) => {
            setIsYtOpen(false);
            onAddYoutube(items);
          }}
        />
      )}
    </>
  );
}

function YoutubePickerDialog({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (items: YoutubePick[]) => void;
}) {
  const { data: videos, isLoading, error } = useListYoutubeVideos({
    query: { queryKey: getListYoutubeVideosQueryKey() },
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => setSelected(new Set()), [videos]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="absolute inset-0" onClick={onClose} />
      <Card className="w-full max-w-lg p-6 relative z-10 rounded-[24px] shadow-2xl border-border max-h-[80dvh] flex flex-col">
        <button
          onClick={onClose}
          className="absolute top-5 right-5 text-muted-foreground hover:text-primary transition-colors"
          aria-label="Close YouTube picker"
        >
          <X className="w-5 h-5" />
        </button>
        <h3 className="text-xl font-extrabold mb-1">Your YouTube videos</h3>
        <p className="text-sm font-medium text-muted-foreground mb-4">
          Public and unlisted videos from your channel. Pick the ones to add to the batch.
        </p>
        <div className="flex-1 overflow-y-auto border border-border rounded-xl divide-y divide-border/60 min-h-24">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : error ? (
            <div className="p-4 text-sm font-medium text-red-600">
              Couldn't load your channel:{" "}
              {(error as { data?: { error?: string } })?.data?.error ?? "unknown error"}
            </div>
          ) : !videos || videos.length === 0 ? (
            <div className="p-6 text-sm font-medium text-muted-foreground text-center">
              No public or unlisted videos found on your channel.
            </div>
          ) : (
            videos.map((v) => (
              <button
                key={v.videoId}
                onClick={() => toggle(v.videoId)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-secondary/50 transition-colors"
                data-testid={`yt-video-${v.videoId}`}
              >
                <div
                  className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${selected.has(v.videoId) ? "bg-primary border-primary text-primary-foreground" : "border-border"}`}
                >
                  {selected.has(v.videoId) && <Check className="w-3.5 h-3.5" />}
                </div>
                {v.thumbnailUrl ? (
                  <img src={v.thumbnailUrl} className="w-16 aspect-video object-cover rounded-md shrink-0" alt="" />
                ) : (
                  <div className="w-16 aspect-video bg-secondary rounded-md shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate">{v.title}</p>
                  <p className="text-xs font-medium text-muted-foreground">
                    {v.privacyStatus}
                    {v.publishedAt ? ` · ${new Date(v.publishedAt).toLocaleDateString()}` : ""}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
        <div className="mt-4 flex justify-end gap-3">
          <Button variant="outline" onClick={onClose} className="rounded-xl font-bold">
            Cancel
          </Button>
          <Button
            disabled={selected.size === 0}
            onClick={() =>
              onAdd(
                (videos ?? [])
                  .filter((v) => selected.has(v.videoId))
                  .map((v) => ({ videoId: v.videoId, title: v.title })),
              )
            }
            className="rounded-xl font-bold px-6"
            data-testid="add-selected-youtube"
          >
            Add {selected.size || ""} to batch
          </Button>
        </div>
      </Card>
    </div>
  );
}
