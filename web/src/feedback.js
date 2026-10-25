// Builds the "send feedback" link: a prefilled new-issue page on GitHub. Nothing is sent from the
// app. The link opens in a new tab and the user submits it under their own GitHub account, so
// there is no token, no API call and no CSP change.

// The one place the issue tracker is named. Change it if the repository moves or is renamed.
export const FEEDBACK_REPO = 'joellithgow95/codemap'

// Applied by GitHub only if the label already exists; .github/workflows/labels.yml creates them.
const LABELS = ['feedback', 'from-app']

const MAX_URL = 7000
const MAX_NAME = 100

// `context` is { version, view, camera, lens, repo?, userAgent }. Pass `repo` only for a public
// map (a bundled demo, or a GitHub load made without a token): it lands in a URL that the user may
// share, so a private repo's name must never get here.
export function feedbackUrl(context) {
  const title = 'Feedback: '
  const head = '### What happened / what I expected\n\n\n\n### Steps to reproduce (if it is a bug)\n\n\n\n### Context\n'
  const fields = [
    ['App version', context.version],
    ['View', context.view],
    ['Camera', context.camera],
    ['Lens', context.lens],
    ['Map', context.repo && String(context.repo).slice(0, MAX_NAME)],
    ['Browser', context.userAgent],
  ].filter(([, value]) => value)
  const build = (count) =>
    `https://github.com/${FEEDBACK_REPO}/issues/new?` +
    new URLSearchParams({ title, labels: LABELS.join(','), body: head + fields.slice(0, count).map(([k, v]) => `- ${k}: ${v}`).join('\n') + '\n' })
  // Drop context from the end (the long user agent first) until the URL fits.
  let count = fields.length
  let url = build(count)
  while (url.length > MAX_URL && count > 0) url = build(--count)
  return url
}
