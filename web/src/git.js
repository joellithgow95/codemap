// Read-only access to a repo's .git folder from the browser: HEAD, refs, loose objects and
// packfiles with their delta chains. Inflation uses the native DecompressionStream, so there are no
// dependencies and nothing leaves the tab. `folder` is a local.js folder: file(path), list(path).

const TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' }
const OFS_DELTA = 6
const REF_DELTA = 7
const IDX_MAGIC = 0xff744f63
const PACK_TRAILER_BYTES = 20
const CACHE_LIMIT = 256
export const TREE_MODE = '40000'
export const GITLINK_MODE = '160000'

const decoder = new TextDecoder()

export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16))

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function readText(folder, path) {
  const file = await folder.file(path)
  return file ? file.text() : null
}

function compareSha(table, at, sha) {
  for (let i = 0; i < 20; i++) {
    const diff = table[at + i] - sha[i]
    if (diff) return diff
  }
  return 0
}

// A pack is located through its v2 .idx: a fan-out table, the sorted object ids, then each
// object's offset. An object's bytes run from its offset to the next object's (or the trailer).
async function openPack(folder, base) {
  const idx = new Uint8Array(await (await folder.file(`${base}.idx`)).arrayBuffer())
  const pack = await folder.file(`${base}.pack`)
  const view = new DataView(idx.buffer)
  if (!pack || view.getUint32(0) !== IDX_MAGIC || view.getUint32(4) !== 2) return null

  const count = view.getUint32(8 + 255 * 4)
  const shaStart = 8 + 256 * 4
  const offsetStart = shaStart + count * 24
  const bigStart = offsetStart + count * 4
  const offsetAt = (i) => {
    const raw = view.getUint32(offsetStart + i * 4)
    if (!(raw & 0x80000000)) return raw
    const big = bigStart + (raw & 0x7fffffff) * 8
    return view.getUint32(big) * 2 ** 32 + view.getUint32(big + 4)
  }
  const sorted = Float64Array.from({ length: count }, (_, i) => offsetAt(i)).sort()

  const find = (sha) => {
    let lo = sha[0] ? view.getUint32(8 + (sha[0] - 1) * 4) : 0
    let hi = view.getUint32(8 + sha[0] * 4)
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const cmp = compareSha(idx, shaStart + mid * 20, sha)
      if (!cmp) return offsetAt(mid)
      if (cmp < 0) lo = mid + 1
      else hi = mid
    }
    return null
  }
  const endOf = (offset) => {
    let lo = 0
    let hi = count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid] <= offset) lo = mid + 1
      else hi = mid
    }
    return lo < count ? sorted[lo] : pack.size - PACK_TRAILER_BYTES
  }

  const rawAt = async (offset) => {
    const bytes = new Uint8Array(await pack.slice(offset, endOf(offset)).arrayBuffer())
    let i = 0
    let c = bytes[i++]
    const type = (c >> 4) & 7
    while (c & 0x80) c = bytes[i++]
    let base = null
    if (type === OFS_DELTA) {
      c = bytes[i++]
      let back = c & 0x7f
      while (c & 0x80) {
        c = bytes[i++]
        back = (back + 1) * 128 + (c & 0x7f)
      }
      base = { offset: offset - back }
    } else if (type === REF_DELTA) {
      base = { sha: toHex(bytes.subarray(i, i + 20)) }
      i += 20
    }
    return { type, base, data: await inflate(bytes.subarray(i)) }
  }
  return { find, rawAt }
}

// A delta is the target size, then copy-from-base and insert-literal instructions.
function applyDelta(base, delta) {
  let i = 0
  const varint = () => {
    let n = 0
    let scale = 1
    let c
    do {
      c = delta[i++]
      n += (c & 0x7f) * scale
      scale *= 128
    } while (c & 0x80)
    return n
  }
  varint()
  const out = new Uint8Array(varint())
  let o = 0
  while (i < delta.length) {
    const op = delta[i++]
    if (op & 0x80) {
      let offset = 0
      let size = 0
      for (let b = 0; b < 4; b++) if (op & (1 << b)) offset += delta[i++] * 2 ** (8 * b)
      for (let b = 0; b < 3; b++) if (op & (0x10 << b)) size += delta[i++] * 2 ** (8 * b)
      size ||= 0x10000
      out.set(base.subarray(offset, offset + size), o)
      o += size
    } else {
      out.set(delta.subarray(i, i + op), o)
      o += op
      i += op
    }
  }
  return out
}

