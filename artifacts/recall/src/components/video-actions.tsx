import { useState } from "react";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useDeleteVideo,
  getListVideosQueryKey,
  getSearchMemoriesQueryKey,
  getGetStatsQueryKey,
  getListReviewItemsQueryKey,
  getListPeopleQueryKey,
} from "@workspace/api-client-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, cn } from "@/components/ui";
import { EditVideoDialog, glassContent } from "./video-edit-dialog";

const BTN =
  "flex h-8 w-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const STYLES = {
  /** For thumbnails: dark glass circles matching the play affordance. */
  overlay: {
    edit: cn(BTN, "bg-black/50 text-white backdrop-blur-md hover:bg-black/70"),
    del: cn(BTN, "bg-black/50 text-white backdrop-blur-md hover:bg-red-600"),
  },
  /** For list rows on light background. */
  ghost: {
    edit: cn(BTN, "text-muted-foreground hover:bg-secondary hover:text-primary"),
    del: cn(BTN, "text-muted-foreground hover:bg-red-50 hover:text-red-600"),
  },
} as const;

/**
 * Edit + delete cluster for a video card. Self-contained: owns the edit
 * popup, the delete confirmation, and cache invalidation, so any surface
 * (library grid, search results, …) can mount it with just id + title.
 */
export function VideoActions({
  video,
  variant,
  className,
}: {
  video: { id: number; title: string };
  variant: keyof typeof STYLES;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const deleteVideo = useDeleteVideo();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const styles = STYLES[variant];

  const confirmDelete = () => {
    deleteVideo.mutate(
      { id: video.id },
      {
        onSuccess: () => {
          setIsConfirmOpen(false);
          void queryClient.invalidateQueries({ queryKey: getListVideosQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getSearchMemoriesQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getListReviewItemsQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() });
        },
      },
    );
  };

  /** Cards are clickable (play/open) — keep our clicks to ourselves. */
  const shield = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };

  return (
    <div className={cn("flex items-center gap-1.5", className)} onClick={shield}>
      <button
        type="button"
        title="Edit details"
        aria-label={`Edit ${video.title}`}
        data-testid={`edit-video-${video.id}`}
        className={styles.edit}
        onClick={(e) => {
          shield(e);
          setIsEditOpen(true);
        }}
      >
        <Pencil className="h-4 w-4" />
      </button>
      <button
        type="button"
        title="Delete video"
        aria-label={`Delete ${video.title}`}
        data-testid={`delete-video-${video.id}`}
        className={styles.del}
        onClick={(e) => {
          shield(e);
          setIsConfirmOpen(true);
        }}
      >
        <Trash2 className="h-4 w-4" />
      </button>

      <EditVideoDialog
        videoId={video.id}
        open={isEditOpen}
        onOpenChange={setIsEditOpen}
      />

      <AlertDialog
        open={isConfirmOpen}
        onOpenChange={(open) => {
          if (!deleteVideo.isPending) setIsConfirmOpen(open);
        }}
      >
        <AlertDialogContent
          className={cn(glassContent, "max-w-md")}
          onClick={(e) => e.stopPropagation()}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl font-extrabold">
              Delete “{video.title}”?
            </AlertDialogTitle>
            <AlertDialogDescription className="font-medium">
              This permanently removes the video, its transcript, scenes and any
              review items from your library and search results. This can't be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteVideo.isError && (
            <p className="text-sm font-medium text-red-600">
              Couldn't delete this video. Please try again.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              className="rounded-full font-bold"
              disabled={deleteVideo.isPending}
            >
              Keep video
            </AlertDialogCancel>
            <Button
              variant="destructive"
              data-testid="confirm-delete"
              className="rounded-full px-6 font-bold"
              onClick={confirmDelete}
              disabled={deleteVideo.isPending}
            >
              {deleteVideo.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Deleting…
                </>
              ) : (
                "Delete video"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
