import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { Router, type IRouter } from "express";
import { db, videosTable, type VideoRow } from "@workspace/db";
import {
  GetSourcesStatusResponse,
  CreatePhotosSessionResponse,
  GetPhotosSessionResponse,
  ListPhotosItemsResponse,
  ImportPhotosItemBody,
  ImportPhotosItemResponse,
  ListYoutubeVideosResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { currentUserId } from "../lib/auth";
import { isVideoDBConfigured } from "../lib/videodb";
import { runIngestion } from "../lib/ingestion";
import {
  type OauthService,
  OauthNotConnectedError,
  isGoogleOauthConfigured,
  buildAuthUrl,
  exchangeCodeAndStore,
  getConnection,
  getValidAccessToken,
} from "../lib/googleOauth";

const router: IRouter = Router();

declare module "express-session" {
  interface SessionData {
    oauthState?: { nonce: string; service: OauthService };
  }
}

const PHOTOS_API = "https://photospicker.googleapis.com/v1";
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024; // matches local upload cap

function parseService(raw: unknown): OauthService | null {
  return raw === "google_photos" || raw === "youtube" ? raw : null;
}

/** Small page for the OAuth popup: report back to the opener and close. */
function popupResultPage(ok: boolean, service: string, message = ""): string {
  const payload = JSON.stringify({ type: "recall-oauth", ok, service, message });
  return `<!doctype html><html><body style="font-family:sans-serif;padding:2rem;text-align:center">
<p>${ok ? "Connected. You can close this window." : "Connection failed — you can close this window."}</p>
<script>
  // API and app share the same origin behind the proxy, so scope the message.
  if (window.opener) { window.opener.postMessage(${payload}, window.location.origin); }
  setTimeout(() => window.close(), 800);
</script></body></html>`;
}

async function googleGet<T>(url: string, token: string): Promise<T> {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Google API ${resp.status}: ${body.slice(0, 300)}`);
  }
  return (await resp.json()) as T;
}

function handleSourceError(res: Parameters<Parameters<IRouter["get"]>[1]>[1], err: unknown): void {
  if (err instanceof OauthNotConnectedError) {
    res.status(409).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err }, "Source request failed");
  res.status(502).json({ error: message });
}

// ---------------------------------------------------------------------------
// OAuth start + callback (browser redirects — not part of the JSON API spec)
// ---------------------------------------------------------------------------

router.get("/oauth/google/start", (req, res) => {
  const service = parseService(req.query["service"]);
  if (!service) {
    res.status(400).json({ error: "service must be google_photos or youtube" });
    return;
  }
  if (!isGoogleOauthConfigured()) {
    res
      .status(503)
      .send(
        popupResultPage(
          false,
          service,
          "Google OAuth is not configured (missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).",
        ),
      );
    return;
  }
  const nonce = randomBytes(16).toString("hex");
  req.session.oauthState = { nonce, service };
  res.redirect(buildAuthUrl(req, service, nonce));
});

router.get("/oauth/google/callback", async (req, res) => {
  const expected = req.session.oauthState;
  delete req.session.oauthState;
  const service = expected?.service ?? "unknown";
  const fail = (message: string): void => {
    logger.warn({ message, service }, "OAuth callback failed");
    res.status(200).send(popupResultPage(false, service, message));
  };
  if (typeof req.query["error"] === "string") {
    fail(
      req.query["error"] === "access_denied"
        ? "You cancelled the Google sign-in."
        : `Google returned: ${req.query["error"]}`,
    );
    return;
  }
  const code = req.query["code"];
  const state = req.query["state"];
  if (!expected || typeof code !== "string" || state !== expected.nonce) {
    fail("Sign-in session expired or state mismatch. Try connecting again.");
    return;
  }
  try {
    await exchangeCodeAndStore(req, currentUserId(req), expected.service, code);
    res.send(popupResultPage(true, expected.service));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
});

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

router.get("/sources/status", async (req, res) => {
  const uid = currentUserId(req);
  const [photos, youtube] = await Promise.all([
    getConnection(uid, "google_photos"),
    getConnection(uid, "youtube"),
  ]);
  res.json(
    GetSourcesStatusResponse.parse({
      oauthConfigured: isGoogleOauthConfigured(),
      googlePhotos: Boolean(photos),
      youtube: Boolean(youtube),
    }),
  );
});

// ---------------------------------------------------------------------------
// Google Photos Picker
// ---------------------------------------------------------------------------

type PickerSession = {
  id: string;
  pickerUri: string;
  mediaItemsSet?: boolean;
  pollingConfig?: { pollInterval?: string };
};

function toSessionJson(s: PickerSession) {
  // pollInterval arrives as e.g. "5s" (proto Duration) — normalize to millis.
  const raw = s.pollingConfig?.pollInterval ?? "";
  const seconds = Number.parseFloat(raw.replace(/s$/, ""));
  return {
    sessionId: s.id,
    pickerUri: s.pickerUri,
    mediaItemsSet: Boolean(s.mediaItemsSet),
    pollIntervalMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 4000,
  };
}

router.post("/sources/photos/session", async (req, res) => {
  try {
    const token = await getValidAccessToken(currentUserId(req), "google_photos");
    const resp = await fetch(`${PHOTOS_API}/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Picker session create failed (${resp.status}): ${body.slice(0, 300)}`);
    }
    const session = (await resp.json()) as PickerSession;
    res.json(CreatePhotosSessionResponse.parse(toSessionJson(session)));
  } catch (err) {
    handleSourceError(res, err);
  }
});

router.get("/sources/photos/session/:id", async (req, res) => {
  try {
    const token = await getValidAccessToken(currentUserId(req), "google_photos");
    const session = await googleGet<PickerSession>(
      `${PHOTOS_API}/sessions/${encodeURIComponent(req.params.id)}`,
      token,
    );
    res.json(GetPhotosSessionResponse.parse(toSessionJson(session)));
  } catch (err) {
    handleSourceError(res, err);
  }
});

type PickerMediaItem = {
  id: string;
  type?: string;
  mediaFile?: { baseUrl?: string; mimeType?: string; filename?: string };
};

router.get("/sources/photos/items", async (req, res) => {
  const sessionId = req.query["sessionId"];
  if (typeof sessionId !== "string" || !sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  try {
    const token = await getValidAccessToken(currentUserId(req), "google_photos");
    const items: PickerMediaItem[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ sessionId, pageSize: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await googleGet<{ mediaItems?: PickerMediaItem[]; nextPageToken?: string }>(
        `${PHOTOS_API}/mediaItems?${params}`,
        token,
      );
      items.push(...(page.mediaItems ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && items.length < 500);
    const videos = items.filter((i) => i.type === "VIDEO");
    res.json(
      ListPhotosItemsResponse.parse(
        videos.map((v) => ({
          id: v.id,
          filename: v.mediaFile?.filename ?? "Google Photos video",
          mimeType: v.mediaFile?.mimeType ?? null,
        })),
      ),
    );
  } catch (err) {
    handleSourceError(res, err);
  }
});

/**
 * Imports ONE picked video: downloads the bytes server-side (picker baseUrls
 * require the OAuth token, so the client or VideoDB can't fetch them) into a
 * temp file, then hands it to the exact same ingestion pipeline as a local
 * file upload. One request per item keeps batch semantics identical to files.
 */
router.post("/sources/photos/import", async (req, res) => {
  const parsed = ImportPhotosItemBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!isVideoDBConfigured()) {
    res.status(503).json({ error: "VideoDB is not configured. Add the VIDEODB_API_KEY secret." });
    return;
  }
  const { sessionId, itemId, privacyRequest } = parsed.data;
  const uid = currentUserId(req);
  const tempPath = path.join(tmpdir(), `photos-import-${randomBytes(8).toString("hex")}`);
  try {
    const token = await getValidAccessToken(uid, "google_photos");
    // Re-fetch the item from the session to get a fresh, owned baseUrl —
    // never trust a client-supplied URL for a server-side download.
    const params = new URLSearchParams({ sessionId, pageSize: "100" });
    let item: PickerMediaItem | undefined;
    let pageToken: string | undefined;
    do {
      if (pageToken) params.set("pageToken", pageToken);
      const page = await googleGet<{ mediaItems?: PickerMediaItem[]; nextPageToken?: string }>(
        `${PHOTOS_API}/mediaItems?${params}`,
        token,
      );
      item = page.mediaItems?.find((i) => i.id === itemId);
      pageToken = page.nextPageToken;
    } while (!item && pageToken);
    if (!item?.mediaFile?.baseUrl) {
      res.status(404).json({ error: "Picked item not found in this picker session." });
      return;
    }
    if (item.type !== "VIDEO") {
      res.status(400).json({ error: "Only videos can be imported." });
      return;
    }

    // "=dv" asks Photos for the video bytes.
    const dl = await fetch(`${item.mediaFile.baseUrl}=dv`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (!dl.ok || !dl.body) {
      throw new Error(`Google Photos download failed (${dl.status}).`);
    }
    const len = Number(dl.headers.get("content-length") ?? 0);
    if (len > MAX_IMPORT_BYTES) {
      res.status(400).json({ error: "Video is larger than 2 GB — skipped." });
      return;
    }
    // Content-length can be missing or lie — enforce the cap on actual bytes.
    let received = 0;
    const capGuard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > MAX_IMPORT_BYTES) {
          cb(new Error("Video is larger than 2 GB — skipped."));
          return;
        }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(dl.body as never), capGuard, createWriteStream(tempPath));

    const title =
      (item.mediaFile.filename ?? "").replace(/\.[^.]+$/, "").trim() ||
      "Google Photos video";
    let video: VideoRow;
    try {
      const inserted = await db
        .insert(videosTable)
        .values({
          userId: uid,
          title,
          thumbnailUrl: "",
          videoUrl: null,
          durationSeconds: 0,
          status: "processing",
          source: "google_photos",
          tags: [],
          people: [],
          privacyRequest: privacyRequest?.trim().slice(0, 500) || null,
        })
        .returning();
      video = inserted[0]!;
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw err;
    }
    void runIngestion(video.id, { kind: "file", filePath: tempPath }).catch((err) => {
      logger.error({ err, videoId: video.id }, "Ingestion pipeline crashed");
    });
    res.status(202).json(
      ImportPhotosItemResponse.parse({
        id: video.id,
        title: video.title,
        status: video.status,
      }),
    );
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    handleSourceError(res, err);
  }
});

// ---------------------------------------------------------------------------
// YouTube (own channel, public + unlisted)
// ---------------------------------------------------------------------------

const YT_API = "https://www.googleapis.com/youtube/v3";

router.get("/sources/youtube/videos", async (req, res) => {
  try {
    const token = await getValidAccessToken(currentUserId(req), "youtube");
    const channels = await googleGet<{
      items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[];
    }>(`${YT_API}/channels?part=contentDetails&mine=true`, token);
    const uploads = channels.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) {
      res.json(ListYoutubeVideosResponse.parse([]));
      return;
    }
    type PlaylistItem = {
      snippet?: {
        title?: string;
        publishedAt?: string;
        resourceId?: { videoId?: string };
        thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
      };
      status?: { privacyStatus?: string };
    };
    const videos: PlaylistItem[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        part: "snippet,status",
        playlistId: uploads,
        maxResults: "50",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await googleGet<{ items?: PlaylistItem[]; nextPageToken?: string }>(
        `${YT_API}/playlistItems?${params}`,
        token,
      );
      videos.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && videos.length < 200);

    res.json(
      ListYoutubeVideosResponse.parse(
        videos
          .filter(
            (v) =>
              v.snippet?.resourceId?.videoId &&
              (v.status?.privacyStatus === "public" ||
                v.status?.privacyStatus === "unlisted"),
          )
          .map((v) => ({
            videoId: v.snippet!.resourceId!.videoId!,
            title: v.snippet?.title ?? "Untitled video",
            thumbnailUrl:
              v.snippet?.thumbnails?.medium?.url ??
              v.snippet?.thumbnails?.default?.url ??
              null,
            publishedAt: v.snippet?.publishedAt ?? null,
            privacyStatus: v.status?.privacyStatus ?? "public",
          })),
      ),
    );
  } catch (err) {
    handleSourceError(res, err);
  }
});

export default router;
