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
- The `indexScenes` prompt is a full instruction channel: for user-defined detection targets, embed the request and tell the model to append a sentinel token (e.g. `USER_REQUEST_MATCH`) to matching scene descriptions — detection becomes a substring check, far more reliable than keyword regex over free-form text. Strip the sentinel before storing/showing descriptions. Verified working against real scans.

**Why:** These were learned by reading the SDK's d.ts; guessing (e.g. calling `getShots()`) breaks typecheck or silently misbehaves.
**How to apply:** Any work touching upload/search/scan code paths in the api-server.
