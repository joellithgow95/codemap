export const LANG_COLORS = {
  python: '#00f0ff',
  javascript: '#ffb000',
  typescript: '#4d9bff',
  html: '#ff6b2b',
  css: '#ff2bd6',
  yaml: '#39ff88',
  toml: '#8a5cff',
  markdown: '#bfefff',
  json: '#d0ff3b',
  shell: '#ff3b5c',
  sql: '#2bffd6',
  text: '#6a8a9a',
}

export function buildModel(data) {
  const alias = new Map()
  data.commits.forEach((c) => c.files.forEach((f) => f.old && alias.set(f.old, f.path)))
  const resolve = (path) => {
    for (let hops = 0; alias.has(path) && hops < 20; hops++) path = alias.get(path)
    return path
  }

  const entries = new Map()
  const ensure = (path) => {
    if (!entries.has(path)) {
      entries.set(path, { path, cur: null, events: [], deleted: false })
    }
    return entries.get(path)
  }
  data.files.forEach((f) => (ensure(f.path).cur = f))
  data.commits.forEach((c, idx) =>
    c.files.forEach((f) =>
      ensure(resolve(f.path)).events.push({ commit: idx, add: f.add, del: f.del, isNew: f.status === 'added', patch: f }),
    ),
  )

  const count = data.commits.length
  const files = [...entries.values()].map((e) => {
    e.deleted = !e.cur
    e.lang = e.cur?.lang ?? 'text'
    e.dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : ''
    e.name = e.path.slice(e.path.lastIndexOf('/') + 1)
    e.binary = !!e.cur && (e.cur.binary ?? e.cur.text === null)
    const added = e.events.find((ev) => ev.isNew)
    const fallback = data.truncated ? -1 : e.events.length ? e.events[0].commit : count
    e.firstCommit = added ? added.commit : fallback
    const delta = (k) => e.events.filter((ev) => ev.commit === k).reduce((s, ev) => s + ev.add - ev.del, 0)
    e.locAt = new Array(count + 1).fill(0)
    if (e.cur) {
      let loc = e.cur.loc
      e.locAt[count] = loc
      for (let k = count - 1; k >= 0; k--) {
        e.locAt[k] = Math.max(0, loc)
        loc -= delta(k)
      }
    } else {
      let running = 0
      for (let k = 0; k < count; k++) {
        running += delta(k)
        e.locAt[k] = Math.max(0, running)
      }
    }
    e.maxLoc = Math.max(1, ...e.locAt)
    return e
  })
  files.sort((a, b) => a.path.localeCompare(b.path))
  files.forEach((f, i) => (f.index = i))
  return { data, files, count, commits: data.commits, byPath: new Map(files.map((f) => [f.path, f])) }
}

export function existsAt(f, k, count) {
  if (k >= count) return !!f.cur
  if (f.firstCommit > k) return false
  return f.locAt[k] > 0 || f.binary
}

export function stateAt(f, k, count) {
  if (k >= count) {
    if (!f.cur) return 'gone'
    return f.cur.status === 'clean' ? 'clean' : f.cur.status
  }
  const hits = f.events.filter((ev) => ev.commit === k)
  if (!hits.length) return existsAt(f, k, count) ? 'clean' : 'gone'
  if (f.firstCommit === k) return 'added'
  return f.locAt[k] === 0 && !f.binary ? 'deleted' : 'modified'
}

export function locAt(f, k, count) {
  const loc = f.locAt[Math.min(k, count)]
  return f.binary ? 1 : loc
}

function weight(f) {
  return Math.pow(Math.max(f.maxLoc, 8), 0.7)
}

