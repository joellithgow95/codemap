# dash-codemap

3D, Tron-style map of a git repo (default: `~/Code/personal/dash`). Three.js + Vite.

## Run

```
cd web
npm install
npm run dev                    # http://127.0.0.1:5179
```

The local scanner (`scan/scan.py`, stdlib only) writes `web/local-maps/<repo>.json`: files with text,
symbols, imports, per-line blame, working-tree dirty lines, and every commit with its patches.
Scan any repo with `npm run scan -- <repo path>`; every scanned repo is listed in the menu (Esc)
and selectable via `?repo=<name>`. The menu also rescans the current one.

## Load any GitHub repo (no backend)

Menu (`Esc`) -> Load from GitHub, or open `?gh=owner/name&n=50`. The browser reads the file tree,
commit list, and per-commit diffs from the GitHub API and file contents from
`raw.githubusercontent.com`; nothing is cloned. Unauthenticated limit is 60 API calls/hour; a token
(kept in `sessionStorage`, sent only to api.github.com) gives 5,000/hour and private repos. History
is the last N commits, so towers are sized from HEAD and walked backwards through the diffs.

Local scans live in `web/local-maps/` (git-ignored, dev server only). The public build ships only
`web/public/demo/`; add one with `GITHUB_TOKEN=... npm run demo -- owner/name 60`.

## Sign in with GitHub (optional, Netlify)

The page works without sign-in (public repos, or a pasted token). To add the button:

1. Create a **GitHub App** (preferred: read-only `Contents` + `Metadata`, user picks repos) or a classic
   OAuth App. Callback URL = the site root, e.g. `https://<site>.netlify.app/`.
2. Netlify env vars: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (server-side), `VITE_GITHUB_CLIENT_ID`
   (public, baked into the bundle), and `VITE_GITHUB_SCOPE=repo` only for a classic OAuth App.
3. `netlify.toml` already builds `web/` and deploys `web/netlify/functions/github-token.mjs`, which
   swaps the OAuth `code` for a token and returns only that. The secret never reaches the browser.

Local dev: copy `web/.env.example` to `web/.env.local`; `npm run dev` serves the same function.

## Views and lenses

| View | Geometry |
|------|----------|
| City (1) | file = tower (height = lines), folder = district |
| Graph (2) | import network in free space |
| Strata (3) | each tower is a stack of slabs, one per commit that touched it |

Lenses (L): change (what the selected commit touched, or the working tree), language, churn, age.
The timeline scrubs commits; the last stop is the uncommitted working tree. Click a tower for the
code panel (blame gutter, dirty lines, history diffs, symbols); selected files draw import arcs.
