import { buildResolver, extractImports, extractSymbols, langOf, parsesSymbols } from './parse.js'

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|gz|tar|pkl|xlsx|lock|mp[34]|mov|wasm|so|dylib|bin)$/i
const DATA_EXT = /\.(json|csv|tsv|jsonl|txt|xml|svg)$/i
const MAX_TEXT_BYTES = 150_000
const MAX_DATA_BYTES = 20_000
const MAX_TEXT_FILES = 500
const MAX_PATCH_LINES = 150
const MAX_TREE_FILES = 4000

export class GithubError extends Error {}

export function parseRepoSpec(input) {
  const text = input.trim().replace(/\.git$/, '').replace(/\/$/, '')
  const url = /github\.com[/:]([^/\s]+)\/([^/\s#?]+)(?:\/tree\/([^\s#?]+))?/.exec(text)
  if (url) return { owner: url[1], repo: url[2], ref: url[3] ?? null }
  const short = /^([\w.-]+)\/([\w.-]+)(?:@(.+))?$/.exec(text)
  if (short) return { owner: short[1], repo: short[2], ref: short[3] ?? null }
  throw new GithubError(`Can't read "${input}" as a GitHub repo. Use owner/name or a github.com URL.`)
}

async function pool(items, size, task) {
  const queue = [...items.keys()]
  const results = new Array(items.length)
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) results[i] = await task(items[i], i)
    }),
  )
  return results
}

function authHeaders(token) {
  const headers = { Accept: 'application/vnd.github+json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function api(ctx, path) {
  const res = await fetch(`${API}${path}`, { headers: authHeaders(ctx.token) })
  const remaining = res.headers.get('x-ratelimit-remaining')
  if (remaining !== null) ctx.remaining = Number(remaining)
  if (res.ok) return res.json()
  if ((res.status === 403 || res.status === 429) && ctx.remaining === 0) {
    const reset = new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000)
    throw new GithubError(
      `GitHub API rate limit hit (resets ${reset.toLocaleTimeString()}). Add a token in the menu for 5,000 requests/hour.`,
    )
  }
  if (res.status === 404) {
    throw new GithubError(
      ctx.token
        ? `${ctx.owner}/${ctx.repo} not found, or your token can't read it.`
        : `${ctx.owner}/${ctx.repo} not found. Private repo? Add a token in the menu.`,
    )
  }
  if (res.status === 401) throw new GithubError('GitHub rejected that token (401).')
  throw new GithubError(`GitHub API ${res.status} for ${path}`)
}

function decodeBase64(b64) {
  const bin = atob(b64.replace(/\n/g, ''))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export async function fetchText(ctx, entry) {
  if (ctx.token) {
    const blob = await api(ctx, `/repos/${ctx.owner}/${ctx.repo}/git/blobs/${entry.sha}`)
    return decodeBase64(blob.content)
  }
  const res = await fetch(`${RAW}/${ctx.owner}/${ctx.repo}/${ctx.commit}/${entry.path.split('/').map(encodeURIComponent).join('/')}`)
  if (!res.ok) throw new GithubError(`raw fetch ${res.status} for ${entry.path}`)
  return res.text()
}

const countLines = (text) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0)

function wantsText(entry) {
  if (BINARY_EXT.test(entry.path)) return false
  return entry.size <= (DATA_EXT.test(entry.path) ? MAX_DATA_BYTES : MAX_TEXT_BYTES)
}

function textPriority(entry) {
  const lang = langOf(entry.path)
  return (parsesSymbols(lang) ? 0 : lang === 'text' ? 3 : 1) * 1e7 + entry.size
}

function toCommitEntry(raw) {
  return {
    sha: raw.sha,
    short: raw.sha.slice(0, 7),
    author: raw.commit.author?.name ?? raw.author?.login ?? 'unknown',
    date: raw.commit.author?.date ?? '',
    subject: raw.commit.message.split('\n')[0],
    files: [],
  }
}

