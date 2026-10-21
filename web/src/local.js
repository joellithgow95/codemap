import { structuredPatch } from 'diff'

import { GITLINK_MODE, TREE_MODE, openGit, toHex } from './git.js'
import {
  DATA_EXT,
  MAX_DATA_BYTES,
  MAX_PATCH_LINES,
  MAX_TEXT_BYTES,
  MAX_TREE_FILES,
  buildResolver,
  countLines,
  extractImports,
  extractSymbols,
  langOf,
  parsesSymbols,
  pool,
} from './parse.js'

// Folders never worth walking; FALLBACK_SKIP only applies when the folder has no .gitignore.
const ALWAYS_SKIP = new Set(['.git', 'node_modules'])
const FALLBACK_SKIP = new Set(['.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target'])
// Past this many changed lines a diff is counted from the line totals instead of drawn.
const MAX_EDIT_LENGTH = 2000
// Working files up to this size are hashed, so an edit is caught even when the file is too big to
// show; bigger ones are assumed clean.
const MAX_HASH_BYTES = 5_000_000

const decoder = new TextDecoder()

export class LocalError extends Error {}

// Chromium: a directory handle, walked lazily, so ignored folders (node_modules) are never opened.
function handleFolder(root) {
  const dirAt = async (parts) => {
    let dir = root
    for (const part of parts) dir = await dir.getDirectoryHandle(part)
    return dir
  }
  return {
    name: root.name || 'folder',
    async file(path) {
      const parts = path.split('/')
      try {
        return await (await (await dirAt(parts.slice(0, -1))).getFileHandle(parts.at(-1))).getFile()
      } catch {
        return null
      }
    },
    async list(path) {
      try {
        const dir = await dirAt(path.split('/').filter(Boolean))
        const entries = []
        for await (const [name, entry] of dir.entries()) entries.push({ name, dir: entry.kind === 'directory' })
        return entries
      } catch {
        return []
      }
    },
  }
}

// Firefox and Safari: <input webkitdirectory> hands over every file up front as a flat list.
function fileListFolder(fileList) {
  const files = new Map()
  const children = new Map()
  for (const f of fileList) {
    const parts = f.webkitRelativePath.split('/').slice(1)
    files.set(parts.join('/'), f)
    parts.forEach((name, i) => {
      const dir = parts.slice(0, i).join('/')
      if (!children.has(dir)) children.set(dir, new Map())
      children.get(dir).set(name, i < parts.length - 1)
    })
  }
  return {
    name: fileList[0].webkitRelativePath.split('/')[0],
    file: async (path) => files.get(path) ?? null,
    list: async (path) => [...(children.get(path) ?? [])].map(([name, dir]) => ({ name, dir })),
  }
}

// Must run inside a click handler: browsers only open pickers on a user gesture. Cancelling
// rejects with an AbortError.
export function pickFolder() {
  if ('showDirectoryPicker' in window) return window.showDirectoryPicker({ mode: 'read' }).then(handleFolder)
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.webkitdirectory = true
    input.onchange = () =>
      input.files.length ? resolve(fileListFolder(input.files)) : reject(new LocalError('That folder has no files.'))
    input.oncancel = () => reject(new DOMException('picker closed', 'AbortError'))
    input.click()
  })
}

const GLOB_PARTS = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' }

// The common subset of .gitignore: globs, anchored paths, dir-only entries and "!" re-includes,
// relative to the folder (`base`) the .gitignore sits in. Character classes are not supported.
function ignoreRules(text, base) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const negate = line.startsWith('!')
      const pattern = line.replace(/^!/, '').replace(/\/$/, '')
      const body = pattern
        .replace(/^\//, '')
        .split(/(\*\*\/|\*\*|\*|\?)/)
        .map((part) => GLOB_PARTS[part] ?? part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        .join('')
      const re = new RegExp(`${pattern.includes('/') ? '^' : '(?:^|/)'}${body}$`)
      return { base, negate, re, dirOnly: line.endsWith('/') }
    })
}

// Like git, the last matching rule wins, and an ignored folder is never entered, so nothing
// inside it can be re-included.
function isIgnored(rules, path, isDir) {
  let ignored = false
  for (const r of rules) {
    if ((isDir || !r.dirOnly) && r.re.test(path.slice(r.base.length))) ignored = !r.negate
  }
  return ignored
}

