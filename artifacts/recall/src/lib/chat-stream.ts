import type { ChatTurn, ChatMessageInput } from "@workspace/api-client-react";

/** Pipeline stages the server emits while a turn is being answered. */
export type ChatStage =
  | "contextualizing"
  | "classifying"
  | "retrieving"
  | "person_check"
  | "reranking"
  | "answering";

export const STAGE_LABELS: Record<ChatStage, string> = {
  contextualizing: "Reading the conversation",
  classifying: "Understanding your question",
  retrieving: "Searching your memories",
  person_check: "Confirming who's in frame",
  reranking: "Picking the best moments",
  answering: "Writing your answer",
};

const API_BASE = `${import.meta.env.BASE_URL}api`;

/**
 * Send one chat message with live progress. Prefers the SSE stream (stage
 * events as the real pipeline advances); transparently handles a plain JSON
 * response if streaming isn't available.
 */
export async function sendChatMessageStreaming(
  chatId: number,
  input: ChatMessageInput,
  onStage: (stage: ChatStage) => void,
  signal?: AbortSignal,
): Promise<ChatTurn> {
  const res = await fetch(`${API_BASE}/chats/${chatId}/messages`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(input),
    signal: signal ?? null,
  });

  const contentType = res.headers.get("content-type") ?? "";

  if (!res.ok) {
    let message = "Something went wrong sending your message.";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new Error(message);
  }

  if (!contentType.includes("text/event-stream") || !res.body) {
    return (await res.json()) as ChatTurn;
  }

  // Minimal SSE parser: events are "event: <name>\ndata: <json>\n\n".
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let turn: ChatTurn | null = null;
  let streamError: string | null = null;

  const handleEvent = (block: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join("\n");
    if (!data) return;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (event === "stage" && typeof parsed["stage"] === "string") {
        onStage(parsed["stage"] as ChatStage);
      } else if (event === "result") {
        turn = parsed as unknown as ChatTurn;
      } else if (event === "error") {
        streamError = typeof parsed["error"] === "string" ? (parsed["error"] as string) : "Search failed.";
      }
    } catch {
      // Ignore malformed frames; the result event is what matters.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Tolerate CRLF framing from any intermediary.
    buffer = buffer.replace(/\r\n/g, "\n");
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (block.trim()) handleEvent(block);
    }
  }
  if (buffer.trim()) handleEvent(buffer);

  if (streamError) throw new Error(streamError);
  if (!turn) throw new Error("The connection dropped before the answer arrived.");
  return turn;
}

/** Voice transcription (multipart — outside the generated JSON client). */
export async function transcribeAudioBlob(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", blob, "query.webm");
  const res = await fetch(`${API_BASE}/voice/transcribe`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? "Transcription failed.");
  return body.text ?? "";
}

/** Text-to-speech: returns a playable data URL, or null when unavailable. */
export async function fetchSpeech(text: string): Promise<string | null> {
  const res = await fetch(`${API_BASE}/voice/tts`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 1200) }),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { audioBase64?: string; mimeType?: string } | null;
  if (!body?.audioBase64) return null;
  return `data:${body.mimeType ?? "audio/mpeg"};base64,${body.audioBase64}`;
}

/**
 * Hand-off store for the first message of a brand-new chat: the dashboard
 * creates the chat, stashes the draft here, and navigates; the thread page
 * consumes it exactly once and starts the streaming send.
 */
const pendingFirstMessages = new Map<number, ChatMessageInput>();

export function stashFirstMessage(chatId: number, input: ChatMessageInput): void {
  pendingFirstMessages.set(chatId, input);
}

export function takeFirstMessage(chatId: number): ChatMessageInput | undefined {
  const input = pendingFirstMessages.get(chatId);
  pendingFirstMessages.delete(chatId);
  return input;
}
