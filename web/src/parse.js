const EXT_LANG = {
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'html',
  css: 'css',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  json: 'json',
  sh: 'shell',
  sql: 'sql',
}
const SCRIPT_LANGS = new Set(['javascript', 'typescript'])
const JS_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']

// Shared by the GitHub and local-folder loaders: which files get their text read, and how much.
export const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip|gz|tar|pkl|xlsx|lock|mp[34]|mov|wasm|so|dylib|bin)$/i
export const DATA_EXT = /\.(json|csv|tsv|jsonl|txt|xml|svg)$/i
export const MAX_TEXT_BYTES = 150_000
export const MAX_DATA_BYTES = 20_000
export const MAX_PATCH_LINES = 150
export const MAX_TREE_FILES = 4000

export const countLines = (text) => (text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0)

export function wantsText(entry) {
  if (BINARY_EXT.test(entry.path)) return false
  return entry.size <= (DATA_EXT.test(entry.path) ? MAX_DATA_BYTES : MAX_TEXT_BYTES)
}

// Runs task over items with at most `size` in flight, keeping results in input order.
export async function pool(items, size, task) {
  const queue = [...items.keys()]
  const results = new Array(items.length)
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) results[i] = await task(items[i], i)
    }),
  )
  return results
}

export function langOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (name === 'Dockerfile' || name === 'Justfile' || name === 'Makefile') return 'shell'
  return EXT_LANG[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'text'
}

export function parsesSymbols(lang) {
  return lang === 'python' || SCRIPT_LANGS.has(lang)
}

function pythonSymbols(lines) {
  const found = []
  lines.forEach((text, i) => {
    const m = /^(\s*)(?:async\s+)?(class|def)\s+(\w+)/.exec(text)
    if (m) found.push({ indent: m[1].length, kind: m[2], name: m[3], line: i + 1 })
  })
  return found.map((s, i) => {
    const next = found.slice(i + 1).find((n) => n.indent <= s.indent)
    const parent = s.indent > 0 ? found.slice(0, i).reverse().find((p) => p.kind === 'class' && p.indent < s.indent) : null
    return {
      name: s.name,
      kind: s.kind === 'class' ? 'class' : parent ? 'method' : 'function',
      line: s.line,
      end: next ? next.line - 1 : lines.length,
      parent: parent?.name ?? null,
    }
  })
}

function scriptSymbols(lines) {
  const pattern = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s+(\w+)|(class)\s+(\w+)|(?:const|let)\s+(\w+)\s*=)/
  return lines.flatMap((text, i) => {
    const m = pattern.exec(text)
    if (!m) return []
    const kind = m[1] ? 'function' : m[2] ? 'class' : 'const'
    return [{ name: m[1] ?? m[3] ?? m[4], kind, line: i + 1, end: null, parent: null }]
  })
}

export function extractSymbols(text, lang) {
  const lines = text.split('\n')
  if (lang === 'python') return pythonSymbols(lines)
  if (SCRIPT_LANGS.has(lang)) return scriptSymbols(lines)
  return []
}

export function buildResolver(paths) {
  const pathSet = new Set(paths)
  const suffixes = new Map()
  paths
    .filter((p) => p.endsWith('.py'))
    .forEach((p) => {
      const parts = p.slice(0, -3).split('/')
      if (parts.at(-1) === '__init__') parts.pop()
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(i).join('.')
        if (!suffixes.has(key)) suffixes.set(key, [])
        suffixes.get(key).push({ path: p, depth: parts.length, rooted: i === 0 || (i === 1 && parts[0] === 'src') })
      }
    })

  const absolute = (dotted) => {
    const hits = suffixes.get(dotted)
    if (!hits) return null
    const multiSegment = dotted.includes('.')
    const eligible = multiSegment ? hits : hits.filter((h) => h.rooted)
    return eligible.sort((a, b) => a.depth - b.depth)[0]?.path ?? null
  }
  const inDir = (dir, dotted) => {
    const base = [dir, ...dotted.split('.')].filter(Boolean).join('/')
    return [`${base}.py`, `${base}/__init__.py`].find((c) => pathSet.has(c)) ?? null
  }
  const script = (fromDir, spec) => {
    const parts = [...fromDir.split('/').filter(Boolean)]
    spec.split('/').forEach((seg) => {
      if (seg === '..') parts.pop()
      else if (seg !== '.') parts.push(seg)
    })
    const base = parts.join('/')
    const candidates = [base, ...JS_EXTENSIONS.map((e) => base + e), ...JS_EXTENSIONS.map((e) => `${base}/index${e}`)]
    return candidates.find((c) => pathSet.has(c)) ?? null
  }
  return { absolute, inDir, script }
}

function pythonImports(text, path, resolver) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const found = []
  text.split('\n').forEach((line) => {
    const plain = /^\s*import\s+([\w.,\s]+?)(?:\s*#.*)?$/.exec(line)
    if (plain) {
      plain[1].split(',').forEach((part) => found.push(resolver.absolute(part.trim().split(/\s+as\s+/)[0])))
      return
    }
    const from = /^\s*from\s+(\.*)([\w.]*)\s+import\s+\(?([^)#]*)/.exec(line)
    if (!from) return
    const [, dots, module, names] = from
    const members = names.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean)
    if (dots) {
      const up = dots.length - 1
      const base = dir.split('/').filter(Boolean)
      const target = base.slice(0, base.length - up).join('/')
      if (module) found.push(resolver.inDir(target, module))
      members.forEach((m) => found.push(resolver.inDir([target, module.replace(/\./g, '/')].filter(Boolean).join('/'), m)))
      if (!module) found.push(resolver.inDir(target, '__init__'))
      return
    }
    found.push(resolver.absolute(module))
    members.forEach((m) => found.push(resolver.absolute(`${module}.${m}`)))
  })
  return found
}

function scriptImports(text, path, resolver) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  const pattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]*)['"]/g
  return [...text.matchAll(pattern)].map((m) => resolver.script(dir, m[1]))
}

export function extractImports(text, lang, path, resolver) {
  let found = []
  if (lang === 'python') found = pythonImports(text, path, resolver)
  else if (SCRIPT_LANGS.has(lang)) found = scriptImports(text, path, resolver)
  return [...new Set(found.filter((p) => p && p !== path))].sort()
}
