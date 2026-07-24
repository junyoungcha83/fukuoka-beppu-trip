# Architecture and migration boundary

- Static UI: root `index.html`, `assets/`, `data/`, `manifest.webmanifest`, `sw.js`.
- API and persistence: `worker/src/index.js`, `worker/wrangler.toml` (KV and R2); deploy from `worker/`.

Keep public root paths and the Worker name stable. Internal refactoring requires compatibility entrypoints, Wrangler dry-run, and PWA cache validation. Agent tools should use explicit trip, attachment, and authorization services.
