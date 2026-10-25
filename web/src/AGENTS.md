# AGENTS.md: web/src/

<!-- KEEP THIS FILE IN SYNC with the modules below and with the map document producers. -->

| Module | Role |
|--------|------|
| `main.js` | Everything on screen: loads a map, builds the Three.js scene, runs the frame loop, renders the HUD panels, handles input |
| `data.js` | Pure model code: `buildModel` (per-file history across renames, lines at each commit), `buildTree`, `layoutCity` (treemap → tower and district boxes), `layoutGraph` (force layout of imports) |
| `github.js` | Builds a map document in the browser from the GitHub API + raw content host; with `spec.pull` the history is that PR's commits over the tree at its head, and `listPulls` feeds the menu's PR picker |
| `local.js` | Builds a map document from a folder the user picks (`showDirectoryPicker`, or `<input webkitdirectory>`): `.gitignore`-aware walk, last N first-parent commits diffed with jsdiff, working tree vs HEAD by blob hash |
| `git.js` | Read-only `.git` reader for `local.js`: HEAD and refs, loose objects, packfiles and delta chains, inflated with the native `DecompressionStream` |
| `parse.js` | Language detection, symbol and import extraction, and the file-size limits shared by the browser loaders (the scanner has its own in Python) |
| `highlight.js` | Regex syntax highlighter for the code panel; escapes everything it emits |
| `feedback.js` | Builds the FEEDBACK link: a prefilled new-issue URL on GitHub (`FEEDBACK_REPO` is the one place the tracker is named). No network access: the app only builds a link |
| `style.css` | HUD styling (Tron palette in `:root` variables) |

## The map document

Produced by `scan/scan.py` (local), `github.js` (`source: 'github'`) and `local.js`
(`source: 'local'`). All three must stay compatible.

```
{ repo, head, branch, generated, [source, owner, truncated, treeTruncated, pull],
  commits: [ { sha, short, author, date, subject,
               files: [ { path, old, add, del, status, patch, truncated } ] } ],   // oldest first
  files:   [ { path, lang, loc, bytes, text, symbols, imports, commits, added, deleted,
               authors, tracked, status, dirtyLines, blame, [sha, binary, remote] } ] }
```

`text` is `null` when not embedded (binary, oversized, or not fetched yet). GitHub loads fetch it
lazily on open. `blame[i]` is a commit index (empty for both browser loaders). `status` is the
working-tree state (`clean` for GitHub loads; `clean`, `modified` or `untracked` for local ones).

## main.js layout

Top to bottom: load (OAuth completion, `?local` folder picker / `?gh=` (+ `&pr=`) / `?repo=` / manifests) → model and layouts → scene
objects (towers, nodes, strata slabs, district outlines and labels) → `applyState()` (recolour and
resize for the current commit, lens and focus) → camera (presets, `fitView`, ortho/perspective
swap, map-mode controls) → focus (`computeFocus` pushes sibling folders apart as rigid blocks) →
HUD renderers (`renderTree`, panel views, legend) → menu, keys overlay and search → keyboard →
`frame()`.

## Rules

- **Feedback is a link, never a request.** FEEDBACK opens `feedback.js`'s URL in a new tab
  (`<a target="_blank" rel="noopener noreferrer">`), so there is no token, API call or CSP change.
  Don't turn it into a form (`form-action 'none'`) or a `fetch`. The map's repo name goes into the
  URL only for a bundled demo or a GitHub load made without a token (`source.publicName` in
  `main.js`); scans, picked folders and anything unsure leave it out.

- **Escape everything from a repo.** Paths, names, commit subjects, authors and dates go through
  `esc()` before `innerHTML`. `esc()` covers quotes, so it is safe in quoted attributes too.
  Don't write a new sink that skips it.
- **Network goes through `github.js`.** Only `https://api.github.com` (with the token) and
  `https://raw.githubusercontent.com` (without it). A new host needs a CSP change in `netlify.toml`.
  `local.js` and `git.js` make no requests at all; keep it that way.
- **State drives rendering.** Change `state`, then call the renderer (`applyState`, `renderTree`,
  `renderPanel`). Don't patch DOM fragments ad hoc.
- **Animate, don't jump.** Positions and heights ease toward targets in `frame()` (`vis` = current,
  `focus` / `target` = goal). Camera moves go through `flyTo` / `flyToFit`.
- **Both cameras.** Anything that reads the camera uses the `camera` binding (perspective or
  orthographic). Projection changes go through `applyViewShift()` so the code-panel offset holds.
