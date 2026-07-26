---
name: VideoDB SDK quirks (Node)
description: Non-obvious behaviors of the videodb npm SDK and how this project integrates it
---

# VideoDB SDK (npm `videodb`, used in the api-server)

- `connect(apiKey).getCollection()` → Collection. Don't cache connections; they're cheap.
- `SearchResult.shots` is a **public property**, not `getShots()`. Guard with `result instanceof SearchResult` because `collection.search()` returns a union with `RTStreamSearchResult`.
- `collection.uploadURL/uploadFile` return `Video | Audio | Image | undefined` — narrow with `instanceof Video` and treat anything else as a hard error.
- `video.indexSpokenWords()` blocks until done; `video.indexScenes()` returns a scene-index id and completes **asynchronously** — poll `getSceneIndex(id)` (throws/empty until ready).
- pnpm blocks the package's postinstall script — harmless; it only downloads optional "capture" binaries.
- Enums: `SearchTypeValues.semantic`, `IndexTypeValues.spoken`, `SceneExtractionType.shotBased`.
- `streamUrl` is an HLS (`.m3u8`) URL — Chrome needs hls.js for playback; Safari plays natively.
- Clip export: `video.generateStream([[start,end]])` (floats OK) returns a trimmed HLS URL; assign it to the instance's `streamUrl` (typed read-only but a plain property — cast to write) then `video.download(name)` returns **synchronously** with `{ downloadUrl, status: "done", name }` (~20s for short clips). No polling needed.
- Frame extraction: `video.generateThumbnail(timeSeconds)` returns an `Image` whose `.url` is already populated (fallback: `image.generateUrl()`); fetching that URL yields a JPEG (~800KB) usable directly as AWS Rekognition image bytes.
- The `indexScenes` prompt is a full instruction channel: for user-defined detection targets, embed the request and tell the model to append a sentinel token (e.g. `USER_REQUEST_MATCH`) to matching scene descriptions — detection becomes a substring check, far more reliable than keyword regex over free-form text. Strip the sentinel before storing/showing descriptions. Verified working against real scans.
- The SDK has **no request timeouts anywhere** — any call can wedge forever (observed: `getCollection()` and `getVideo()` hanging pipelines for hours, not just the long indexing calls). Wrap EVERY SDK call in a `withTimeout(promise, ms, label)` race (generous budgets: 60s metadata, minutes-scale indexing) so a wedge becomes a labeled, retryable failure instead of a stuck job.

**Why:** These were learned by reading the SDK's d.ts; guessing (e.g. calling `getShots()`) breaks typecheck or silently misbehaves.
**How to apply:** Any work touching upload/search/scan code paths in the api-server.

- **No aggregate/count API.** The SDK's collection surface only exposes search factories (checked `dist/core/collection.js`) — there is no server-side count/aggregate. Count-style features must run a wide semantic search and aggregate hits app-side.
- **Video-level search exists**: `video.search(query, searchType, indexType)` scopes semantic search to a single video — use it for find-in-video features instead of filtering collection hits. The **scene index rejects very short queries** (roughly < 3 meaningful words) with an error while the spoken index accepts them — run per-index calls under `Promise.allSettled` and treat a scene-index rejection as a normal miss.
- **Titles are not in the semantic index.** Search only covers indexed scene descriptions + spoken words; a video whose *title* names the subject ("stuck in traffic") but whose footage shows something else (a selfie) is unfindable by that phrase. Title/metadata matching needs its own app-side layer.
