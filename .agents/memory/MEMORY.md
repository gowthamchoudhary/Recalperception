# Memory Index

- [VideoDB SDK quirks](videodb-sdk.md) — shots is a property, uploads return unions, async-poll scene indexing, zero-hit search raises, streamUrl is HLS, sentinel scene prompts, no aggregate API, titles not searchable.
- [Bundled-server library asset gotchas](bundled-server-assets.md) — esbuild-bundled Express servers break libs that read files via __dirname (e.g. connect-pg-simple table.sql); own such tables in the app schema.
- [Orval codegen gotchas](orval-multipart-dom-lib.md) — format:binary needs dom lib in api-zod tsconfig; never name a schema `<OperationId>Params` (collides with orval's generated param type).
- [Agent-shell long jobs](background-processes.md) — backgrounded/nohup'd processes get silently reaped; run drains as foreground timeboxed chunks with guarded reset SQL and per-item caps.
