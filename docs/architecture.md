# Architecture and migration boundary

- Static UI: root `index.html`, `assets/`, `data/`, `manifest.webmanifest`, `sw.js`.
- API and persistence: `api/src/index.js`, `api/wrangler.toml` (KV and R2); deploy from `api/` (`cd api && npm run deploy`). The Worker `name` (`fukuoka-beppu-trip-api`), KV binding (`TRIP`), and R2 binding (`ATT`) are unchanged by the directory rename.

Keep public root paths and the Worker name stable. Internal refactoring requires compatibility entrypoints, Wrangler dry-run, and PWA cache validation. Agent tools should use explicit trip, attachment, and authorization services.
