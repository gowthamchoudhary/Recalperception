import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import {
  Check,
  Loader2,
  Mic,
  Play,
  RotateCcw,
  Search as SearchIcon,
  Sparkles,
  UserCheck,
  Users,
  Volume2,
  AlertTriangle,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetChat,
  getGetChatQueryKey,
  getListChatsQueryKey,
  type ChatDetail,
  type ChatMessage,
  type ChatMessageInput,
  type SearchResult,
} from "@workspace/api-client-react";
import { AppShell } from "@/components/layout/AppShell";
import { ChatInput, type ChatDraft } from "@/components/chat/chat-input";
import { PlayerOverlay, formatClock, type PlayerResult } from "@/components/player-overlay";
import {
  sendChatMessageStreaming,
  takeFirstMessage,
  fetchSpeech,
  STAGE_LABELS,
  type ChatStage,
} from "@/lib/chat-stream";

/** Ordered list for the staged loader — stages the pipeline actually emits. */
const STAGE_ORDER: ChatStage[] = [
  "contextualizing",
  "classifying",
  "retrieving",
  "person_check",
  "reranking",
  "answering",
];

function StagedLoader({ seen }: { seen: ChatStage[] }) {
  const current = seen[seen.length - 1];
  return (
    <div
      className="rounded-[20px] px-5 py-4 inline-block min-w-[260px]"
      style={{
        background: "linear-gradient(180deg, #1b1b16, #0d0d0a)",
        border: "1px solid #33332a",
      }}
      data-testid="staged-loader"
    >
      <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#6f6f66] mb-2.5 flex items-center gap-1.5">
        <Sparkles className="w-3 h-3 text-accent" /> Searching your memories
      </div>
      <ul className="space-y-1.5">
        {seen.length === 0 && (
          <li className="flex items-center gap-2.5 text-[13px] font-semibold text-white">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" /> Thinking…
          </li>
        )}
        {STAGE_ORDER.filter((s) => seen.includes(s)).map((stage) => (
          <li key={stage} className="flex items-center gap-2.5 text-[13px] font-semibold">
            {stage === current ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-accent shrink-0" />
            ) : (
              <Check className="w-3.5 h-3.5 text-accent shrink-0" />
            )}
            <span className={stage === current ? "text-white" : "text-[#8f8f86]"}>{STAGE_LABELS[stage]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PersonFilterBanner({ filter }: { filter: NonNullable<ChatMessage["personFilter"]> }) {
  if (filter.status === "applied") {
    return (
      <div className="flex items-start gap-2.5 rounded-2xl bg-accent/10 border border-accent/25 px-4 py-3 text-[13px] font-semibold text-accent-foreground/90"
        data-testid="person-filter-applied"
      >
        <UserCheck className="w-4 h-4 mt-0.5 text-accent shrink-0" />
        <span className="text-primary/80">
          Only showing moments where <span className="font-bold">{filter.personName}</span> was confirmed on screen by face match.
        </span>
      </div>
    );
  }
  return (
    <div
      className="flex items-start gap-2.5 rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 text-[13px] font-semibold text-amber-800"
      data-testid="person-filter-unavailable"
    >
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <span>
        Face check for <span className="font-bold">{filter.personName}</span> wasn't available — these matches come from scene
        descriptions only.
      </span>
    </div>
  );
}

function ResultCard({ result, onOpen }: { result: SearchResult; onOpen: (r: SearchResult) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(result)}
      className="w-full text-left bg-card border border-border rounded-[20px] p-3 flex gap-4 items-stretch shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all group"
      data-testid={`result-card-${result.id}`}
    >
      <div className="relative w-36 sm:w-44 shrink-0 aspect-video rounded-xl overflow-hidden bg-secondary">
        {result.thumbnailUrl ? (
          <img src={result.thumbnailUrl} alt="" className="w-full h-full object-cover" />
        ) : null}
        <div className="absolute inset-0 bg-black/25 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <span className="w-9 h-9 bg-white/25 backdrop-blur-md rounded-full flex items-center justify-center">
            <Play className="w-4 h-4 text-white fill-white ml-0.5" />
          </span>
        </div>
        {result.matchType !== "title" && (
          <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 bg-black/65 backdrop-blur-md rounded text-[9.5px] font-mono font-bold text-white">
            @ {formatClock(result.timestampSeconds)}
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0 py-0.5 flex flex-col">
        <div className="flex items-center gap-2 mb-1">
          <span
            className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
              result.matchType === "title"
                ? "bg-amber-100 text-amber-900 border border-amber-200"
                : "bg-accent/15 text-accent border border-accent/25"
            }`}
          >
            {result.matchType === "title" ? "Title match" : result.matchType === "scene" ? "Scene match" : "Spoken match"}
          </span>
        </div>
        <h4 className="font-bold text-[14.5px] truncate">{result.videoTitle}</h4>
        <p className="text-[12.5px] font-medium text-muted-foreground line-clamp-2 mt-0.5">
          {result.matchType === "title" ? (result.matchReason ?? "The title matched your question.") : `“… ${result.snippet} …”`}
        </p>
        <div className="mt-auto pt-1.5 flex items-center gap-3 text-[11px] font-semibold text-muted-foreground">
          {result.people && result.people.length > 0 && (
            <span className="flex items-center gap-1">
              <Users className="w-3 h-3" /> {result.people.join(", ")}
            </span>
          )}
          {result.recordedAt && <span>{new Date(result.recordedAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })}</span>}
        </div>
      </div>
    </button>
  );
}

function UserBubble({ message }: { message: Pick<ChatMessage, "content" | "voice" | "personNames"> }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[85%] sm:max-w-[70%] rounded-[20px] rounded-br-md px-4.5 py-3 px-5"
        style={{
          background: "linear-gradient(180deg, #222219, #17170f)",
          border: "1px solid #33332a",
        }}
        data-testid="user-message"
      >
        {(message.personNames?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {message.personNames!.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/10 border border-white/15 text-white text-[11px] font-bold"
              >
                <span className="w-3.5 h-3.5 rounded-full bg-accent text-accent-foreground text-[8px] font-bold flex items-center justify-center">
                  {name[0]}
                </span>
                {name}
              </span>
            ))}
          </div>
        )}
        {message.content && <p className="text-white text-[14.5px] font-medium leading-relaxed">{message.content}</p>}
        {message.voice && (
          <div className="flex items-center gap-1 mt-1 text-[10px] font-mono font-bold uppercase tracking-wider text-[#8f8f86]">
            <Mic className="w-3 h-3" /> Voice
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantTurn({
  message,
  voiceOrigin,
  onOpenResult,
}: {
  message: ChatMessage;
  voiceOrigin: boolean;
  onOpenResult: (r: SearchResult) => void;
}) {
  const [speech, setSpeech] = useState<"idle" | "loading" | "playing">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const speak = async () => {
    if (speech !== "idle") {
      audioRef.current?.pause();
      audioRef.current = null;
      setSpeech("idle");
      return;
    }
    setSpeech("loading");
    const url = await fetchSpeech(message.answer ?? message.content);
    if (!url) {
      setSpeech("idle");
      return;
    }
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => setSpeech("idle");
    audio.onerror = () => setSpeech("idle");
    setSpeech("playing");
    void audio.play().catch(() => setSpeech("idle"));
  };

  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  if (message.failed) {
    return (
      <div className="flex items-start gap-2.5 rounded-[20px] bg-red-50 border border-red-200 px-4 py-3.5 max-w-[85%]" data-testid="assistant-failed">
        <AlertTriangle className="w-4 h-4 mt-0.5 text-red-500 shrink-0" />
        <p className="text-[13.5px] font-semibold text-red-700">{message.content}</p>
      </div>
    );
  }

  const isIntentAnswer = message.intent && message.intent !== "search" && !!message.answer;

  return (
    <div className="space-y-3 max-w-full" data-testid="assistant-message">
      {isIntentAnswer ? (
        <div
          className="rounded-[20px] px-5 py-4 text-white relative overflow-hidden"
          style={{
            background: "linear-gradient(180deg, #1b1b16, #0d0d0a)",
            border: "1px solid #33332a",
          }}
          data-testid="intent-answer"
        >
          <div className="text-[10px] font-mono font-bold uppercase tracking-widest text-accent mb-1.5 flex items-center gap-1.5">
            <Sparkles className="w-3 h-3" /> Answer
          </div>
          <p className="text-[15.5px] font-semibold leading-relaxed">{message.answer}</p>
        </div>
      ) : (
        <p className="text-[14.5px] font-medium leading-relaxed text-primary/90">{message.content}</p>
      )}

      {message.personFilter && <PersonFilterBanner filter={message.personFilter} />}

      {(message.results?.length ?? 0) > 0 && (
        <div className="space-y-2.5">
          {message.results!.map((r) => (
            <ResultCard key={`${message.id}-${r.id}`} result={r} onOpen={onOpenResult} />
          ))}
        </div>
      )}

      {voiceOrigin && (
        <button
          type="button"
          onClick={() => void speak()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-card border border-border text-[12px] font-bold text-muted-foreground hover:text-primary hover:shadow-sm transition-all"
          data-testid="tts-button"
        >
          {speech === "loading" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Volume2 className="w-3.5 h-3.5" />}
          {speech === "playing" ? "Stop" : "Hear the answer"}
        </button>
      )}
    </div>
  );
}

interface PendingSend {
  input: ChatMessageInput;
  personNames: string[];
}

export default function ChatPage() {
  const params = useParams<{ id: string }>();
  const chatId = Number(params.id);
  const queryClient = useQueryClient();

  const {
    data: chat,
    isLoading,
    isError,
  } = useGetChat(chatId, {
    query: { queryKey: getGetChatQueryKey(chatId), enabled: Number.isFinite(chatId) },
  });

  const [pending, setPending] = useState<PendingSend | null>(null);
  const [stagesSeen, setStagesSeen] = useState<ChatStage[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const [player, setPlayer] = useState<PlayerResult | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamingRef = useRef(false);

  const send = useCallback(
    (input: ChatMessageInput, personNames: string[]) => {
      if (streamingRef.current || !Number.isFinite(chatId)) return;
      streamingRef.current = true;
      setSendError(null);
      setPending({ input, personNames });
      setStagesSeen([]);

      sendChatMessageStreaming(chatId, input, (stage) => {
        setStagesSeen((prev) => (prev.includes(stage) ? prev : [...prev, stage]));
      })
        .then(async (turn) => {
          // The server persists the user message before the pipeline runs, so
          // a refocus refetch mid-stream may already have it cached — dedupe
          // by id instead of blindly appending.
          queryClient.setQueryData<ChatDetail>(getGetChatQueryKey(chatId), (old) => {
            if (!old) return old;
            const seen = new Set(old.messages.map((m) => m.id));
            const additions = [turn.userMessage, turn.assistantMessage].filter((m) => !seen.has(m.id));
            return { ...old, messages: [...old.messages, ...additions] };
          });
          setPending(null);
          void queryClient.invalidateQueries({ queryKey: getListChatsQueryKey() });
          // Voice question → speak the answer back once.
          if (input.voice && !turn.assistantMessage.failed) {
            const url = await fetchSpeech(turn.assistantMessage.answer ?? turn.assistantMessage.content);
            if (url) void new Audio(url).play().catch(() => {});
          }
        })
        .catch((err: Error) => {
          setSendError(err.message || "Something went wrong.");
        })
        .finally(() => {
          streamingRef.current = false;
          setStagesSeen([]);
          // Keep `pending` on error so the user message + retry stay visible.
        });
    },
    [chatId, queryClient],
  );

  // First message handed over from the dashboard composer.
  useEffect(() => {
    if (!Number.isFinite(chatId)) return;
    const first = takeFirstMessage(chatId);
    if (first) {
      // personNames for display come from the pills; the handoff stores ids
      // only — names arrive with the persisted message when the turn lands.
      send(first, []);
    }
  }, [chatId, send]);

  const messages = useMemo(() => chat?.messages ?? [], [chat]);
  const isStreaming = pending !== null && !sendError;
  // If a mid-stream refetch already delivered the persisted user message,
  // don't render the optimistic bubble on top of it.
  const lastCached = messages[messages.length - 1];
  const pendingEchoed =
    pending !== null && lastCached?.role === "user" && lastCached.content === pending.input.content;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, stagesSeen.length, pending, sendError]);

  const openResult = useCallback((r: SearchResult) => {
    setPlayer({
      videoId: r.videoId,
      videoTitle: r.videoTitle,
      thumbnailUrl: r.thumbnailUrl,
      videoUrl: r.videoUrl ?? null,
      snippet: r.snippet,
      matchType: r.matchType,
      matchReason: r.matchReason,
      timestampSeconds: r.timestampSeconds,
      durationSeconds: r.durationSeconds,
      people: r.people,
      recordedAt: r.recordedAt,
      location: r.location,
    });
  }, []);

  const onDraft = (draft: ChatDraft) => {
    send(
      {
        content: draft.content,
        ...(draft.personIds.length > 0 ? { personIds: draft.personIds } : {}),
        ...(draft.voice ? { voice: true } : {}),
      },
      draft.personNames,
    );
  };

  if (!Number.isFinite(chatId) || isError) {
    return (
      <AppShell>
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
          <h2 className="text-2xl font-extrabold mb-2">This chat doesn't exist</h2>
          <p className="text-muted-foreground font-medium mb-5">It may have been deleted.</p>
          <Link href="/dashboard" className="rounded-full px-6 h-11 inline-flex items-center bg-primary text-primary-foreground font-bold text-sm">
            Start a new one
          </Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex-1 flex flex-col h-[calc(100dvh-56px)] md:h-[100dvh]">
        {/* Thread */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[820px] mx-auto px-5 md:px-8 pt-8 pb-6 space-y-6">
            {isLoading && (
              <div className="space-y-4 pt-6">
                <div className="h-10 w-2/3 bg-secondary rounded-2xl animate-pulse ml-auto" />
                <div className="h-24 w-5/6 bg-secondary rounded-2xl animate-pulse" />
              </div>
            )}

            {messages.map((message, idx) =>
              message.role === "user" ? (
                <UserBubble key={message.id} message={message} />
              ) : (
                <AssistantTurn
                  key={message.id}
                  message={message}
                  voiceOrigin={!!messages[idx - 1]?.voice && messages[idx - 1]?.role === "user"}
                  onOpenResult={openResult}
                />
              ),
            )}

            {/* In-flight turn */}
            {pending && (
              <>
                {!pendingEchoed && (
                  <UserBubble
                    message={{
                      content: pending.input.content,
                      voice: pending.input.voice,
                      personNames: pending.personNames,
                    }}
                  />
                )}
                {isStreaming && <StagedLoader seen={stagesSeen} />}
                {sendError && (
                  <div className="flex items-center gap-3 flex-wrap" data-testid="send-error">
                    <div className="flex items-start gap-2.5 rounded-[20px] bg-red-50 border border-red-200 px-4 py-3">
                      <AlertTriangle className="w-4 h-4 mt-0.5 text-red-500 shrink-0" />
                      <p className="text-[13.5px] font-semibold text-red-700">{sendError}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => send(pending.input, pending.personNames)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary text-primary-foreground text-[12.5px] font-bold hover:opacity-90 transition-opacity"
                      data-testid="retry-send"
                    >
                      <RotateCcw className="w-3.5 h-3.5" /> Try again
                    </button>
                  </div>
                )}
              </>
            )}

            {!isLoading && messages.length === 0 && !pending && (
              <div className="text-center pt-24">
                <div className="w-12 h-12 mx-auto mb-4 rounded-2xl bg-card border border-border shadow-sm flex items-center justify-center">
                  <SearchIcon className="w-5 h-5 text-accent" />
                </div>
                <p className="text-muted-foreground font-medium">Ask something below — every answer lands in this thread.</p>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </div>

        {/* Composer */}
        <div className="shrink-0 px-5 md:px-8 pb-5 pt-2 bg-gradient-to-t from-background via-background to-transparent">
          <div className="max-w-[820px] mx-auto">
            <ChatInput onSend={onDraft} disabled={isStreaming} placeholder="Ask a follow-up…" />
            <p className="text-center text-[10.5px] font-mono text-muted-foreground/70 mt-2.5">
              Recall searches spoken words and what's on screen · type / to filter by person
            </p>
          </div>
        </div>
      </div>

      {player && <PlayerOverlay result={player} onClose={() => setPlayer(null)} />}
    </AppShell>
  );
}