// What `git ls-files --cached --others --exclude-standard` lists: every file committed at HEAD
// (even if a .gitignore now matches it) plus untracked files nothing ignores. Inside an ignored
// folder that still holds committed files, only those files are kept. The one gap: the global
// excludes file (~/.config/git/ignore) is outside the picked folder, so it can't be applied.
async function listFiles(folder, tracked) {
  const exclude = await folder.file('.git/info/exclude')
  const rootIgnore = await folder.file('.gitignore')
  const skip = rootIgnore ? ALWAYS_SKIP : new Set([...ALWAYS_SKIP, ...FALLBACK_SKIP])
  const trackedDirs = new Set()
  for (const path of tracked.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) trackedDirs.add(parts.slice(0, i).join('/'))
  }

  const found = []
  const visit = async (dir, inherited, insideIgnored) => {
    const entries = await folder.list(dir)
    // Like git, never descend into another repository (a nested clone, worktree or submodule).
    if (dir && entries.some((e) => e.name === '.git')) return
    const prefix = dir ? `${dir}/` : ''
    const own = entries.some((e) => e.name === '.gitignore' && !e.dir)
    const rules = own ? [...inherited, ...ignoreRules(await (await folder.file(`${prefix}.gitignore`)).text(), prefix)] : inherited
    await Promise.all(
      entries.map(async (entry) => {
        const path = prefix + entry.name
        if (entry.dir && skip.has(entry.name)) return
        const ignored = insideIgnored || isIgnored(rules, path, entry.dir)
        if (entry.dir && (!ignored || trackedDirs.has(path))) await visit(path, rules, ignored)
        if (!entry.dir && (!ignored || tracked.has(path))) found.push(path)
      }),
    )
  }
  await visit('', exclude ? ignoreRules(await exclude.text(), '') : [], false)
  return found.sort()
}

