# AGENTS.md: web/

<!-- KEEP THIS FILE IN SYNC with vite.config.js, package.json scripts and the folders below. -->

The browser app, its build, and its dev-only server endpoints.

| Path | What |
|------|------|
| `index.html` | All HUD markup: header, view/lens buttons, folder tree, camera HUD, code panel, menu, keys overlay, search |
| `src/` | App source. See [`src/AGENTS.md`](src/AGENTS.md) |
| `netlify/functions/` | OAuth token exchange. See [`netlify/functions/AGENTS.md`](netlify/functions/AGENTS.md) |
| `scripts/make-demo.mjs` | `npm run demo`: loads a public GitHub repo with `src/github.js` and writes a demo map |
| `public/demo/` | Demo maps that ship with the site, plus their `manifest.json`. Third-party content: see `THIRD_PARTY_NOTICES.md` |
| `local-maps/` | **Git-ignored.** Local scans (full source). Served at `/maps/` by the dev server only |
| `.env.example` | OAuth variables for local sign-in; copy to `.env.local` (git-ignored) |
| `vite.config.js` | Dev server on 127.0.0.1:5179, the dev-only middleware below, and `__APP_VERSION__` (from `package.json`) defined for the feedback link |

## Dev-only endpoints (`vite.config.js`)

- `GET /maps/<file>`: serves `local-maps/<basename>`. `basename()` blocks path traversal.
- `GET /api/rescan?repo=<name>`: reruns the scanner, only for a repo already in
  `local-maps/manifest.json`, with `execFile` (no shell).
- `/.netlify/functions/github-token`: runs the real function so sign-in works under `npm run dev`.

These run only in `npm run dev`. The server binds to 127.0.0.1, and Vite checks the Host header
before plugin middleware, so a web page can't reach them through DNS rebinding. Keep both true.

## Rules

- `npm run build` must never pick up `local-maps/`. Only `public/` is copied into `dist/`.
- `npm run demo` is for **public** repos only, and each new demo needs a row in
  `THIRD_PARTY_NOTICES.md`.
- Bumping `three` or `vite`: build, then click through city/graph/strata, the gizmo and a GitHub
  load. Vite 8 needs Node 20.19+ or 22.12+.
