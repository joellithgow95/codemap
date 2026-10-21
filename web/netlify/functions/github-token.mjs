const TOKEN_URL = 'https://github.com/login/oauth/access_token'

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

// Browsers send `Origin: null` from sandboxed frames, which isn't a parseable URL.
const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' })

  const origin = req.headers.get('origin')
  if (origin && hostOf(origin) !== new URL(req.url).host) return json(403, { error: 'cross-origin request refused' })

  const clientId = process.env.GITHUB_CLIENT_ID
  const clientSecret = process.env.GITHUB_CLIENT_SECRET
  if (!clientId || !clientSecret) return json(500, { error: 'GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are not set' })

  const { code } = await req.json().catch(() => ({}))
  if (typeof code !== 'string' || !code) return json(400, { error: 'missing code' })

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error || !body.access_token) {
    return json(400, { error: body.error_description ?? body.error ?? `GitHub returned ${res.status}` })
  }
  return json(200, { access_token: body.access_token })
}