export function layoutCity(files) {
  const root = { name: '', children: new Map(), files: [] }
  files.forEach((f) => {
    let node = root
    f.dir
      .split('/')
      .filter(Boolean)
      .forEach((part) => {
        if (!node.children.has(part)) node.children.set(part, { name: part, children: new Map(), files: [] })
        node = node.children.get(part)
      })
    node.files.push(f)
  })

  const total = (node) =>
    node.files.reduce((s, f) => s + weight(f), 0) + [...node.children.values()].reduce((s, c) => s + total(c), 0)

  const districts = []
  const place = (node, path, x, z, w, d, depth) => {
    const items = [
      ...node.files.map((f) => ({ file: f, w: weight(f) })),
      ...[...node.children.values()].map((c) => ({ node: c, w: total(c) })),
    ].sort((a, b) => b.w - a.w)
    const sum = items.reduce((s, i) => s + i.w, 0) || 1
    if (path) districts.push({ path, name: node.name, x: x + w / 2, z: z + d / 2, w, d, depth })

    const pad = Math.min(1.1, Math.min(w, d) * 0.08)
    slice(items, sum, x + pad, z + pad, w - pad * 2, d - pad * 2, depth, path)
  }
  const slice = (items, sum, x, z, w, d, depth, path) => {
    if (!items.length) return
    if (items.length === 1) return cell(items[0], x, z, w, d, depth, path)
    const half = sum / 2
    let acc = 0
    let split = 0
    while (split < items.length - 1 && acc + items[split].w <= half) acc += items[split++].w
    split = Math.max(1, split)
    const left = items.slice(0, split)
    const right = items.slice(split)
    const leftSum = left.reduce((s, i) => s + i.w, 0)
    const ratio = leftSum / sum
    if (w >= d) {
      slice(left, leftSum, x, z, w * ratio, d, depth, path)
      slice(right, sum - leftSum, x + w * ratio, z, w * (1 - ratio), d, depth, path)
    } else {
      slice(left, leftSum, x, z, w, d * ratio, depth, path)
      slice(right, sum - leftSum, x, z + d * ratio, w, d * (1 - ratio), depth, path)
    }
  }
  const cell = (item, x, z, w, d, depth, path) => {
    if (item.file) {
      item.file.pos = { x: x + w / 2, z: z + d / 2, w: Math.max(0.5, w * 0.78), d: Math.max(0.5, d * 0.78) }
    } else {
      place(item.node, path ? `${path}/${item.node.name}` : item.node.name, x, z, w, d, depth + 1)
    }
  }

  const side = Math.max(48, Math.sqrt(total(root)) * 2.4)
  place(root, '', -side / 2, -side / 2, side, side, 0)
  return { districts, size: side }
}

export function layoutGraph(files) {
  let seed = 7
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5
  const nodes = files.map((f) => ({
    f,
    x: (f.pos?.x ?? 0) * 0.8 + rand() * 4,
    y: rand() * 20,
    z: (f.pos?.z ?? 0) * 0.8 + rand() * 4,
    vx: 0,
    vy: 0,
    vz: 0,
  }))
  const byPath = new Map(nodes.map((n) => [n.f.path, n]))
  const edges = files.flatMap((f) =>
    (f.cur?.imports ?? []).filter((p) => byPath.has(p)).map((p) => [byPath.get(f.path), byPath.get(p)]),
  )
  const degree = new Map()
  edges.forEach(([a, b]) => {
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
  })

  for (let iter = 0; iter < 400; iter++) {
    const cool = 1 - iter / 400
    nodes.forEach((a, i) => {
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]
        const dx = a.x - b.x
        const dy = a.y - b.y
        const dz = a.z - b.z
        const d2 = dx * dx + dy * dy + dz * dz + 0.5
        const force = 60 / d2
        const d = Math.sqrt(d2)
        a.vx += (dx / d) * force
        a.vy += (dy / d) * force
        a.vz += (dz / d) * force
        b.vx -= (dx / d) * force
        b.vy -= (dy / d) * force
        b.vz -= (dz / d) * force
      }
    })
    edges.forEach(([a, b]) => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dz = b.z - a.z
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01
      const pull = (d - 7) * 0.04
      a.vx += (dx / d) * pull
      a.vy += (dy / d) * pull
      a.vz += (dz / d) * pull
      b.vx -= (dx / d) * pull
      b.vy -= (dy / d) * pull
      b.vz -= (dz / d) * pull
    })
    nodes.forEach((n) => {
      const orphan = !degree.has(n)
      n.vx -= n.x * (orphan ? 0.05 : 0.004)
      n.vy -= n.y * 0.01
      n.vz -= n.z * (orphan ? 0.05 : 0.004)
      n.x += n.vx * 0.5 * cool
      n.y += n.vy * 0.5 * cool
      n.z += n.vz * 0.5 * cool
      n.vx *= 0.6
      n.vy *= 0.6
      n.vz *= 0.6
    })
  }
  nodes.forEach((n) => (n.f.graphPos = { x: n.x, y: n.y + 12, z: n.z }))
  return { edges: edges.map(([a, b]) => [a.f, b.f]) }
}
