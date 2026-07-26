import { logger } from "./logger";

/**
 * ElevenLabs voice features: speech-to-text for spoken queries and
 * text-to-speech for reading answers aloud.
 *
 * Both entry points throw plain Errors with useful messages; routes decide
 * status codes. isElevenLabsConfigured() gates every call — when the key is
 * missing the routes answer 503 and the UI degrades gracefully.
 */

const API_BASE = "https://api.elevenlabs.io/v1";
const STT_MODEL = "scribe_v1";
const TTS_MODEL = "eleven_turbo_v2_5";
// "Rachel" — a clear default narration voice; override with ELEVENLABS_VOICE_ID.
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";
const REQUEST_TIMEOUT_MS = 60_000;

export function isElevenLabsConfigured(): boolean {
  return Boolean(process.env["ELEVENLABS_API_KEY"]);
}

function apiKey(): string {
  return process.env["ELEVENLABS_API_KEY"] ?? "";
}

async function errorDetail(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

/** Transcribe recorded audio (webm/ogg/mp4/wav) to text. */
export async function transcribeAudio(
  audio: Buffer,
  mimeType: string,
): Promise<string> {
  const form = new FormData();
  form.append("model_id", STT_MODEL);
  form.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: mimeType || "audio/webm" }),
    "voice-query",
  );
  const resp = await fetch(`${API_BASE}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": apiKey() },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await errorDetail(resp);
    logger.error({ status: resp.status, detail }, "ElevenLabs STT failed");
    throw new Error(`Transcription failed (${resp.status})`);
  }
  const data = (await resp.json()) as { text?: unknown };
  return typeof data.text === "string" ? data.text.trim() : "";
}

/** Synthesize an answer as MP3 bytes. */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const voiceId = process.env["ELEVENLABS_VOICE_ID"] || DEFAULT_VOICE_ID;
  const resp = await fetch(
    `${API_BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey(),
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text, model_id: TTS_MODEL }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!resp.ok) {
    const detail = await errorDetail(resp);
    logger.error({ status: resp.status, detail }, "ElevenLabs TTS failed");
    throw new Error(`Speech synthesis failed (${resp.status})`);
  }
  return Buffer.from(await resp.arrayBuffer());
}
