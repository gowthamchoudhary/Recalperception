import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Mic, Square, X, Loader2, Slash } from "lucide-react";
import {
  useListEnrolledPeople,
  useGetVoiceStatus,
  getListEnrolledPeopleQueryKey,
  getGetVoiceStatusQueryKey,
  type EnrolledPerson,
} from "@workspace/api-client-react";
import { transcribeAudioBlob } from "@/lib/chat-stream";

export interface ChatDraft {
  content: string;
  personIds: number[];
  personNames: string[];
  voice: boolean;
}

export interface PersonPill {
  id: number;
  name: string;
  thumbnailUrl?: string;
}

/** Matches a "/mention" being typed at the end of the input. */
const MENTION_RE = /(?:^|\s)\/([^\s/]*)$/;

/**
 * The chat composer — dark glass bar in the landing's visual language.
 * Supports "/" person mentions (pills with AND semantics), voice input via
 * the mic (ElevenLabs transcription), Enter to send.
 */
export function ChatInput({
  onSend,
  disabled = false,
  autoFocus = false,
  variant = "docked",
  placeholder,
}: {
  onSend: (draft: ChatDraft) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  variant?: "hero" | "docked";
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const [pills, setPills] = useState<PersonPill[]>([]);
  const [voiceOrigin, setVoiceOrigin] = useState(false);
  const [focused, setFocused] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);

  // ---- Voice recording state ----
  const [recState, setRecState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [recSeconds, setRecSeconds] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const discardRef = useRef(false);

  const inputRef = useRef<HTMLInputElement>(null);

  const { data: people = [] } = useListEnrolledPeople({
    query: { queryKey: getListEnrolledPeopleQueryKey(), staleTime: 60_000 },
  });
  const { data: voiceStatus } = useGetVoiceStatus({
    query: { queryKey: getGetVoiceStatusQueryKey(), staleTime: 5 * 60_000 },
  });
  const voiceAvailable = !!voiceStatus?.configured;

  // ---- "/" mention popover ----
  const mentionMatch = MENTION_RE.exec(value);
  const mentionQuery = mentionMatch?.[1]?.toLowerCase() ?? null;
  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const taken = new Set(pills.map((p) => p.id));
    return people
      .filter((p: EnrolledPerson) => !taken.has(p.id) && p.name.toLowerCase().includes(mentionQuery))
      .slice(0, 6);
  }, [mentionQuery, people, pills]);
  const popoverOpen = mentionQuery !== null && candidates.length > 0;

  useEffect(() => setHighlightIdx(0), [mentionQuery]);

  const addPill = (person: EnrolledPerson) => {
    if (pills.length >= 5) return;
    setPills((prev) => [...prev, { id: person.id, name: person.name, thumbnailUrl: person.thumbnailUrl }]);
    // Strip the "/query" the user was typing.
    setValue((v) => v.replace(MENTION_RE, (m) => (m.startsWith(" ") ? " " : "")));
    inputRef.current?.focus();
  };

  const removePill = (id: number) => setPills((prev) => prev.filter((p) => p.id !== id));

  const canSend = !disabled && (value.trim().length > 0 || pills.length > 0) && recState === "idle";

  const submit = () => {
    if (!canSend) return;
    const draft: ChatDraft = {
      content: value.trim(),
      personIds: pills.map((p) => p.id),
      personNames: pills.map((p) => p.name),
      voice: voiceOrigin,
    };
    setValue("");
    setPills([]);
    setVoiceOrigin(false);
    setVoiceError(null);
    onSend(draft);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (popoverOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        addPill(candidates[highlightIdx] ?? candidates[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setValue((v) => v.replace(MENTION_RE, (m) => (m.startsWith(" ") ? " " : "")));
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "Backspace" && value === "" && pills.length > 0) {
      e.preventDefault();
      setPills((prev) => prev.slice(0, -1));
    }
  };

  // ---- Voice recording ----
  useEffect(() => {
    if (recState !== "recording") return;
    const t = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [recState]);

  const startRecording = async () => {
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      discardRef.current = false;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (discardRef.current) {
          setRecState("idle");
          setRecSeconds(0);
          return;
        }
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        setRecState("transcribing");
        transcribeAudioBlob(blob)
          .then((text) => {
            if (text.trim()) {
              setValue((v) => (v.trim() ? `${v.trim()} ${text.trim()}` : text.trim()));
              setVoiceOrigin(true);
            } else {
              setVoiceError("Didn't catch that — try again a bit closer to the mic.");
            }
          })
          .catch((err: Error) => setVoiceError(err.message || "Transcription failed."))
          .finally(() => {
            setRecState("idle");
            setRecSeconds(0);
            inputRef.current?.focus();
          });
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecSeconds(0);
      setRecState("recording");
    } catch {
      setVoiceError("Microphone access was blocked — allow it in your browser to use voice.");
    }
  };

  const stopRecording = (discard: boolean) => {
    discardRef.current = discard;
    recorderRef.current?.stop();
  };

  useEffect(
    () => () => {
      // Unmount while recording: drop everything quietly.
      discardRef.current = true;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    },
    [],
  );

  const isHero = variant === "hero";

  return (
    <div className="relative">
      {/* Glow behind the bar (landing search-bar treatment) */}
      <div
        aria-hidden
        className="absolute -inset-x-2 -bottom-2 top-4 rounded-[32px] transition-opacity duration-500 pointer-events-none"
        style={{
          background: "linear-gradient(90deg, #1c8a3e, #3b82f6, #a855f7, #ec4899, #f59e0b)",
          filter: "blur(18px)",
          opacity: focused ? 0.35 : 0.16,
        }}
      />

      <div
        className={`relative rounded-[26px] ${isHero ? "p-3.5 pl-5" : "p-2.5 pl-4"} flex items-end gap-3`}
        style={{
          background: "linear-gradient(180deg, #222219, #17170f)",
          border: "1px solid #33332a",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 18px 40px -18px rgba(0,0,0,0.55)",
        }}
      >
        <div className="flex-1 min-w-0">
          {/* Pills + input share one wrapping row */}
          <div className="flex flex-wrap items-center gap-1.5">
            {pills.map((pill) => (
              <span
                key={pill.id}
                className="inline-flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-full bg-white/10 border border-white/15 text-white text-[13px] font-bold"
                data-testid={`person-pill-${pill.id}`}
              >
                {pill.thumbnailUrl ? (
                  <img src={pill.thumbnailUrl} alt="" className="w-5 h-5 rounded-full object-cover ring-1 ring-accent/70" />
                ) : (
                  <span className="w-5 h-5 rounded-full bg-accent text-accent-foreground text-[9px] font-bold flex items-center justify-center">
                    {pill.name[0]}
                  </span>
                )}
                {pill.name}
                <button
                  type="button"
                  onClick={() => removePill(pill.id)}
                  className="text-white/50 hover:text-white transition-colors"
                  aria-label={`Remove ${pill.name}`}
                  data-testid={`remove-pill-${pill.id}`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </span>
            ))}
            <input
              ref={inputRef}
              type="text"
              value={value}
              autoFocus={autoFocus}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              disabled={recState === "transcribing"}
              placeholder={
                recState === "recording"
                  ? "Listening…"
                  : recState === "transcribing"
                    ? "Transcribing…"
                    : (placeholder ?? (pills.length > 0 ? "Add details, or just send" : "Ask your memories… type / to mention someone"))
              }
              className={`flex-1 min-w-[140px] bg-transparent text-white ${isHero ? "text-[15.5px] py-2" : "text-[14px] py-1.5"} font-medium placeholder:text-[#8f8f86] focus:outline-none disabled:opacity-60`}
              data-testid="chat-input"
            />
          </div>
          {voiceError && (
            <p className="text-[11.5px] font-semibold text-amber-400/90 mt-1 pl-1" data-testid="voice-error">
              {voiceError}
            </p>
          )}
        </div>

        {/* Voice + send controls */}
        <div className="flex items-center gap-2 shrink-0 pb-0.5">
          {recState === "recording" ? (
            <>
              <span className="flex items-center gap-2 text-[12px] font-mono font-bold text-red-400 pr-1" data-testid="recording-timer">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                {Math.floor(recSeconds / 60)}:{(recSeconds % 60).toString().padStart(2, "0")}
              </span>
              <button
                type="button"
                onClick={() => stopRecording(true)}
                className="w-9 h-9 rounded-full flex items-center justify-center text-[#9a9a90] hover:text-white hover:bg-white/10 transition-colors"
                aria-label="Discard recording"
                data-testid="discard-recording"
              >
                <X className="w-4.5 h-4.5" />
              </button>
              <button
                type="button"
                onClick={() => stopRecording(false)}
                className="w-10 h-10 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-400 transition-colors shadow-lg"
                aria-label="Stop and transcribe"
                data-testid="stop-recording"
              >
                <Square className="w-4 h-4 fill-current" />
              </button>
            </>
          ) : (
            <>
              {voiceAvailable && (
                <button
                  type="button"
                  onClick={startRecording}
                  disabled={disabled || recState === "transcribing"}
                  className="w-10 h-10 rounded-full flex items-center justify-center text-[#b5b5aa] hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50"
                  aria-label="Ask by voice"
                  data-testid="mic-button"
                >
                  {recState === "transcribing" ? <Loader2 className="w-5 h-5 animate-spin" /> : <Mic className="w-5 h-5" />}
                </button>
              )}
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                className="w-10 h-10 rounded-full flex items-center justify-center transition-all disabled:opacity-40"
                style={{
                  background: canSend ? "linear-gradient(180deg, #ffffff, #e8e8e8)" : "rgba(255,255,255,0.12)",
                  color: canSend ? "#111" : "#8f8f86",
                  boxShadow: canSend ? "inset 0 1px 0 rgba(255,255,255,0.9), 0 8px 18px -6px rgba(0,0,0,0.5)" : "none",
                }}
                aria-label="Send"
                data-testid="send-button"
              >
                <ArrowUp className="w-5 h-5" strokeWidth={2.5} />
              </button>
            </>
          )}
        </div>

        {/* "/" people popover */}
        {popoverOpen && (
          <div
            className="absolute bottom-full left-3 right-3 sm:right-auto sm:w-[320px] mb-2 rounded-2xl overflow-hidden z-30 animate-in fade-in slide-in-from-bottom-1 duration-150"
            style={{
              background: "linear-gradient(180deg, #1b1b16, #0d0d0a)",
              border: "1px solid #33332a",
              boxShadow: "0 18px 40px -12px rgba(0,0,0,0.6)",
            }}
            data-testid="people-popover"
          >
            <div className="px-3.5 pt-2.5 pb-1.5 text-[10px] font-mono font-bold uppercase tracking-widest text-[#6f6f66] flex items-center gap-1.5">
              <Slash className="w-3 h-3" /> Mention a person
            </div>
            <ul className="pb-1.5 max-h-56 overflow-y-auto">
              {candidates.map((person, idx) => (
                <li key={person.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      addPill(person);
                    }}
                    onMouseEnter={() => setHighlightIdx(idx)}
                    className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left transition-colors ${
                      idx === highlightIdx ? "bg-white/10" : ""
                    }`}
                    data-testid={`mention-option-${person.id}`}
                  >
                    {person.thumbnailUrl ? (
                      <img src={person.thumbnailUrl} alt="" className="w-7 h-7 rounded-full object-cover ring-1 ring-white/20" />
                    ) : (
                      <span className="w-7 h-7 rounded-full bg-accent text-accent-foreground text-[10px] font-bold flex items-center justify-center">
                        {person.name[0]}
                      </span>
                    )}
                    <span className="text-[13.5px] font-bold text-white">{person.name}</span>
                    <span className="ml-auto text-[10px] font-mono text-[#6f6f66]">only clips with them</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
