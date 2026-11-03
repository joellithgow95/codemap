// Guides: ordered walkthroughs of a codebase, written as YAML (`.codemap/guides/*.yaml` in the
// repo, or a marked PR comment). This module is pure: no DOM, no network, no three.js, so the
// browser app and `scripts/check-guides.mjs` (CI) share one parser and one validator.
//
// A guide is data from an arbitrary repo or commenter. Parse it with tight limits, validate it
// against a fixed vocabulary, and let the caller render every string through `esc()`.
import { parse } from 'yaml'

export const GUIDE_DIR = '.codemap/guides'
export const GUIDE_FILE = /^\.codemap\/guides\/[^/]+\.ya?ml$/
// A PR comment carries a guide when it holds this marker and a fenced yaml block.
export const GUIDE_MARKER = '<!-- codemap-guide -->'

export const VIEWS = ['city', 'graph', 'strata']
export const LENS_IDS = ['change', 'language', 'churn', 'age']
export const CAMERAS = ['iso', 'top', 'front', 'side']

const LIMITS = { bytes: 64 * 1024, steps: 40, focus: 12, title: 120, summary: 400, stepTitle: 100, note: 1200, path: 300 }
const GUIDE_KEYS = new Set(['version', 'title', 'summary', 'steps'])
const STEP_KEYS = new Set(['title', 'note', 'focus', 'folder', 'view', 'lens', 'camera', 'commit'])
// Reserved for later (traffic / trust-boundary / injection markers). Accepted, ignored, flagged.
const RESERVED_KEYS = new Set(['overlays'])

const isText = (v) => typeof v === 'string' && v.trim().length > 0
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Pulls the yaml block out of a PR comment body; null when it isn't a guide comment.
export function guideFromComment(body) {
  if (typeof body !== 'string' || !body.includes(GUIDE_MARKER)) return null
  const fence = /```ya?ml[^\n]*\n([\s\S]*?)\n```/.exec(body)
  return fence ? fence[1] : null
}

export function splitAnchor(anchor) {
  const at = anchor.indexOf('#')
  return at < 0 ? { path: anchor, symbol: null } : { path: anchor.slice(0, at), symbol: anchor.slice(at + 1) || null }
}

