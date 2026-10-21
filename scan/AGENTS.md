# AGENTS.md: scan/

<!-- KEEP THIS FILE IN SYNC with scan.py and with the map document shape in web/src/AGENTS.md. -->

`scan.py` turns a local git checkout into a map document at `web/local-maps/<repo>.json` and
records it in `web/local-maps/manifest.json`. The dev server lists and rescans entries from that
manifest.

```sh
python3 -I scan/scan.py <repo> [--out-dir DIR]   # or: cd web && npm run scan -- <repo>
```

Relative repo paths resolve against `INIT_CWD` when set (npm sets it to where you ran
`npm run scan`), else the current directory.

## What it collects

- Files: `git ls-files` plus untracked, not-ignored files. Text is embedded up to `MAX_TEXT_BYTES`
  (`MAX_DATA_BYTES` for data formats); binaries and oversized files get `text: null`.
- Per file: language, line count, Python/JS symbols, Python imports (resolved to repo paths),
  per-line blame (as commit indexes), working-tree status and dirty lines.
- Commits: every commit, oldest first, each with its files' add/delete counts and a patch capped at
  `MAX_PATCH_LINES`. Renames carry `old`, so history follows a file across them.

## Rules

- **Standard library only.** No third-party imports; the scanner has to run anywhere.
- **Run git with argument lists** (`git(repo, *args)`), never a shell string. Repo paths and file
  names are untrusted input.
- **The output is sensitive.** A map holds the repo's full source. Write it only under
  `web/local-maps/` (git-ignored) unless the caller passes `--out-dir`.
- **Shape changes go both ways.** A new field is added in `web/src/github.js` too, and documented in
  `web/src/AGENTS.md`.