function toCommitFile(f) {
  const patch = (f.patch ?? '').split('\n')
  return {
    path: f.filename,
    old: f.status === 'renamed' ? f.previous_filename : null,
    add: f.additions,
    del: f.deletions,
    status: f.status,
    patch: patch.slice(0, MAX_PATCH_LINES).join('\n'),
    truncated: patch.length > MAX_PATCH_LINES,
  }
}

export async function loadGithub(spec, { token = '', commitLimit = 50, onProgress = () => {} } = {}) {
  const ctx = { owner: spec.owner, repo: spec.repo, token, remaining: null, commit: null }

  onProgress('repository', 0, 1)
  const meta = await api(ctx, `/repos/${ctx.owner}/${ctx.repo}`)
  const ref = spec.ref ?? meta.default_branch

  onProgress('commit list', 0, 1)
  const listed = await api(ctx, `/repos/${ctx.owner}/${ctx.repo}/commits?sha=${encodeURIComponent(ref)}&per_page=${Math.min(commitLimit, 100)}`)
  if (!listed.length) throw new GithubError(`${ctx.owner}/${ctx.repo} has no commits on ${ref}.`)
  ctx.commit = listed[0].sha

  onProgress('file tree', 0, 1)
  const tree = await api(ctx, `/repos/${ctx.owner}/${ctx.repo}/git/trees/${ctx.commit}?recursive=1`)
  const blobs = tree.tree.filter((n) => n.type === 'blob').map((n) => ({ path: n.path, size: n.size ?? 0, sha: n.sha }))
  const keptBlobs = blobs.slice(0, MAX_TREE_FILES)

  const commits = listed.map(toCommitEntry).reverse()
  const details = await pool(commits, 6, async (commit, i) => {
    const detail = await api(ctx, `/repos/${ctx.owner}/${ctx.repo}/commits/${commit.sha}`)
    onProgress('commit diffs', i + 1, commits.length)
    return detail.files ?? []
  })
  commits.forEach((c, i) => (c.files = details[i].map(toCommitFile)))

  const textTargets = keptBlobs
    .filter(wantsText)
    .sort((a, b) => textPriority(a) - textPriority(b))
    .slice(0, MAX_TEXT_FILES)
  let loaded = 0
  const texts = new Map()
  await pool(textTargets, 8, async (entry) => {
    try {
      texts.set(entry.path, await fetchText(ctx, entry))
    } catch {
      texts.set(entry.path, null)
    }
    onProgress('file contents', ++loaded, textTargets.length)
  })

  const resolver = buildResolver(keptBlobs.map((b) => b.path))
  const authors = new Map()
  const touched = new Map()
  commits.forEach((c, idx) =>
    c.files.forEach((f) => {
      const key = f.path
      if (!touched.has(key)) touched.set(key, [])
      touched.get(key).push(idx)
      if (!authors.has(key)) authors.set(key, new Set())
      authors.get(key).add(c.author)
    }),
  )

  const files = keptBlobs.map((b) => {
    const lang = langOf(b.path)
    const text = texts.get(b.path) ?? null
    const binary = BINARY_EXT.test(b.path) || (!wantsText(b) && b.size > MAX_TEXT_BYTES) || (text === null && DATA_EXT.test(b.path))
    return {
      path: b.path,
      sha: b.sha,
      lang,
      loc: text !== null ? countLines(text) : binary ? 0 : Math.max(1, Math.ceil(b.size / 36)),
      bytes: b.size,
      text,
      binary,
      remote: true,
      symbols: text && parsesSymbols(lang) ? extractSymbols(text, lang) : [],
      imports: text ? extractImports(text, lang, b.path, resolver) : [],
      commits: touched.get(b.path) ?? [],
      added: 0,
      deleted: 0,
      authors: [...(authors.get(b.path) ?? [])].sort(),
      tracked: true,
      status: 'clean',
      dirtyLines: [],
      blame: [],
    }
  })

  const doc = {
    repo: ctx.repo,
    head: ctx.commit.slice(0, 7),
    branch: ref,
    generated: new Date().toISOString(),
    source: 'github',
    owner: ctx.owner,
    truncated: listed.length >= commitLimit,
    treeTruncated: tree.truncated || blobs.length > MAX_TREE_FILES,
    commits,
    files,
  }
  return { doc, ctx }
}
