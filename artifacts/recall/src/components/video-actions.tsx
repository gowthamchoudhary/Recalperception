import { useState } from "react";
import { Loader2, MoreHorizontal, Pencil, Scissors, Trash2 } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button, cn } from "@/components/ui";
import { EditVideoDialog, glassContent } from "./video-edit-dialog";
import { ClipExporter } from "./player-overlay";

const TRIGGER_BTN =
  "flex h-8 w-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const TRIGGER_STYLES = {
  /** For thumbnails: dark glass circle matching the play affordance. */
  overlay: cn(TRIGGER_BTN, "bg-black/50 text-white backdrop-blur-md hover:bg-black/70"),
  /** For list rows on light background. */
  ghost: cn(TRIGGER_BTN, "text-muted-foreground hover:bg-secondary hover:text-primary"),
} as const;

/**
 * Per-video "⋯" menu. Self-contained: owns the edit popup, the clip export
 * dialog, the delete confirmation, and cache invalidation, so any surface
 * (library grid, chat results, …) can mount it with just the video summary.
 */
export function VideoActions({
  video,
  variant,
  className,
}: {
  video: { id: number; title: string; durationSeconds?: number };
  variant: keyof typeof TRIGGER_STYLES;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const deleteVideo = useDeleteVideo();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const canExport = typeof video.durationSeconds === "number" && video.durationSeconds > 0;

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
    <div className={cn("flex items-center", className)} onClick={shield}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="Video options"
            aria-label={`Options for ${video.title}`}
            data-testid={`video-menu-${video.id}`}
            className={TRIGGER_STYLES[variant]}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48 rounded-xl" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem
            className="font-semibold"
            data-testid={`edit-video-${video.id}`}
            onClick={() => setIsEditOpen(true)}
          >
            <Pencil className="h-4 w-4 mr-2" /> Details &amp; edit
          </DropdownMenuItem>
          {canExport && (
            <DropdownMenuItem
              className="font-semibold"
              data-testid={`export-video-${video.id}`}
              onClick={() => setIsExportOpen(true)}
            >
              <Scissors className="h-4 w-4 mr-2" /> Export clip
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="font-semibold text-red-600 focus:text-red-600"
            data-testid={`delete-video-${video.id}`}
            onClick={() => setIsConfirmOpen(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <EditVideoDialog videoId={video.id} open={isEditOpen} onOpenChange={setIsEditOpen} />

      {/* Clip export straight from the card — no matched moment, so the
          selection starts at the beginning of the video. */}
      <Dialog open={isExportOpen} onOpenChange={setIsExportOpen}>
        <DialogContent className={cn(glassContent, "max-w-xl")} onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle className="text-xl font-extrabold truncate pr-8">Export a clip — {video.title}</DialogTitle>
          </DialogHeader>
          {canExport && (
            <ClipExporter videoId={video.id} duration={video.durationSeconds!} matchStart={0} className="pt-1" />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={isConfirmOpen}
        onOpenChange={(open) => {
          if (!deleteVideo.isPending) setIsConfirmOpen(open);
        }}
      >
        <AlertDialogContent className={cn(glassContent, "max-w-md")} onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl font-extrabold">Delete “{video.title}”?</AlertDialogTitle>
            <AlertDialogDescription className="font-medium">
              This permanently removes the video, its transcript, scenes and any review items from your library and search
              results. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteVideo.isError && (
            <p className="text-sm font-medium text-red-600">Couldn't delete this video. Please try again.</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full font-bold" disabled={deleteVideo.isPending}>
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
