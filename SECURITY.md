# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub:
**Security → Report a vulnerability** on this repository
(https://github.com/joellithgow95/codemap/security/advisories/new). Don't open a public issue for
them.

Include what you found, how to reproduce it, and what an attacker could do with it. I aim to reply
within a week. This is a personal project, so there is no bug bounty.

## What's in scope

- **The live site** (https://codemap-3d.netlify.app) and the `github-token` Netlify function.
- **Rendering untrusted repos.** The site renders file paths, file contents and commit text from
  any GitHub repo while a GitHub token may sit in `sessionStorage`. A repo that can run script
  in the page, or get the token sent anywhere but `api.github.com`, is a vulnerability.
- **The local dev server and scanner**, e.g. a way for a web page to read `web/local-maps/` (which
  holds full source of scanned repos) from a running `npm run dev`.

## How the site protects tokens

- The token lives in the tab's `sessionStorage` only, and is sent only as an `Authorization` header
  to `api.github.com`.
- All repo-sourced text is HTML-escaped (including quotes) before it reaches the DOM.
- The Content-Security-Policy in `netlify.toml` allows scripts only from the site itself and network
  requests only to the site, `api.github.com` and `raw.githubusercontent.com`.
- `Referrer-Policy: no-referrer` keeps the OAuth `code` out of Referer headers.
- The OAuth client secret exists only in Netlify environment variables. The function returns the
  access token and nothing else, and doesn't log it.
