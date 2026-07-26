import { Router, type IRouter } from "express";
import multer from "multer";
import {
  GetVoiceStatusResponse,
  TranscribeVoiceResponse,
  SynthesizeSpeechBody,
  SynthesizeSpeechResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  isElevenLabsConfigured,
  transcribeAudio,
  synthesizeSpeech,
} from "../lib/elevenlabs";

const router: IRouter = Router();

const NOT_CONFIGURED =
  "Voice features aren't set up yet — add the ELEVENLABS_API_KEY secret to enable them.";

// Voice queries are short; 15MB comfortably covers a minute of webm audio.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

router.get("/voice/status", (_req, res): void => {
  res.json(
    GetVoiceStatusResponse.parse({ configured: isElevenLabsConfigured() }),
  );
});

router.post(
  "/voice/transcribe",
  upload.single("audio"),
  async (req, res): Promise<void> => {
    if (!isElevenLabsConfigured()) {
      res.status(503).json({ error: NOT_CONFIGURED });
      return;
    }
    if (!req.file || req.file.buffer.length === 0) {
      res.status(400).json({ error: "No audio received." });
      return;
    }
    try {
      const text = await transcribeAudio(req.file.buffer, req.file.mimetype);
      res.json(TranscribeVoiceResponse.parse({ text }));
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Voice transcription failed",
      );
      res
        .status(502)
        .json({ error: "Couldn't transcribe that — please try again." });
    }
  },
);

router.post("/voice/tts", async (req, res): Promise<void> => {
  const parsed = SynthesizeSpeechBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!isElevenLabsConfigured()) {
    res.status(503).json({ error: NOT_CONFIGURED });
    return;
  }
  try {
    const audio = await synthesizeSpeech(parsed.data.text);
    res.json(
      SynthesizeSpeechResponse.parse({
        audioBase64: audio.toString("base64"),
        mimeType: "audio/mpeg",
      }),
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Speech synthesis failed",
    );
    res
      .status(502)
      .json({ error: "Couldn't generate speech — please try again." });
  }
});

export default router;
