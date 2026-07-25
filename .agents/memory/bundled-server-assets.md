---
name: Bundled-server library asset gotchas
description: Libraries that load bundled files via __dirname break when the server is esbuild-bundled to dist/
---

# Libraries reading their own assets break under esbuild bundling

When an Express/Node server is bundled with esbuild into `dist/` (instead of running from `node_modules` via tsx/node), any dependency that reads a file relative to its own `__dirname` at runtime will resolve against `dist/` and fail with ENOENT.

**Seen with:** connect-pg-simple's `createTableIfMissing: true` — it reads its bundled `table.sql` via `__dirname`, which becomes `<app>/dist/table.sql` after bundling. The failure is a runtime 500 on first session write, not a build error, so it hides until an actual request.

**Why:** esbuild inlines the library code but does not copy its non-JS assets; `__dirname` is rewritten to the output dir.

**How to apply:** For session stores, own the table in the app's drizzle schema (exact columns the library expects: `sid varchar PK, sess json, expire timestamp(6)` + expire index) and set `createTableIfMissing: false`. Generally: when a dev server bundles to dist, audit deps for runtime file reads (`.sql`, templates, WASM) and either own the asset or mark the package external in the build config.
