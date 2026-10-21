# AGENTS.md: web/netlify/functions/

<!-- KEEP THIS FILE IN SYNC with github-token.mjs and the env vars in web/.env.example. -->

`github-token.mjs` is the only server-side code. It finishes the GitHub OAuth flow: the browser
POSTs the `code` GitHub redirected back with, the function exchanges it for an access token using
the client secret, and returns `{ access_token }`.

| Env var | Where | Notes |
|---------|-------|-------|
| `GITHUB_CLIENT_ID` | Netlify (server) | Same value as `VITE_GITHUB_CLIENT_ID` |
| `GITHUB_CLIENT_SECRET` | Netlify (server) | **Secret.** Never `VITE_`-prefixed, never in the repo |
| `VITE_GITHUB_CLIENT_ID` | Netlify (build) | Public, baked into the bundle |
| `VITE_GITHUB_SCOPE` | Netlify (build) | Empty for a GitHub App; `repo` only for a classic OAuth App |

The `state` parameter (CSRF protection for the redirect) is generated and checked in the browser
(`completeOAuth` / `startOAuth` in `web/src/main.js`). The function only does the exchange.

## Rules

- **Return the token and nothing else.** No logging of tokens, codes or GitHub's response body.
- **Same-origin only.** Requests with a foreign `Origin` get a 403. Keep that check.
- **Fail closed and clean.** Bad input → 4xx JSON. Never throw, and never echo the secret.
- **`cache-control: no-store`** on every response, so no token is ever cached.
- The dev server (`web/vite.config.js`) imports this file directly. Keep it a single default-export
  handler taking a `Request` and returning a `Response`.
