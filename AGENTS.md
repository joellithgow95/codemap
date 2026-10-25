# AGENTS.md: CodeMap

<!-- KEEP THIS FILE IN SYNC: update the map and the hard rules whenever a directory, command or rule changes. -->

CodeMap renders a git repository as a 3D city (Three.js + Vite, no UI framework). A repo becomes a
**map document** (one JSON file) from one of three producers. The browser app renders whichever it
gets.

```
local checkout ─ scan/scan.py ──────┐
GitHub repo ─ web/src/github.js ────┼─> map document (JSON) ─> web/src/main.js (Three.js scene + HUD)
picked folder ─ web/src/local.js ───┘   (reads the folder's .git in the tab via web/src/git.js)
```

## Map

| Path | What | Read next |
|------|------|-----------|
| `scan/` | Python scanner for a local checkout (stdlib only) | [`scan/AGENTS.md`](scan/AGENTS.md) |
| `web/` | The app: Vite config, dev-server endpoints, npm scripts, demo maps | [`web/AGENTS.md`](web/AGENTS.md) |
| `web/src/` | App source: scene, HUD, GitHub and local-folder loaders, git reader, parsers, highlighter | [`web/src/AGENTS.md`](web/src/AGENTS.md) |
| `web/netlify/functions/` | The one server-side piece: GitHub OAuth code → token exchange | [`web/netlify/functions/AGENTS.md`](web/netlify/functions/AGENTS.md) |
| `.github/ISSUE_TEMPLATE/` | Issue form for feedback filed directly (same sections as the in-app button) and the security contact link | |
| `.github/workflows/` | `ci.yml` builds and checks; `labels.yml` creates the issue labels the feedback link applies; `deploy.yml` redeploys to Netlify (secrets `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`) | |
| `netlify.toml` | Build, publish dir, functions dir, security headers and CSP | this file |
| `docs/` | README screenshots (taken from public demo maps only) | |
| `THIRD_PARTY_NOTICES.md` | Licenses of the bundled demo maps | |

## Commands

All from `web/`:

```sh
npm install
npm run dev                      # http://127.0.0.1:5179, serves local scans + the token function
npm run build                    # production bundle in web/dist
npm run scan -- <repo path>      # scan a local checkout into web/local-maps/
GITHUB_TOKEN=... npm run demo -- owner/name 60   # public repos only, writes web/public/demo/
```

There is no test suite. CI (`.github/workflows/ci.yml`) builds the app and byte-compiles the
scanner. Check behaviour by running the app.

## Hard rules

- **Private scans never ship.** `web/local-maps/` holds the full source of every scanned repo. It
  is git-ignored and only the dev server serves it. Never move a scan into `web/public/`, never
  commit one, and check `web/dist/` before a deploy.
- **Repo data is untrusted.** Paths, file text and commit messages come from arbitrary GitHub repos
  and are rendered while a GitHub token may be in `sessionStorage`. Every value that reaches
  `innerHTML` goes through `esc()` (which escapes quotes, for attributes) or the highlighter's
  escaping. Never interpolate raw repo text.
- **The CSP is a contract.** A new network host, inline script, worker or font source needs a
  matching change to the `Content-Security-Policy` in `netlify.toml`.
- **All producers emit the same document.** A field added to the map document is added in
  `scan/scan.py`, `web/src/github.js` and `web/src/local.js` alike (see `web/src/AGENTS.md` for
  the shape).
- **Picked folders stay in the tab.** `local.js` reads files through the browser's folder picker
  and never sends them anywhere; the CSP's `connect-src` backs that up.
- **Feedback never leaks a private repo.** The FEEDBACK button opens a prefilled GitHub issue URL.
  It names the loaded repo only for bundled demos and token-less GitHub loads, never for scans or
  picked folders.
- **Tokens stay in the tab.** The GitHub token goes only to `api.github.com`, is never logged and is
  never persisted beyond `sessionStorage`.
- **Demo maps are third-party content.** Only public repos whose license allows redistribution,
  each with a row in `THIRD_PARTY_NOTICES.md`.
- **No new dependencies without a license check.** Permissive licenses only (MIT, Apache-2.0, BSD,
  ISC). The app has two runtime dependencies on purpose: three, and diff (jsdiff, BSD-3-Clause)
  for the local loader's line diffs.

## Conventions

- Plain ES modules in the browser, no framework. State lives in the `state` object in `main.js`.
  HUD panels are re-rendered from it with template strings.
- Python is standard library only, so the scanner runs on any machine with git and Python 3.10+.
- Comments explain *why*, not what. Commits follow Conventional Commits (`feat:`, `fix:`, `docs:`, …).