// → { guide, errors, warnings }. `guide` is null when there is anything in `errors`.
export function parseGuide(text) {
  const errors = []
  const warnings = []
  const fail = (message) => ({ guide: null, errors: [...errors, message], warnings })
  if (typeof text !== 'string') return fail('guide is not text')
  if (text.length > LIMITS.bytes) return fail(`guide is larger than ${LIMITS.bytes / 1024} KB`)

  let data
  try {
    // Core schema (no timestamps or binary), no aliases (so no expansion bombs), no duplicate keys.
    data = parse(text, { schema: 'core', maxAliasCount: 0, uniqueKeys: true })
  } catch (error) {
    return fail(`not valid YAML: ${String(error.message).split('\n')[0]}`)
  }
  if (!isObject(data)) return fail('top level must be a mapping with title and steps')

  const err = (where, message) => errors.push(`${where}: ${message}`)
  const text_ = (where, value, max, required) => {
    if (value === undefined || value === null) {
      if (required) err(where, 'required')
      return undefined
    }
    if (!isText(value)) return void err(where, 'must be non-empty text')
    if (value.length > max) return void err(where, `longer than ${max} characters`)
    return value.trim()
  }

  Object.keys(data).forEach((k) => {
    if (!GUIDE_KEYS.has(k)) warnings.push(`unknown key "${k}" ignored`)
  })
  if (data.version !== undefined && data.version !== 1) err('version', 'only version 1 is supported')

  const guide = {
    title: text_('title', data.title, LIMITS.title, true),
    summary: text_('summary', data.summary, LIMITS.summary, false),
    steps: [],
  }

  if (!Array.isArray(data.steps) || !data.steps.length) err('steps', 'must be a non-empty list')
  else if (data.steps.length > LIMITS.steps) err('steps', `at most ${LIMITS.steps} steps`)
  else {
    data.steps.forEach((raw, i) => {
      const where = `steps[${i}]`
      if (!isObject(raw)) return void err(where, 'must be a mapping')
      Object.keys(raw).forEach((k) => {
        if (RESERVED_KEYS.has(k)) warnings.push(`${where}.${k} is reserved and ignored for now`)
        else if (!STEP_KEYS.has(k)) warnings.push(`${where}: unknown key "${k}" ignored`)
      })
      const step = {
        title: text_(`${where}.title`, raw.title, LIMITS.stepTitle, true),
        note: text_(`${where}.note`, raw.note, LIMITS.note, false),
        focus: [],
        folder: text_(`${where}.folder`, raw.folder, LIMITS.path, false)?.replace(/^\/+|\/+$/g, ''),
      }
      if (raw.focus !== undefined) {
        const list = typeof raw.focus === 'string' ? [raw.focus] : raw.focus
        if (!Array.isArray(list) || list.some((a) => !isText(a) || a.length > LIMITS.path)) err(`${where}.focus`, 'must be a path or a list of paths (path or path#symbol)')
        else if (list.length > LIMITS.focus) err(`${where}.focus`, `at most ${LIMITS.focus} entries`)
        else step.focus = list.map((a) => a.trim().replace(/^\/+/, ''))
      }
      const choice = (key, allowed) => {
        if (raw[key] === undefined) return
        if (!allowed.includes(raw[key])) err(`${where}.${key}`, `must be one of ${allowed.join(', ')}`)
        else step[key] = raw[key]
      }
      choice('view', VIEWS)
      choice('lens', LENS_IDS)
      choice('camera', CAMERAS)
      if (raw.commit !== undefined) {
        const c = String(raw.commit)
        if (/^(latest|first|working)$/.test(c) || /^[0-9a-f]{4,40}$/i.test(c)) step.commit = c.toLowerCase()
        else err(`${where}.commit`, 'must be latest, first, working, or a commit sha prefix (4+ hex characters)')
      }
      guide.steps.push(step)
    })
  }
  return errors.length ? { guide: null, errors, warnings } : { guide, errors, warnings }
}

// `lookup(path)` → null when the file isn't in the tree, else { symbols: [...] | null }.
// symbols is null when the file's text hasn't been read (lazy GitHub loads), so a symbol
// can't be checked there; the CI check always has the text and is strict.
export function resolveAnchor(anchor, lookup) {
  const { path, symbol } = splitAnchor(anchor)
  const file = lookup(path)
  if (!file) return { ok: false, path, symbol, reason: `no file "${path}"` }
  if (!symbol) return { ok: true, path, symbol: null, line: null }
  if (!file.symbols) return { ok: true, path, symbol, line: null, unchecked: true }
  const hit = file.symbols.find((s) => s.name === symbol || (s.parent && `${s.parent}.${s.name}` === symbol))
  return hit
    ? { ok: true, path, symbol, line: hit.line }
    : { ok: false, path, symbol, reason: `no symbol "${symbol}" in ${path}` }
}

// → [{ step, message }] for every anchor, folder or commit that doesn't resolve.
// `folders` is a Set of directory paths; `lookup` as for resolveAnchor.
export function validateGuide(guide, { lookup, folders, shas = null }) {
  const problems = []
  guide.steps.forEach((step, i) => {
    step.focus.forEach((a) => {
      const r = resolveAnchor(a, lookup)
      if (!r.ok) problems.push({ step: i, message: r.reason })
    })
    if (step.folder && !folders.has(step.folder)) problems.push({ step: i, message: `no folder "${step.folder}"` })
    if (shas && step.commit && !/^(latest|first|working)$/.test(step.commit) && !shas.some((s) => s.startsWith(step.commit))) {
      problems.push({ step: i, message: `no commit ${step.commit} in this history` })
    }
  })
  return problems
}

// Timeline index for a step's `commit`. `count` is the number of commits; index `count` is the
// working tree (only meaningful when it has changes). null leaves the timeline where it is.
export function commitIndexOf(spec, shas, count) {
  if (!spec) return null
  if (spec === 'latest') return count - 1
  if (spec === 'first') return 0
  if (spec === 'working') return count
  const i = shas.findIndex((s) => s?.startsWith(spec))
  return i < 0 ? null : i
}