// The id git gives a file's contents, so a working file can be compared with HEAD unread.
async function blobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`)
  const buffer = new Uint8Array(header.length + bytes.length)
  buffer.set(header)
  buffer.set(bytes, header.length)
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', buffer)))
}

// Binary is decided by content, as git does (a NUL byte), not by extension: the bytes are already
// here, and extensions mislead (.pkl is Pkl config text as often as a Python pickle).
const asText = (bytes) => (bytes.includes(0) ? null : decoder.decode(bytes))

// Blobs are diffed up to MAX_HASH_BYTES, past the display limit, so a big file (a lockfile) still
// gets its line counts; lineDiff falls back to line totals when the diff itself is too large.
async function blobText(git, sha) {
  if (!sha) return ''
  const { data } = await git.read(sha)
  return data.length > MAX_HASH_BYTES ? null : asText(data)
}

// Line diff: add/del counts, GitHub-style hunks, and the new-side line numbers that changed.
function lineDiff(before, after) {
  const result = structuredPatch('', '', before, after, '', '', { context: 3, maxEditLength: MAX_EDIT_LENGTH })
  if (!result) return { add: countLines(after), del: countLines(before), patch: [], lines: [] }

  const diff = { add: 0, del: 0, patch: [], lines: [] }
  result.hunks.forEach((h) => {
    diff.patch.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines)
    let line = h.newStart
    h.lines.forEach((l) => {
      if (l[0] === '+') {
        diff.add++
        diff.lines.push(line++)
      } else if (l[0] === '-') diff.del++
      else if (l[0] === ' ') line++
    })
  })
  return diff
}

async function diffTrees(git, before, after, prefix = '', out = []) {
  if (before === after) return out
  const a = new Map((before ? await git.tree(before) : []).map((e) => [e.name, e]))
  const b = new Map((after ? await git.tree(after) : []).map((e) => [e.name, e]))
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(name)
    const y = b.get(name)
    if (x?.sha === y?.sha) continue
    const path = prefix + name
    const xTree = x?.mode === TREE_MODE
    const yTree = y?.mode === TREE_MODE
    if (xTree || yTree) await diffTrees(git, xTree ? x.sha : null, yTree ? y.sha : null, `${path}/`, out)
    const xBlob = x && !xTree && x.mode !== GITLINK_MODE ? x.sha : null
    const yBlob = y && !yTree && y.mode !== GITLINK_MODE ? y.sha : null
    if (xBlob || yBlob) out.push({ path, old: null, before: xBlob, after: yBlob })
  }
  return out
}

// A file deleted and re-added with identical contents in one commit is a rename.
function pairRenames(changes) {
  const removed = new Map(changes.filter((c) => !c.after).map((c) => [c.before, c]))
  const renamed = new Set()
  changes.forEach((c) => {
    const source = !c.before && removed.get(c.after)
    if (!source || renamed.has(source)) return
    renamed.add(source)
    Object.assign(c, { old: source.path, before: source.before })
  })
  return changes.filter((c) => !renamed.has(c))
}

async function toCommitFile(git, change) {
  const before = await blobText(git, change.before)
  const after = await blobText(git, change.after)
  const diff = before === null || after === null ? { add: 0, del: 0, patch: [] } : lineDiff(before, after)
  const patch = DATA_EXT.test(change.path) ? [] : diff.patch
  return {
    path: change.path,
    old: change.old,
    add: diff.add,
    del: diff.del,
    status: !change.before ? 'added' : !change.after ? 'removed' : change.old ? 'renamed' : 'modified',
    patch: patch.slice(0, MAX_PATCH_LINES).join('\n'),
    truncated: patch.length > MAX_PATCH_LINES,
  }
}

// The last `limit` commits on HEAD's first-parent line, oldest first, each diffed against its
// parent. A shallow clone's missing parents end the walk early.
async function readHistory(git, limit, onProgress) {
  const chain = []
  let sha = git.head
  while (sha && chain.length < limit) {
    let commit
    try {
      commit = await git.commit(sha)
    } catch {
      break
    }
    chain.push({ sha, ...commit })
    sha = commit.parents[0] ?? null
  }
  chain.reverse()

  const parentTree = async (c) => {
    try {
      return c.parents[0] ? (await git.commit(c.parents[0])).tree : null
    } catch {
      return null
    }
  }
  const commits = []
  for (const [i, c] of chain.entries()) {
    const changes = pairRenames(await diffTrees(git, await parentTree(c), c.tree))
    commits.push({
      sha: c.sha,
      short: c.sha.slice(0, 7),
      author: c.author,
      date: c.date,
      subject: c.subject,
      files: await pool(changes, 8, (change) => toCommitFile(git, change)),
    })
    onProgress('commit diffs', i + 1, chain.length)
  }
  return { commits, truncated: !!chain[0]?.parents.length }
}

async function flattenTree(git, sha, prefix = '', out = new Map()) {
  for (const entry of await git.tree(sha)) {
    if (entry.mode === TREE_MODE) await flattenTree(git, entry.sha, `${prefix}${entry.name}/`, out)
    else if (entry.mode !== GITLINK_MODE) out.set(prefix + entry.name, entry.sha)
  }
  return out
}

// Working-tree state of one file against HEAD, like `git status`: untracked, clean, or modified
// with the changed lines. Files over MAX_HASH_BYTES are assumed clean; unreadable ones (a broken
// symlink) come back null. Text is only kept for files small enough to show.
async function readWorkingFile(folder, git, headFiles, path) {
  const file = await folder.file(path)
  if (!file) return null
  const bytes = file.size <= MAX_HASH_BYTES ? new Uint8Array(await file.arrayBuffer()) : null
  const shown = file.size <= (DATA_EXT.test(path) ? MAX_DATA_BYTES : MAX_TEXT_BYTES)
  const text = bytes && shown ? asText(bytes) : null
  const entry = { path, bytes: file.size, text, tracked: headFiles.has(path), status: 'untracked', dirtyLines: [] }
  if (!entry.tracked) return entry

  entry.status = 'clean'
  if (!bytes || (await blobSha(bytes)) === headFiles.get(path)) return entry
  entry.status = 'modified'
  const before = await blobText(git, headFiles.get(path))
  if (text !== null && before !== null) entry.dirtyLines = lineDiff(before, text).lines
  return entry
}

export async function loadLocal(folder, { commitLimit = 50, onProgress = () => {} } = {}) {
  onProgress('reading .git', 0, 1)
  const git = await openGit(folder)
  const head = git?.head ? git : null
  const { commits, truncated } = head ? await readHistory(head, commitLimit, onProgress) : { commits: [], truncated: false }
  const headFiles = head ? await flattenTree(head, (await head.commit(head.head)).tree) : new Map()

  onProgress('listing files', 0, 1)
  const paths = await listFiles(folder, headFiles)
  if (!paths.length) throw new LocalError(`${folder.name} has no files to map (everything is ignored or empty).`)
  const kept = paths.slice(0, MAX_TREE_FILES)
  let read = 0
  const working = await pool(kept, 8, async (path) => {
    const entry = await readWorkingFile(folder, head, headFiles, path)
    onProgress('reading files', ++read, kept.length)
    return entry
  })

  const resolver = buildResolver(kept)
  const touched = new Map()
  const authors = new Map()
  commits.forEach((c, idx) =>
    c.files.forEach((f) => {
      if (!touched.has(f.path)) touched.set(f.path, [])
      touched.get(f.path).push(idx)
      if (!authors.has(f.path)) authors.set(f.path, new Set())
      authors.get(f.path).add(c.author)
    }),
  )

  const files = working.filter(Boolean).map((w) => {
    const lang = langOf(w.path)
    return {
      ...w,
      lang,
      loc: countLines(w.text),
      binary: w.text === null,
      symbols: w.text && parsesSymbols(lang) ? extractSymbols(w.text, lang) : [],
      imports: w.text ? extractImports(w.text, lang, w.path, resolver) : [],
      commits: touched.get(w.path) ?? [],
      added: 0,
      deleted: 0,
      authors: [...(authors.get(w.path) ?? [])].sort(),
      blame: [],
    }
  })

  return {
    repo: folder.name,
    head: head ? head.head.slice(0, 7) : '—',
    branch: git ? git.branch : 'no git history',
    generated: new Date().toISOString(),
    source: 'local',
    truncated,
    treeTruncated: paths.length > MAX_TREE_FILES,
    commits,
    files,
  }
}
