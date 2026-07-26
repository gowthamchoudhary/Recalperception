import { useState } from "react";
import { AlertCircle, Check, Film } from "lucide-react";
import {
  useListReviewItems,
  useResolveReviewItem,
  useConfirmVideoLanguage,
  getListReviewItemsQueryKey,
  getListVideosQueryKey,
  getGetStatsQueryKey,
  type ReviewItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui";
import { languageDisplayName } from "@/lib/languages";

interface LanguageConfusionDetail {
  type: "language-confusion";
  detected: string;
  candidates: string[];
  message: string;
}

function parseLanguageConfusion(item: { reason: string; detail?: string | null }): LanguageConfusionDetail | null {
  if (!item.reason.startsWith("Language confusion:")) return null;
  try {
    const parsed = JSON.parse(item.detail ?? "{}") as Partial<LanguageConfusionDetail>;
    if (parsed.type !== "language-confusion" || !Array.isArray(parsed.candidates)) return null;
    return parsed as LanguageConfusionDetail;
  } catch {
    return null;
  }
}

function LanguageConfirmation({
  item,
  confusion,
  onResolved,
}: {
  item: ReviewItem;
  confusion: LanguageConfusionDetail;
  onResolved: () => void;
}) {
  const [code, setCode] = useState(confusion.detected);
  const confirm = useConfirmVideoLanguage();
  const resolve = useResolveReviewItem();
  const isBusy = confirm.isPending || resolve.isPending;

  return (
    <div className="flex flex-col gap-2 w-full sm:w-48">
      <select
        value={code}
        onChange={(e) => setCode(e.target.value)}
        disabled={isBusy}
        className="w-full rounded-xl border border-border bg-secondary px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary"
      >
        {confusion.candidates.map((c) => (
          <option key={c} value={c}>
            {languageDisplayName(c)}
          </option>
        ))}
      </select>
      <Button
        onClick={() => {
          confirm.mutate(
            { id: item.videoId, data: { languageCode: code } },
            {
              onSuccess: () => {
                resolve.mutate({ id: item.id, data: { status: "accepted" } }, { onSuccess: onResolved });
              },
            },
          );
        }}
        disabled={isBusy}
        className="w-full rounded-xl font-bold h-10 shadow-sm"
      >
        {confirm.isPending ? "Re-transcribing…" : resolve.isPending ? "Saving…" : "Confirm language"}
      </Button>
    </div>
  );
}

/** Flagged uploads & language checks — everything that wants a human eye. */
export default function ReviewPage() {
  const queryClient = useQueryClient();
  const {
    data: reviewItems = [],
    isLoading,
    refetch,
  } = useListReviewItems({
    query: { queryKey: getListReviewItemsQueryKey() },
  });
  const resolveReview = useResolveReviewItem();

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

  return (
    <AppShell>
      <div className="flex-1 max-w-[980px] w-full mx-auto px-5 md:px-10 py-10">
        <div className="mb-8">
          <div className="text-[11px] font-mono font-bold uppercase tracking-[0.18em] text-muted-foreground mb-2">Review queue</div>
          <h1 className="text-3xl font-extrabold tracking-tight">Needs review</h1>
          <p className="text-muted-foreground font-medium mt-1.5">
            Videos held back by your privacy requests, moderation flags, or language checks.
          </p>
        </div>

        <div className="bg-secondary/30 rounded-[24px] border border-border p-6 md:p-8 min-h-[360px]">
          {isLoading ? (
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
            <div className="space-y-4">
              {reviewItems.map((item) => {
                const confusion = parseLanguageConfusion(item);
                return (
                  <div
                    key={item.id}
                    className="bg-card rounded-2xl p-4 flex flex-col sm:flex-row gap-6 border border-border shadow-sm items-center"
                  >
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
                          confusion
                            ? "bg-purple-100 text-purple-800"
                            : item.reason.startsWith("Your request:")
                              ? "bg-blue-100 text-blue-800"
                              : "bg-orange-100 text-orange-800"
                        }`}
                      >
                        <AlertCircle className="w-3 h-3" />
                        {confusion ? "Language check" : item.reason.startsWith("Your request:") ? "Your request" : "Flagged"}
                      </div>
                      <h4 className="font-bold text-base mb-1">{item.videoTitle}</h4>
                      <p className="text-sm font-medium text-muted-foreground">{confusion ? confusion.message : item.reason}</p>
                      {item.detail && !confusion && (
                        <p className="text-xs font-medium text-muted-foreground/80 mt-1 line-clamp-2">{item.detail}</p>
                      )}
                    </div>
                    <div className="flex sm:flex-col gap-2 shrink-0 w-full sm:w-auto">
                      {confusion ? (
                        <LanguageConfirmation item={item} confusion={confusion} onResolved={() => void refetch()} />
                      ) : (
                        <>
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
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
