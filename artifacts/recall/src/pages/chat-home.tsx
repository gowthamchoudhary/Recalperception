import { useLocation } from "wouter";
import { Link } from "wouter";
import { Clock, Film, Play, Tag, Upload, ArrowRight } from "lucide-react";
import {
  useCreateChat,
  useListVideos,
  useGetStats,
  getListVideosQueryKey,
  getGetStatsQueryKey,
  getListChatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { ChatInput, type ChatDraft } from "@/components/chat/chat-input";
import { useCurrentUser } from "@/lib/auth";
import { stashFirstMessage } from "@/lib/chat-stream";

const SUGGESTIONS = [
  "When did I last see the ocean?",
  "Find the moment the cake comes out",
  "What did we film last summer?",
  "Where was I stuck in traffic?",
];

function greetingFor(date: Date): string {
  const h = date.getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * The authed home: a chat-first "ask your memories" surface. Sending the
 * first message creates a chat and hands the draft to the thread page,
 * which streams real pipeline progress.
 */
export default function ChatHome() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  const createChat = useCreateChat();

  const { data: videos = [], isLoading: isLoadingVideos } = useListVideos(undefined, {
    query: { queryKey: getListVideosQueryKey() },
  });
  const { data: stats } = useGetStats({ query: { queryKey: getGetStatsQueryKey() } });

  const firstName = user?.name?.trim().split(/\s+/)[0] ?? "";
  const recent = videos.slice(0, 6);
  const hasLibrary = videos.length > 0;

  const startChat = (draft: ChatDraft) => {
    if (createChat.isPending) return;
    createChat.mutate(
      { data: {} },
      {
        onSuccess: (chat) => {
          stashFirstMessage(chat.id, {
            content: draft.content,
            ...(draft.personIds.length > 0 ? { personIds: draft.personIds } : {}),
            ...(draft.voice ? { voice: true } : {}),
          });
          void queryClient.invalidateQueries({ queryKey: getListChatsQueryKey() });
          navigate(`/chat/${chat.id}`);
        },
      },
    );
  };

  return (
    <AppShell>
      <div className="flex-1 flex flex-col">
        {/* Centered ask surface */}
        <div className="flex-1 flex flex-col items-center justify-center px-5 md:px-10 py-12">
          <div className="w-full max-w-[720px]">
            <div className="text-center mb-8">
              <div className="text-[11px] font-mono font-bold uppercase tracking-[0.18em] text-muted-foreground mb-3">
                Your second brain
              </div>
              <h1 className="text-[clamp(1.8rem,4vw,2.6rem)] font-extrabold tracking-tight leading-tight">
                {greetingFor(new Date())}
                {firstName ? `, ${firstName}` : ""}.
              </h1>
              <p className="text-muted-foreground font-medium mt-2 text-[15px]">
                Ask anything you've ever filmed — I'll find the moment.
              </p>
            </div>

            <ChatInput variant="hero" autoFocus onSend={startChat} disabled={createChat.isPending} />

            {/* Suggestions */}
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => startChat({ content: s, personIds: [], personNames: [], voice: false })}
                  disabled={createChat.isPending}
                  className="px-3.5 py-2 rounded-full bg-card border border-border text-[13px] font-semibold text-muted-foreground hover:text-primary hover:border-primary/40 hover:shadow-sm transition-all disabled:opacity-50"
                  data-testid="suggestion-chip"
                >
                  {s}
                </button>
              ))}
            </div>

            {createChat.isError && (
              <p className="mt-4 text-center text-sm font-semibold text-red-600">
                Couldn't start the chat — try again.
              </p>
            )}
          </div>
        </div>

        {/* Bottom strip: real library context */}
        <div className="px-5 md:px-10 pb-8">
          <div className="max-w-[980px] mx-auto">
            {isLoadingVideos ? (
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="aspect-video bg-secondary rounded-xl animate-pulse" />
                ))}
              </div>
            ) : hasLibrary ? (
              <>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground">
                    Fresh in your library
                  </span>
                  <Link
                    href="/library"
                    className="text-[12.5px] font-bold text-accent hover:underline flex items-center gap-1"
                    data-testid="see-library"
                  >
                    All memories <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                  {recent.map((video) => (
                    <Link key={video.id} href="/library" className="group block" data-testid={`recent-video-${video.id}`}>
                      <div className="aspect-video bg-secondary rounded-xl overflow-hidden relative border border-border shadow-sm group-hover:shadow-md group-hover:-translate-y-0.5 transition-all">
                        {video.thumbnailUrl ? (
                          <img src={video.thumbnailUrl} alt={video.title} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Film className="w-5 h-5 text-muted-foreground/50" />
                          </div>
                        )}
                        {video.status === "processing" && (
                          <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider bg-amber-500/90 text-white">
                            Indexing
                          </div>
                        )}
                      </div>
                      <p className="mt-1.5 text-[11.5px] font-bold truncate text-muted-foreground group-hover:text-primary transition-colors">
                        {video.title}
                      </p>
                    </Link>
                  ))}
                </div>
                {stats && (
                  <div className="mt-5 flex items-center justify-center gap-6 text-[12px] font-mono font-bold text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <Play className="w-3.5 h-3.5" /> {stats.totalVideos} videos
                    </span>
                    <span className="w-1 h-1 rounded-full bg-border" />
                    <span className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5" /> {Math.round(stats.totalHoursIndexed)}h indexed
                    </span>
                    <span className="w-1 h-1 rounded-full bg-border" />
                    <span className="flex items-center gap-1.5">
                      <Tag className="w-3.5 h-3.5" /> {stats.totalScenes} scenes
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="max-w-[520px] mx-auto text-center bg-card border border-border rounded-[20px] p-6 shadow-sm">
                <h3 className="font-extrabold text-lg mb-1">Nothing to search yet</h3>
                <p className="text-sm font-medium text-muted-foreground mb-4">
                  Upload your first videos and Recall will index every word and scene so you can ask about them here.
                </p>
                <Link
                  href="/library"
                  className="inline-flex items-center gap-2 rounded-full px-6 h-11 bg-primary text-primary-foreground text-sm font-bold shadow-md hover:opacity-90 transition-opacity"
                  data-testid="go-upload"
                >
                  <Upload className="w-4 h-4" /> Upload memories
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