async function resolveHead(folder) {
  const head = (await readText(folder, '.git/HEAD'))?.trim()
  if (!head) return null
  if (!head.startsWith('ref: ')) return { branch: '(detached)', sha: head }

  const ref = head.slice(5)
  const branch = ref.replace(/^refs\/heads\//, '')
  const loose = await readText(folder, `.git/${ref}`)
  if (loose) return { branch, sha: loose.trim() }
  const packed = (await readText(folder, '.git/packed-refs')) ?? ''
  const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`))
  return { branch, sha: line ? line.split(' ')[0] : null }
}

// Returns null when the folder has no readable .git: not a repo, or a worktree/submodule whose
// .git is a pointer file to a directory outside the folder that was picked.
export async function openGit(folder) {
  const head = await resolveHead(folder)
  if (!head) return null

  const packDir = '.git/objects/pack'
  const packNames = (await folder.list(packDir)).filter((e) => e.name.endsWith('.idx'))
  const packs = (await Promise.all(packNames.map((e) => openPack(folder, `${packDir}/${e.name.slice(0, -4)}`)))).filter(Boolean)

  const cache = new Map()
  const remember = (key, obj) => {
    cache.set(key, obj)
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
    return obj
  }

  const fromPack = async (pack, packIndex, offset) => {
    const key = `${packIndex}:${offset}`
    if (cache.has(key)) return cache.get(key)
    const raw = await pack.rawAt(offset)
    let obj
    if (raw.type === OFS_DELTA) {
      const base = await fromPack(pack, packIndex, raw.base.offset)
      obj = { type: base.type, data: applyDelta(base.data, raw.data) }
    } else if (raw.type === REF_DELTA) {
      const base = await read(raw.base.sha)
      obj = { type: base.type, data: applyDelta(base.data, raw.data) }
    } else {
      obj = { type: TYPES[raw.type], data: raw.data }
    }
    return remember(key, obj)
  }

  const read = async (sha) => {
    const id = fromHex(sha)
    for (const [packIndex, pack] of packs.entries()) {
      const offset = pack.find(id)
      if (offset !== null) return fromPack(pack, packIndex, offset)
    }
    if (cache.has(sha)) return cache.get(sha)
    const loose = await folder.file(`.git/objects/${sha.slice(0, 2)}/${sha.slice(2)}`)
    if (!loose) throw new Error(`git object ${sha} not found`)
    const data = await inflate(new Uint8Array(await loose.arrayBuffer()))
    const nul = data.indexOf(0)
    const type = decoder.decode(data.subarray(0, nul)).split(' ')[0]
    return remember(sha, { type, data: data.subarray(nul + 1) })
  }

  return {
    branch: head.branch,
    head: head.sha,
    read,
    commit: async (sha) => parseCommit((await read(sha)).data),
    tree: async (sha) => parseTree((await read(sha)).data),
  }
}

function parseCommit(data) {
  const text = decoder.decode(data)
  const split = text.indexOf('\n\n')
  const header = split < 0 ? text : text.slice(0, split)
  const lines = header.split('\n')
  const author = /^author (.*) <[^>]*> (\d+)/m.exec(header)
  return {
    tree: lines.find((l) => l.startsWith('tree ')).slice(5),
    parents: lines.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7)),
    author: author?.[1] ?? 'unknown',
    date: author ? new Date(Number(author[2]) * 1000).toISOString() : '',
    subject: split < 0 ? '' : text.slice(split + 2).split('\n')[0],
  }
}

function parseTree(data) {
  const entries = []
  let i = 0
  while (i < data.length) {
    const space = data.indexOf(0x20, i)
    const nul = data.indexOf(0, space)
    entries.push({
      mode: decoder.decode(data.subarray(i, space)),
      name: decoder.decode(data.subarray(space + 1, nul)),
      sha: toHex(data.subarray(nul + 1, nul + 21)),
    })
    i = nul + 21
  }
  return entries
}
