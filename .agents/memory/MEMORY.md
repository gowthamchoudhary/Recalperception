# Memory Index

- [VideoDB SDK quirks](videodb-sdk.md) — shots is a property, uploads return unions, async-poll scene indexing, zero-hit search raises, streamUrl is HLS, sentinel-token scene prompts for custom detection.
- [Bundled-server library asset gotchas](bundled-server-assets.md) — esbuild-bundled Express servers break libs that read files via __dirname (e.g. connect-pg-simple table.sql); own such tables in the app schema.
- [Orval multipart DOM lib](orval-multipart-dom-lib.md) — `format: binary` schemas need `lib: ["es2022","dom"]` in lib/api-zod tsconfig or codegen typecheck fails on File/Blob.
