import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper.js'

import { LANG_COLORS, buildModel, existsAt, layoutCity, layoutGraph, locAt, stateAt } from './data.js'
import { highlightLines } from './highlight.js'
import { extractSymbols } from './parse.js'
import { GithubError, fetchText, loadGithub, parseRepoSpec } from './github.js'

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const VIEWS = [
  { id: 'city', label: 'CITY', hint: 'files as towers, folders as districts' },
  { id: 'graph', label: 'GRAPH', hint: 'import network in free space' },
  { id: 'strata', label: 'STRATA', hint: 'each tower built from its commits' },
]
const LENSES = [
  { id: 'change', label: 'CHANGE', hint: 'what the selected commit touched' },
  { id: 'language', label: 'LANGUAGE', hint: 'colour by language' },
  { id: 'churn', label: 'CHURN', hint: 'lines added + removed so far' },
  { id: 'age', label: 'AGE', hint: 'how recently each file moved' },
]
const STATE_COLORS = {
  added: '#39ff88',
  modified: '#ffb000',
  deleted: '#ff3b5c',
  untracked: '#39ff88',
  staged: '#e8fbff',
  clean: '#17607a',
  gone: '#000000',
}

const TOKEN_KEY = 'codemap.token'
const OAUTH_STATE_KEY = 'codemap.oauth-state'
const OAUTH_RETURN_KEY = 'codemap.oauth-return'
const TOKEN_ENDPOINT = '/.netlify/functions/github-token'
const OAUTH_CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID ?? ''
const OAUTH_SCOPE = import.meta.env.VITE_GITHUB_SCOPE ?? ''
let params = new URLSearchParams(location.search)

function showLoading(text, done = 0, total = 0) {
  $('loading').hidden = false
  $('loading-text').textContent = total ? `${text} ${done}/${total}` : text
  $('loading-bar').style.width = total ? `${(done / total) * 100}%` : '8%'
}

async function completeOAuth() {
  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) return
  const expected = sessionStorage.getItem(OAUTH_STATE_KEY)
  const returnSearch = sessionStorage.getItem(OAUTH_RETURN_KEY) ?? ''
  sessionStorage.removeItem(OAUTH_STATE_KEY)
  sessionStorage.removeItem(OAUTH_RETURN_KEY)
  history.replaceState(null, '', `${location.pathname}${returnSearch}`)
  params = new URLSearchParams(returnSearch)
  if (state !== expected) await stall('Sign-in could not be verified (state mismatch). Try again.')

  showLoading('signing in with GitHub')
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) await stall(`Sign-in failed: ${body.error ?? res.status}`)
  sessionStorage.setItem(TOKEN_KEY, body.access_token)
}

function startOAuth() {
  const state = crypto.randomUUID()
  sessionStorage.setItem(OAUTH_STATE_KEY, state)
  sessionStorage.setItem(OAUTH_RETURN_KEY, location.search)
  const url = new URL('https://github.com/login/oauth/authorize')
  url.searchParams.set('client_id', OAUTH_CLIENT_ID)
  url.searchParams.set('state', state)
  if (OAUTH_SCOPE) url.searchParams.set('scope', OAUTH_SCOPE)
  location.href = url.toString()
}

async function stall(message) {
  $('loading').hidden = false
  $('loading-text').innerHTML = `${esc(message)}<br><br><a class="chip" href="${location.pathname}">BACK</a>`
  $('loading-bar').style.width = '0%'
  await new Promise(() => {})
}

async function readManifest(url, base) {
  try {
    const res = await fetch(`${url}?t=${Date.now()}`)
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return []
    return (await res.json()).map((m) => ({ ...m, base }))
  } catch {
    return []
  }
}

async function loadSource() {
  const spec = params.get('gh')
  if (spec) {
    showLoading('connecting to GitHub')
    try {
      const { doc, ctx } = await loadGithub(parseRepoSpec(spec), {
        token,
        commitLimit: Number(params.get('n') ?? 50),
        onProgress: showLoading,
      })
      return { doc, ctx, name: `${doc.owner}/${doc.repo}`, manifest: await loadManifests() }
    } catch (error) {
      await stall(error instanceof GithubError ? error.message : `Load failed: ${error.message}`)
    }
  }
  const manifest = await loadManifests()
  if (!manifest.length) await stall('No maps found. Run `npm run scan -- <repo>` or load a GitHub repo from the menu.')
  const requested = params.get('repo')
  const entry = manifest.find((m) => m.name === requested) ?? manifest[0]
  showLoading(`loading ${entry.name}`)
  const doc = await (await fetch(`${entry.base}${entry.name}.json?t=${Date.now()}`)).json()
  return { doc, ctx: null, name: entry.name, manifest }
}

async function loadManifests() {
  const [local, demo] = await Promise.all([readManifest('/maps/manifest.json', '/maps/'), readManifest('/demo/manifest.json', '/demo/')])
  const names = new Set(local.map((m) => m.name))
  return [...local, ...demo.filter((m) => !names.has(m.name)).sort((a, b) => b.commits - a.commits)]
}

await completeOAuth()
const token = sessionStorage.getItem(TOKEN_KEY) ?? ''
const source = await loadSource()
const { manifest, ctx: ghCtx } = source
const repoName = source.name
const model = buildModel(source.doc)
$('loading').hidden = true
const { files, count, commits } = model
const remoteFetch = ghCtx
  ? async (cur) => {
      try {
        cur.text = await fetchText(ghCtx, { path: cur.path, sha: cur.sha })
        cur.loc = cur.text.split('\n').length - (cur.text.endsWith('\n') ? 1 : 0)
        cur.symbols = extractSymbols(cur.text, cur.lang)
      } catch {
        cur.binary = true
      }
    }
  : null
const state = {
  view: 'city',
  lens: 'change',
  k: model.data.files.some((f) => f.status !== 'clean') ? count : count - 1,
  selected: null,
  hovered: null,
  fly: false,
  playing: false,
  tab: 'code',
  // Folder the view is focused on ('' = repo root). Everything outside it is pushed apart and ghosted.
  focus: '',
  changedOnly: true,
  // Tree rows the user expanded or collapsed by hand; unlisted folders follow changedOnly.
  open: new Map(),
  // True when TOP switched to orthographic; orbiting away switches back to perspective.
  orthoAuto: false,
  // Looking straight down orthographically: left-drag pans like a map instead of orbiting.
  mapMode: false,
}

const city = layoutCity(files)
const graph = layoutGraph(files)
const districtByPath = new Map(city.districts.map((d) => [d.path, d]))
const treeByPath = new Map()
const indexTree = (node) => {
  treeByPath.set(node.path, node)
  node.children.forEach(indexTree)
}
indexTree(city.tree)

// How far the rest of the city slides away from the focused folder, and how far it is squashed.
const GHOST_HEIGHT = 0.3
const GHOST_OPACITY = 0.15
const focusGap = (d) => Math.max(4, Math.min(city.size * 0.15, Math.max(d.w, d.d) * 0.4))
const inFocus = (path) => !state.focus || path === state.focus || path.startsWith(`${state.focus}/`)

const towerHeight = (loc) => 0.4 + Math.pow(loc, 0.72) * 0.16
const nodeRadius = (loc) => 0.6 + Math.sqrt(loc) * 0.09
const stops = (t, list) => {
  const x = Math.min(0.999, Math.max(0, t)) * (list.length - 1)
  const i = Math.floor(x)
  return new THREE.Color(list[i]).lerp(new THREE.Color(list[i + 1]), x - i)
}
const commitColor = (i) => new THREE.Color().setHSL((0.52 + 0.46 * (i / Math.max(1, count - 1))) % 1, 1, 0.58)

const renderer = new THREE.WebGLRenderer({ canvas: $('scene'), antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
const scene = new THREE.Scene()
scene.background = new THREE.Color('#03060d')
scene.fog = new THREE.FogExp2('#03060d', 0.55 / city.size)
const perspCamera = new THREE.PerspectiveCamera(55, 1, 0.1, city.size * 8)
// The orthographic frustum is fixed; zoom does the scaling, the way OrbitControls dollies it.
const ORTHO_HALF = city.size * 0.6
const orthoCamera = new THREE.OrthographicCamera(-ORTHO_HALF, ORTHO_HALF, ORTHO_HALF, -ORTHO_HALF, 0.1, city.size * 8)
let camera = perspCamera
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.dampingFactor = 0.08
controls.zoomToCursor = true
// Orbit everywhere except the top-down map, which drags like MapControls: left pans, right rotates.
// OrbitControls also swaps left between rotate and pan while Shift/Ctrl/Cmd is held.
const ORBIT_BUTTONS = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
const MAP_BUTTONS = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }
const ORBIT_TOUCHES = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
const MAP_TOUCHES = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }
controls.mouseButtons = ORBIT_BUTTONS
controls.touches = ORBIT_TOUCHES

const viewHelper = new ViewHelper(camera, renderer.domElement)
viewHelper.setLabels('X', 'Y', 'Z')
// Set while the gizmo's own axis animation runs, so its end can be handled once.
let gizmoMoving = false

const composer = new EffectComposer(renderer)
const renderPass = new RenderPass(scene, camera)
composer.addPass(renderPass)
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 0.08)
composer.addPass(bloom)
composer.addPass(new OutputPass())

const labels = new CSS2DRenderer()
labels.domElement.style.cssText = 'position:fixed;inset:0;pointer-events:none'
document.body.appendChild(labels.domElement)

const floor = new THREE.GridHelper(city.size * 3, 90, 0x00f0ff, 0x0a3a4a)
floor.material.transparent = true
floor.material.opacity = 0.35
floor.position.y = -0.02
scene.add(floor)

const dust = (() => {
  const n = 600
  const pos = new Float32Array(n * 3).map(() => (Math.random() - 0.5) * city.size * 2.4)
  for (let i = 1; i < pos.length; i += 3) pos[i] = Math.random() * city.size * 0.9
  const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x1ac8ff, size: 0.12, transparent: true, opacity: 0.5 }))
  scene.add(pts)
  return pts
})()

const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)
const unitEdges = new THREE.EdgesGeometry(unitBox)
const octa = new THREE.OctahedronGeometry(1)
const octaEdges = new THREE.EdgesGeometry(octa)

const groups = {
  city: new THREE.Group(),
  graph: new THREE.Group(),
  strata: new THREE.Group(),
  links: new THREE.Group(),
}
Object.values(groups).forEach((g) => scene.add(g))

const tint = (file, material, kind) => file.mats.push({ material, kind })
const makeMaterials = () => ({
  edge: new THREE.LineBasicMaterial({ transparent: true }),
  fill: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.1, depthWrite: false }),
})

files.forEach((file) => {
  file.mats = []
  // off/squash animate the focus push-apart: x/z slide and a height multiplier for ghosted files.
  file.vis = { h: 0, target: 0, r: 0, rTarget: 0, node: new THREE.Vector3(), off: { x: 0, z: 0 }, squash: 1 }
  file.focus = { off: { x: 0, z: 0 }, squash: 1, ghost: false }

  const tower = new THREE.Group()
  const tm = makeMaterials()
  const fill = new THREE.Mesh(unitBox, tm.fill)
  const edges = new THREE.LineSegments(unitEdges, tm.edge)
  fill.userData.file = file
  tower.add(fill, edges)
  tower.position.set(file.pos.x, 0, file.pos.z)
  tint(file, tm.fill, 'fill')
  tint(file, tm.edge, 'edge')
  groups.city.add(tower)
  file.tower = { group: tower, pick: fill }

  const nm = makeMaterials()
  const nodeGroup = new THREE.Group()
  const nodeFill = new THREE.Mesh(octa, nm.fill)
  nodeFill.userData.file = file
  nodeGroup.add(nodeFill, new THREE.LineSegments(octaEdges, nm.edge))
  nodeGroup.position.set(file.graphPos.x, file.graphPos.y, file.graphPos.z)
  file.vis.node.copy(nodeGroup.position)
  tint(file, nm.fill, 'fill')
  tint(file, nm.edge, 'edge')
  groups.graph.add(nodeGroup)
  file.node = { group: nodeGroup, pick: nodeFill }

  const strata = new THREE.Group()
  strata.position.set(file.pos.x, 0, file.pos.z)
  let y = 0
  file.slabs = file.events.map((ev) => {
    const h = 0.2 + Math.sqrt(ev.add + ev.del) * 0.28
    const sm = makeMaterials()
    const slab = new THREE.Group()
    const fillMesh = new THREE.Mesh(unitBox, sm.fill)
    fillMesh.userData.file = file
    fillMesh.userData.commit = ev.commit
    slab.add(fillMesh, new THREE.LineSegments(unitEdges, sm.edge))
    slab.scale.set(file.pos.w, h, file.pos.d)
    slab.position.y = y
    y += h + 0.04
    strata.add(slab)
    return { ev, group: slab, pick: fillMesh, mats: sm }
  })
  groups.strata.add(strata)
  file.strata = { group: strata }
})

// Each district animates its box (vis) toward target: siblings slide, ancestors of the focus stretch.
city.districts.forEach((d) => {
  d.vis = { x: d.x, z: d.z, w: d.w, d: d.d }
  d.target = { ...d.vis }
})

const districtLabels = city.districts.map((d) => {
  const el = document.createElement('div')
  el.className = 'label dir'
  el.textContent = d.depth === 1 ? `/${d.name}` : d.name
  el.title = `focus ${d.path}`
  el.addEventListener('click', () => setFocus(d.path))
  el.addEventListener('mouseenter', () => highlightDistrict(d.path))
  el.addEventListener('mouseleave', () => highlightDistrict(null))
  const obj = new CSS2DObject(el)
  scene.add(obj)
  d.label = el
  return { obj, district: d }
})

const unitOutline = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2))
const floorOutlines = new THREE.Group()
city.districts.forEach((d) => {
  const base = new THREE.Color(d.depth === 1 ? 0xff2bd6 : 0x0f6a80)
  const mat = new THREE.LineBasicMaterial({ color: base, transparent: true, opacity: 0.8 })
  const line = new THREE.LineSegments(unitOutline, mat)
  floorOutlines.add(line)
  d.outline = { line, mat, base }
})
scene.add(floorOutlines)

const graphEdges = (() => {
  const positions = new Float32Array(graph.edges.length * 6)
  const colors = new Float32Array(graph.edges.length * 6)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 }))
  groups.graph.add(lines)
  return { lines, positions, colors }
})()

const beam = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 60, 0)]),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }),
)
beam.visible = false
scene.add(beam)

const selLabelEl = document.createElement('div')
selLabelEl.className = 'label sel'
const selLabel = new CSS2DObject(selLabelEl)
selLabel.visible = false
scene.add(selLabel)

const currentPosition = (file) => {
  if (state.view === 'graph') return file.vis.node.clone()
  const h = state.view === 'strata' ? file.strata.group.userData.height ?? 0 : file.vis.h
  return new THREE.Vector3(file.pos.x + file.vis.off.x, h * file.vis.squash, file.pos.z + file.vis.off.z)
}

function lensColor(file, k) {
  const st = stateAt(file, k, count)
  if (state.lens === 'change') return new THREE.Color(STATE_COLORS[st])
  if (state.lens === 'language') return new THREE.Color(LANG_COLORS[file.lang] ?? LANG_COLORS.text)
  if (state.lens === 'churn') {
    const done = file.events.filter((e) => e.commit <= Math.min(k, count - 1))
    const churn = done.reduce((s, e) => s + e.add + e.del, 0)
    return stops(Math.log1p(churn) / Math.log1p(maxChurn), ['#0a5a70', '#00f0ff', '#ff2bd6', '#ffb000', '#ffffff'])
  }
  const last = file.events.filter((e) => e.commit <= Math.min(k, count - 1)).at(-1)
  const age = last ? Math.min(k, count - 1) - last.commit : count
  return stops(1 - Math.min(1, age / Math.max(1, count - 1)), ['#12334a', '#4d9bff', '#00f0ff', '#ffb000', '#ffffff'])
}
const maxChurn = Math.max(1, ...files.map((f) => f.events.reduce((s, e) => s + e.add + e.del, 0)))

function applyState() {
  const k = state.k
  computeFocus()
  files.forEach((file) => {
    const st = stateAt(file, k, count)
    const exists = existsAt(file, k, count) || st === 'deleted'
    const loc = st === 'deleted' ? file.locAt[Math.max(0, k - 1)] : locAt(file, k, count)
    file.st = st
    file.exists = exists
    file.vis.target = exists ? towerHeight(Math.max(loc, 1)) : 0
    file.vis.rTarget = exists ? nodeRadius(Math.max(loc, 1)) : 0
    file.color = lensColor(file, k)
    const lit = state.lens !== 'change' || st !== 'clean'
    file.lit = lit
    const ghost = file.focus.ghost ? GHOST_OPACITY : 1
    file.mats.forEach(({ material, kind }) => {
      material.color.copy(file.color)
      material.userData.base = (kind === 'fill' ? (lit ? 0.16 : 0.05) : lit ? 1 : 0.55) * ghost
    })
    file.slabs.forEach((slab) => {
      const shown = slab.ev.commit <= Math.min(k, count - 1)
      slab.group.visible = shown && state.view === 'strata'
      const hot = slab.ev.commit === k
      const color = commitColor(slab.ev.commit)
      slab.mats.edge.color.copy(hot ? new THREE.Color('#ffffff') : color)
      slab.mats.fill.color.copy(color)
      slab.mats.fill.opacity = (hot ? 0.45 : 0.14) * ghost
      slab.mats.edge.opacity = (hot ? 1 : 0.75) * ghost
    })
    const shownSlabs = file.slabs.filter((s) => s.ev.commit <= Math.min(k, count - 1))
    file.strata.group.userData.height = shownSlabs.reduce((s, sl) => s + sl.group.scale.y + 0.04, 0)
  })
  updateGraphEdges()
  refreshHud()
  refreshSelection()
}

function updateGraphEdges() {
  const { positions, colors, lines } = graphEdges
  graph.edges.forEach(([from, to], i) => {
    const visible = from.exists && to.exists
    const a = from.vis.node
    const b = to.vis.node
    const hot = from.lit && to.lit && state.lens === 'change'
    positions.set(visible ? [a.x, a.y, a.z, b.x, b.y, b.z] : [0, -999, 0, 0, -999, 0], i * 6)
    const from_c = hot ? [1, 0.7, 0] : [0.0, 0.25, 0.4]
    const to_c = hot ? [1, 1, 1] : [0.0, 0.94, 1]
    const dim = from.focus.ghost || to.focus.ghost ? GHOST_OPACITY : 1
    colors.set([...from_c, ...to_c].map((c) => c * dim), i * 6)
  })
  lines.geometry.attributes.position.needsUpdate = true
  lines.geometry.attributes.color.needsUpdate = true
}

function rebuildLinks() {
  // Rebuilt every frame while the focus layout is moving, so free the old arcs' geometry.
  groups.links.children.forEach((line) => {
    line.geometry.dispose()
    line.material.dispose()
  })
  groups.links.clear()
  const file = state.selected
  if (!file?.cur) return
  const arc = (a, b, color) => {
    const mid = a.clone().lerp(b, 0.5)
    mid.y += 3 + a.distanceTo(b) * 0.25
    const pts = new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(32)
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }),
    )
    groups.links.add(line)
  }
  const from = currentPosition(file)
  file.cur.imports.forEach((p) => {
    const other = model.byPath.get(p)
    if (other?.exists) arc(from, currentPosition(other), 0x00f0ff)
  })
  files
    .filter((f) => f.cur?.imports.includes(file.path) && f.exists)
    .forEach((f) => arc(currentPosition(f), from, 0xff2bd6))
}

function refreshSelection() {
  const file = state.selected
  beam.visible = selLabel.visible = !!file
  if (!file) return rebuildLinks()
  const p = currentPosition(file)
  beam.position.set(p.x, 0, p.z)
  if (state.view === 'graph') beam.position.y = p.y
  else beam.position.y = 0
  selLabel.position.set(p.x, p.y + 1.2, p.z)
  selLabelEl.textContent = file.path
  rebuildLinks()
}

function setView(id) {
  state.view = id
  groups.city.visible = id === 'city'
  groups.graph.visible = id === 'graph'
  groups.strata.visible = id === 'strata'
  floorOutlines.visible = id !== 'graph'
  floor.visible = id !== 'graph'
  buildButtons()
  applyState()
  frameView()
}

function setLens(id) {
  state.lens = id
  buildButtons()
  applyState()
}

function setCommit(k) {
  state.k = Math.max(0, Math.min(count, k))
  $('timeline').value = state.k
  applyState()
  if (state.selected && state.tab !== 'code') renderPanel()
}

// Directions from the target toward the camera. TOP leans a hair toward +z so OrbitControls keeps
// north up instead of hitting its straight-down singularity.
const PRESETS = {
  top: new THREE.Vector3(0, 1, 0.0001).normalize(),
  iso: new THREE.Vector3(0.9, 0.8, 1.0).normalize(),
  front: new THREE.Vector3(0, 0.35, 1).normalize(),
  side: new THREE.Vector3(1, 0.35, 0).normalize(),
}

let tween = null
// Swings the camera around the moving target (direction slerps, distance lerps) rather than
// cutting a straight line through the city, which matters most going to and from TOP.
function flyTo(position, target, { seconds = 0.9, zoom = camera.zoom, onDone = null } = {}) {
  const fromOffset = camera.position.clone().sub(controls.target)
  const toOffset = position.clone().sub(target)
  const toDir = toOffset.clone().normalize()
  const fromDir = fromOffset.lengthSq() > 1e-9 ? fromOffset.clone().normalize() : toDir
  tween = {
    t: 0,
    seconds,
    fromTarget: controls.target.clone(),
    toTarget: target,
    fromDir,
    turn: new THREE.Quaternion().setFromUnitVectors(fromDir, toDir),
    fromDist: fromOffset.length(),
    toDist: toOffset.length(),
    fromZoom: camera.zoom,
    toZoom: zoom,
    onDone,
  }
}

function stepTween(dt) {
  tween.t = Math.min(1, tween.t + dt / tween.seconds)
  const e = 1 - Math.pow(1 - tween.t, 3)
  controls.target.lerpVectors(tween.fromTarget, tween.toTarget, e)
  const dir = tween.fromDir.clone().applyQuaternion(new THREE.Quaternion().slerp(tween.turn, e))
  const dist = THREE.MathUtils.lerp(tween.fromDist, tween.toDist, e)
  camera.position.copy(controls.target).addScaledVector(dir, dist)
  if (camera.isOrthographicCamera) {
    camera.zoom = THREE.MathUtils.lerp(tween.fromZoom, tween.toZoom, e)
    camera.updateProjectionMatrix()
  }
  if (tween.t < 1) return
  const done = tween.onDone
  tween = null
  done?.()
}

const viewDir = () => camera.position.clone().sub(controls.target).normalize()

// Camera placement that fits box when looking along dir (target -> camera) with the current camera.
function fitView(box, dir, margin = 1.12) {
  const center = box.getCenter(new THREE.Vector3())
  const up0 = Math.abs(dir.y) > 0.99 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0)
  const right = new THREE.Vector3().crossVectors(up0, dir).normalize()
  const up = new THREE.Vector3().crossVectors(dir, right)
  let halfW = 0
  let halfH = 0
  let depth = 0
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const v = new THREE.Vector3(x, y, z).sub(center)
        halfW = Math.max(halfW, Math.abs(v.dot(right)))
        halfH = Math.max(halfH, Math.abs(v.dot(up)))
        depth = Math.max(depth, v.dot(dir))
      }
  halfW = Math.max(halfW * margin, 1)
  halfH = Math.max(halfH * margin, 1)
  // Fit into the part of the screen the code panel doesn't cover.
  const aspect = (innerWidth - panelWidth()) / innerHeight
  if (camera.isOrthographicCamera) {
    // Distance only has to clear the tallest thing in the box; zoom sets the size.
    const zoom = Math.min((ORTHO_HALF * aspect) / halfW, ORTHO_HALF / halfH)
    return { position: center.clone().addScaledVector(dir, Math.max(city.size * 0.8, depth + 10)), target: center, zoom }
  }
  const tan = Math.tan(THREE.MathUtils.degToRad(perspCamera.fov / 2))
  const dist = depth + Math.max(halfH / tan, halfW / (tan * aspect))
  return { position: center.clone().addScaledVector(dir, dist), target: center, zoom: 1 }
}

// Height of a file as it will settle (not mid-animation), for framing.
const settledTop = (f) =>
  (state.view === 'strata' ? f.strata.group.userData.height ?? 0 : f.vis.target) * f.focus.squash

// What the camera presets frame: the focused folder, or the whole repo.
function scopeBox() {
  const scoped = files.filter((f) => f.exists && inFocus(f.path))
  const box = new THREE.Box3()
  if (state.view === 'graph') {
    scoped.forEach((f) => box.expandByPoint(new THREE.Vector3(f.graphPos.x, f.graphPos.y, f.graphPos.z)))
    if (box.isEmpty()) files.forEach((f) => box.expandByPoint(new THREE.Vector3(f.graphPos.x, f.graphPos.y, f.graphPos.z)))
    return box.expandByScalar(2)
  }
  const d = districtByPath.get(state.focus)
  const half = city.size / 2
  box.min.set(d ? d.x - d.w / 2 : -half, 0, d ? d.z - d.d / 2 : -half)
  box.max.set(d ? d.x + d.w / 2 : half, 1, d ? d.z + d.d / 2 : half)
  scoped.forEach((f) => (box.max.y = Math.max(box.max.y, settledTop(f))))
  return box
}

function fileBox(file) {
  if (state.view === 'graph') {
    const p = file.vis.node
    return new THREE.Box3().setFromCenterAndSize(p, new THREE.Vector3(10, 10, 10))
  }
  const x = file.pos.x + file.focus.off.x
  const z = file.pos.z + file.focus.off.z
  return new THREE.Box3(new THREE.Vector3(x - 5, 0, z - 5), new THREE.Vector3(x + 5, Math.max(4, settledTop(file)), z + 5))
}

function flyToFit(box, dir, opts = {}) {
  const { position, target, zoom } = fitView(box, dir)
  flyTo(position, target, { zoom, ...opts })
}

function viewFrom(name) {
  if (state.fly) setFly(false)
  if (state.orthoAuto && name !== 'top') setOrtho(false)
  const toOrtho = name === 'top' && !camera.isOrthographicCamera
  // Fly in perspective, then flatten once looking straight down: the swap keeps the framing.
  flyToFit(scopeBox(), PRESETS[name], { onDone: toOrtho ? () => setOrtho(true, { auto: true }) : null })
}

function frameView() {
  flyToFit(scopeBox(), viewDir())
}

function frameSelection() {
  if (state.fly) setFly(false)
  if (state.selected) focusFile(state.selected)
  else frameView()
}

function focusFile(file) {
  flyToFit(fileBox(file), viewDir())
}

function resetView() {
  setFocus('', { frame: false })
  if (camera.isOrthographicCamera) setOrtho(false)
  viewFrom('iso')
}

// Swap between the perspective and orthographic cameras without the picture jumping: the
// visible height at the orbit target is kept.
function setOrtho(on, { auto = false } = {}) {
  state.orthoAuto = on && auto
  $('cam-ortho').classList.toggle('active', on)
  if (on === camera.isOrthographicCamera) return
  if (on && state.fly) setFly(false)
  const target = controls.target
  const offset = camera.position.clone().sub(target)
  const dir = offset.clone().normalize()
  const tan = Math.tan(THREE.MathUtils.degToRad(perspCamera.fov / 2))
  const next = on ? orthoCamera : perspCamera
  if (on) {
    orthoCamera.zoom = ORTHO_HALF / Math.max(0.5, offset.length() * tan)
    orthoCamera.position.copy(target).addScaledVector(dir, Math.max(offset.length(), city.size * 0.8))
  } else {
    perspCamera.position.copy(target).addScaledVector(dir, ORTHO_HALF / orthoCamera.zoom / tan)
  }
  next.quaternion.copy(camera.quaternion)
  next.updateProjectionMatrix()
  camera = next
  controls.object = camera
  renderPass.camera = camera
  viewHelper.camera = camera
  controls.update()
}

const idleCursor = () => (state.mapMode ? 'grab' : 'default')

function setMapMode(on) {
  state.mapMode = on
  controls.mouseButtons = on ? MAP_BUTTONS : ORBIT_BUTTONS
  controls.touches = on ? MAP_TOUCHES : ORBIT_TOUCHES
  $('cam-hint').innerHTML = on ? 'drag <b>pan</b> · right-drag <b>rotate</b>' : 'drag <b>orbit</b> · right-drag <b>pan</b>'
  if (!mouse.down) renderer.domElement.style.cursor = state.hovered ? 'pointer' : idleCursor()
}

// Rigid block that a path moves with when the focus pushes things apart: the child of the deepest
// folder it shares with the focus. Moving whole sibling folders keeps each one intact.
function blockRect(path) {
  const focusParts = state.focus.split('/')
  const parts = path.split('/')
  let i = 0
  while (i < focusParts.length && parts[i] === focusParts[i]) i++
  const block = parts.slice(0, i + 1).join('/')
  const d = districtByPath.get(block)
  if (d) return rectOf(d)
  const f = model.byPath.get(block).pos
  return { minX: f.x - f.w / 2, maxX: f.x + f.w / 2, minZ: f.z - f.d / 2, maxZ: f.z + f.d / 2 }
}

const rectOf = (d) => ({ minX: d.x - d.w / 2, maxX: d.x + d.w / 2, minZ: d.z - d.d / 2, maxZ: d.z + d.d / 2 })

// Opens a gap around the focus box: anything wholly to one side slides that way by gap. The shift
// only depends on which side a block sits, so blocks that didn't overlap still don't.
const EPS = 1e-6
function shiftOf(r, box, gap) {
  return {
    x: r.minX >= box.maxX - EPS ? gap : r.maxX <= box.minX + EPS ? -gap : 0,
    z: r.minZ >= box.maxZ - EPS ? gap : r.maxZ <= box.minZ + EPS ? -gap : 0,
  }
}

function districtTarget(d, focused) {
  if (!focused || inFocus(d.path)) return { x: d.x, z: d.z, w: d.w, d: d.d }
  const box = rectOf(focused)
  const gap = focusGap(focused)
  if (state.focus.startsWith(`${d.path}/`)) {
    // An ancestor of the focus holds blocks on several sides, so it stretches instead of moving.
    const r = rectOf(d)
    const minX = r.minX - (r.minX < box.minX - EPS ? gap : 0)
    const maxX = r.maxX + (r.maxX > box.maxX + EPS ? gap : 0)
    const minZ = r.minZ - (r.minZ < box.minZ - EPS ? gap : 0)
    const maxZ = r.maxZ + (r.maxZ > box.maxZ + EPS ? gap : 0)
    return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, w: maxX - minX, d: maxZ - minZ }
  }
  const s = shiftOf(blockRect(d.path), box, gap)
  return { x: d.x + s.x, z: d.z + s.z, w: d.w, d: d.d }
}

function computeFocus() {
  const focused = districtByPath.get(state.focus) ?? null
  // In the graph there is no layout to push apart; keep the focus's direct imports lit instead.
  const near = new Set()
  if (state.view === 'graph' && focused)
    graph.edges.forEach(([a, b]) => {
      if (inFocus(a.path)) near.add(b)
      if (inFocus(b.path)) near.add(a)
    })
  files.forEach((f) => {
    const inside = inFocus(f.path)
    f.focus.ghost = !inside && !near.has(f)
    f.focus.squash = inside ? 1 : GHOST_HEIGHT
    f.focus.off = inside || !focused ? { x: 0, z: 0 } : shiftOf(blockRect(f.path), rectOf(focused), focusGap(focused))
  })
  city.districts.forEach((d) => (d.target = districtTarget(d, focused)))
}

function setFocus(path, { frame = true } = {}) {
  state.focus = path
  applyState()
  if (frame) frameView()
}

function focusUp() {
  if (!state.focus) return
  setFocus(state.focus.includes('/') ? state.focus.slice(0, state.focus.lastIndexOf('/')) : '')
}

let hotDistrict = null
function highlightDistrict(path) {
  hotDistrict = path ? districtByPath.get(path) ?? null : null
}

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
function pickables() {
  if (state.view === 'city') return files.filter((f) => f.exists).map((f) => f.tower.pick)
  if (state.view === 'graph') return files.filter((f) => f.exists).map((f) => f.node.pick)
  return files.flatMap((f) => f.slabs.filter((s) => s.group.visible).map((s) => s.pick))
}

function pickAt(x, y) {
  pointer.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1)
  raycaster.setFromCamera(pointer, camera)
  groups.city.updateMatrixWorld(true)
  groups.graph.updateMatrixWorld(true)
  groups.strata.updateMatrixWorld(true)
  return raycaster.intersectObjects(pickables(), false)[0]?.object.userData.file ?? null
}

function select(file, { focus = false } = {}) {
  state.selected = file
  if (file) {
    renderPanel()
    $('panel').classList.remove('closed')
    document.body.classList.add('panel-open')
    if (focus) focusFile(file)
  } else {
    $('panel').classList.add('closed')
    document.body.classList.remove('panel-open')
  }
  refreshSelection()
  renderTree()
}

function fmtTooltip(file) {
  const st = file.st
  const last = file.events.at(-1)
  const lastCommit = last ? commits[last.commit] : null
  return `<div class="p">${esc(file.path)}</div>
    <div>${file.lang} · ${locAt(file, state.k, count)} lines · ${file.events.length} commits</div>
    <div class="${st === 'clean' ? 'dim' : st === 'deleted' ? 'del' : st === 'modified' ? 'mod' : 'add'}">${st.toUpperCase()}</div>
    ${lastCommit ? `<div class="dim">last: ${lastCommit.short} ${esc(lastCommit.subject)}</div>` : ''}`
}

const mouse = { x: 0, y: 0, down: null, moved: false }
renderer.domElement.addEventListener('pointerdown', (e) => {
  mouse.down = { x: e.clientX, y: e.clientY }
  if (state.mapMode && e.button === 0) renderer.domElement.style.cursor = 'grabbing'
})
renderer.domElement.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX
  mouse.y = e.clientY
})
renderer.domElement.addEventListener('pointerup', (e) => {
  const d = mouse.down
  mouse.down = null
  renderer.domElement.style.cursor = state.hovered ? 'pointer' : idleCursor()
  if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return
  if (state.fly) {
    select(pickAt(innerWidth / 2, innerHeight / 2))
    return
  }
  if (overGizmo(e)) {
    // An axis click takes over from any camera flight still in progress.
    if (viewHelper.handleClick(e)) tween = null
    return
  }
  select(pickAt(e.clientX, e.clientY))
})
// First double-click focuses the file's folder; once that folder is focused it flies to the file.
renderer.domElement.addEventListener('dblclick', (e) => {
  if (overGizmo(e)) return
  const file = pickAt(e.clientX, e.clientY)
  if (!file) return
  if (state.view !== 'graph' && file.dir && file.dir !== state.focus) {
    select(file)
    setFocus(file.dir)
  } else select(file, { focus: true })
})

function overGizmo(e) {
  const r = $('gizmo').getBoundingClientRect()
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
}

let hoverTimer = 0
function updateHover(dt) {
  hoverTimer -= dt
  if (hoverTimer > 0 || mouse.down || $('menu').hidden === false) return
  hoverTimer = 0.05
  const at = state.fly ? [innerWidth / 2, innerHeight / 2] : [mouse.x, mouse.y]
  const file = pickAt(at[0], at[1])
  if (file !== state.hovered) {
    state.hovered = file
    renderer.domElement.style.cursor = file ? 'pointer' : idleCursor()
  }
  const tip = $('tooltip')
  tip.hidden = !file
  if (file) {
    tip.innerHTML = fmtTooltip(file)
    tip.style.left = `${Math.min(at[0] + 16, innerWidth - 380)}px`
    tip.style.top = `${Math.min(at[1] + 16, innerHeight - 120)}px`
  }
}

const keys = new Set()
const flyState = { yaw: 0, pitch: 0 }
function setFly(on) {
  if (on && camera.isOrthographicCamera) setOrtho(false)
  state.fly = on
  $('fly-toggle').classList.toggle('active', on)
  $('crosshair').hidden = !on
  controls.enabled = !on
  if (on) {
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ')
    flyState.yaw = e.y
    flyState.pitch = e.x
    renderer.domElement.requestPointerLock()
  } else {
    if (document.pointerLockElement) document.exitPointerLock()
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    controls.target.copy(camera.position).add(forward.multiplyScalar(25))
    controls.update()
  }
}
document.addEventListener('pointerlockchange', () => {
  if (state.fly && !document.pointerLockElement) setFly(false)
})
document.addEventListener('mousemove', (e) => {
  if (!state.fly || !document.pointerLockElement) return
  flyState.yaw -= e.movementX * 0.0022
  flyState.pitch = Math.max(-1.5, Math.min(1.5, flyState.pitch - e.movementY * 0.0022))
  camera.quaternion.setFromEuler(new THREE.Euler(flyState.pitch, flyState.yaw, 0, 'YXZ'))
})

function stepFly(dt) {
  const speed = (keys.has('shift') ? 60 : 18) * dt
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
  const move = new THREE.Vector3()
  if (keys.has('w')) move.add(forward)
  if (keys.has('s')) move.sub(forward)
  if (keys.has('d')) move.add(right)
  if (keys.has('a')) move.sub(right)
  if (keys.has('e')) move.y += 1
  if (keys.has('q')) move.y -= 1
  camera.position.addScaledVector(move, speed)
}

function buildButtons() {
  const make = (list, active) =>
    list
      .map((o) => `<button class="chip ${o.id === active ? 'active' : ''}" data-id="${o.id}" title="${o.hint}">${o.label}</button>`)
      .join('')
  const wire = (el, onPick) => el.querySelectorAll('button').forEach((b) => (b.onclick = () => onPick(b.dataset.id)))
  ;[
    [$('view-buttons'), VIEWS, state.view, setView],
    [$('lens-buttons'), LENSES, state.lens, setLens],
  ].forEach(([el, list, active, onPick]) => {
    el.innerHTML = make(list, active)
    wire(el, onPick)
  })
}

function refreshHud() {
  const k = state.k
  const dirty = files.filter((f) => f.cur && f.cur.status !== 'clean').length
  const historyNote = model.data.truncated ? ` · last ${count} commits` : ''
  const treeNote = model.data.treeTruncated ? ' · tree truncated' : ''
  $('repo-meta').textContent = `${model.data.repo} @ ${model.data.branch} · ${model.data.head} · ${files.length} files${historyNote}${treeNote}${dirty ? ` · ${dirty} dirty` : ''}`

  const info = $('commit-info')
  if (k >= count) {
    info.innerHTML = `<b>WORKTREE</b> uncommitted changes vs HEAD — ${dirty} file${dirty === 1 ? '' : 's'}`
  } else {
    const c = commits[k]
    const add = c.files.reduce((s, f) => s + f.add, 0)
    const del = c.files.reduce((s, f) => s + f.del, 0)
    info.innerHTML = `<b>${c.short}</b> ${esc(c.subject)} <span class="dim">— ${esc(c.author)} ${c.date.slice(0, 10)} · ${c.files.length} files <span class="add">+${add}</span> <span class="del">−${del}</span></span>`
  }
  renderTree()
  renderLegend()
}

const CHANGE_TAGS = { added: '+', untracked: '?', modified: '~', staged: '●', deleted: '−' }
const CHANGE_CLASSES = { added: 'add', untracked: 'new', modified: 'mod', staged: 'add', deleted: 'del' }
const isChanged = (f) => f.st in CHANGE_TAGS
const isOpen = (path) => state.open.get(path) ?? state.changedOnly

// Folder tree rooted at the focused folder. Each folder row rolls up what changed beneath it at the
// current commit; clicking its name focuses it, the caret only expands it.
function renderTree() {
  const k = state.k
  const tally = new Map()
  const countNode = (node) => {
    const t = { add: 0, mod: 0, del: 0, files: 0 }
    node.files.forEach((f) => {
      if (!f.exists) return
      t.files++
      if (f.st === 'added' || f.st === 'untracked') t.add++
      else if (f.st === 'modified' || f.st === 'staged') t.mod++
      else if (f.st === 'deleted') t.del++
    })
    node.children.forEach((child) => {
      const c = countNode(child)
      t.add += c.add
      t.mod += c.mod
      t.del += c.del
      t.files += c.files
    })
    tally.set(node.path, t)
    return t
  }
  const root = treeByPath.get(state.focus) ?? city.tree
  const total = countNode(root)
  const changed = total.add + total.mod + total.del

  const rows = []
  const walk = (node, depth) => {
    ;[...node.children.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((child) => {
        const t = tally.get(child.path)
        if (!t.files || (state.changedOnly && !(t.add + t.mod + t.del))) return
        const open = isOpen(child.path)
        const badges = [t.add && `<span class="add">+${t.add}</span>`, t.mod && `<span class="mod">~${t.mod}</span>`, t.del && `<span class="del">−${t.del}</span>`]
          .filter(Boolean)
          .join(' ')
        rows.push(
          `<div class="tree-row dir" data-dir="${esc(child.path)}" style="--depth:${depth}"><span class="caret" data-toggle="${esc(child.path)}">${open ? '▾' : '▸'}</span><span class="nm">${esc(child.name)}/</span><span class="dl">${badges || `<span class="dim">${t.files}</span>`}</span></div>`,
        )
        if (open) walk(child, depth + 1)
      })
    node.files
      .filter((f) => f.exists && (!state.changedOnly || isChanged(f)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((f) => {
        const ev = f.events.find((e) => e.commit === k)
        const delta = ev ? `<span class="add">+${ev.add}</span> <span class="del">−${ev.del}</span>` : ''
        const sel = f === state.selected ? ' sel' : ''
        rows.push(
          `<div class="tree-row file${sel}" data-path="${esc(f.path)}" style="--depth:${depth}"><span class="tag ${CHANGE_CLASSES[f.st] ?? ''}">${CHANGE_TAGS[f.st] ?? ''}</span><span class="nm">${esc(f.name)}</span><span class="dl">${delta}</span></div>`,
        )
      })
  }
  walk(root, 0)

  $('tree-title').textContent = `${k >= count ? 'WORKTREE' : commits[k].short} · ${changed} changed`
  $('tree-filter').classList.toggle('active', state.changedOnly)
  const parts = state.focus ? state.focus.split('/') : []
  const crumbs = [['', `⌂ ${repoName.split('/').at(-1)}`], ...parts.map((p, i) => [parts.slice(0, i + 1).join('/'), p])]
  $('tree-crumbs').innerHTML = crumbs
    .map(([path, label]) => `<span data-crumb="${esc(path)}" class="${path === state.focus ? 'here' : ''}">${esc(label)}</span>`)
    .join(' / ')
  $('tree-crumbs').querySelectorAll('span').forEach((el) => {
    el.onclick = () => el.dataset.crumb !== state.focus && setFocus(el.dataset.crumb)
  })

  const list = $('tree-list')
  list.innerHTML = rows.join('') || `<div class="dim">${state.changedOnly ? 'nothing changed here' : 'empty'}</div>`
  list.querySelectorAll('.tree-row.file').forEach((row) => {
    row.onclick = () => select(model.byPath.get(row.dataset.path), { focus: true })
  })
  list.querySelectorAll('.tree-row.dir').forEach((row) => {
    const path = row.dataset.dir
    row.onclick = (e) => {
      if (e.target.dataset.toggle) {
        state.open.set(path, !isOpen(path))
        renderTree()
      } else setFocus(path)
    }
    row.onmouseenter = () => highlightDistrict(path)
    row.onmouseleave = () => highlightDistrict(null)
  })
}

$('tree-filter').onclick = () => {
  state.changedOnly = !state.changedOnly
  state.open.clear()
  renderTree()
}

function renderLegend() {
  const items =
    state.lens === 'change'
      ? [['added / untracked', '#39ff88'], ['modified', '#ffb000'], ['deleted', '#ff3b5c'], ['staged', '#e8fbff'], ['untouched', '#17607a']]
      : state.lens === 'language'
        ? Object.entries(LANG_COLORS).filter(([l]) => files.some((f) => f.lang === l)).map(([l, c]) => [l, c])
        : state.lens === 'churn'
          ? [['quiet', '#0a5a70'], ['active', '#ff2bd6'], ['hot', '#ffb000']]
          : [['stale', '#12334a'], ['recent', '#00f0ff'], ['just moved', '#ffffff']]
  const extra =
    state.view === 'strata'
      ? '<div class="dim">slab height = lines changed; slab hue = commit</div>'
      : state.view === 'graph'
        ? '<div class="dim">node size = lines · edge brightens toward the imported file</div>'
        : '<div class="dim">height = lines · footprint = share of its folder</div>'
  $('hud-legend').innerHTML =
    items.map(([label, color]) => `<div><i style="color:${color}"></i>${esc(label)}</div>`).join('') + extra
}

let flashLine = null
function renderPanel() {
  const file = state.selected
  if (!file) return
  $('panel-path').textContent = file.path
  const add = file.events.reduce((s, e) => s + e.add, 0)
  const del = file.events.reduce((s, e) => s + e.del, 0)
  const authors = file.cur?.authors.join(', ') || '—'
  $('panel-meta').innerHTML = `<span><b>${file.lang}</b></span><span><b>${file.cur?.loc ?? 0}</b> lines</span><span><b>${file.events.length}</b> commits</span><span><span class="add">+${add}</span> <span class="del">−${del}</span></span><span>${esc(authors)}</span>${file.cur && file.cur.status !== 'clean' ? `<span class="mod">${file.cur.status.toUpperCase()}</span>` : ''}${file.deleted ? '<span class="del">DELETED</span>' : ''}`
  document.querySelectorAll('#panel-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab))
  const body = $('panel-body')
  if (state.tab === 'code') body.replaceChildren(codeView(file))
  else if (state.tab === 'history') body.replaceChildren(historyView(file))
  else body.replaceChildren(symbolsView(file))
}

function codeView(file) {
  const wrap = document.createElement('div')
  if (file.cur?.text == null && remoteFetch && file.cur && !file.cur.binary) {
    wrap.innerHTML = '<div class="list-row dim">loading from GitHub…</div>'
    remoteFetch(file.cur).then(() => state.selected === file && renderPanel())
    return wrap
  }
  if (file.cur?.text == null) {
    wrap.innerHTML = `<div class="list-row dim">${file.deleted ? 'File no longer exists — see HISTORY for its last diffs.' : 'Binary or oversized file — no text embedded.'}</div>`
    return wrap
  }
  const html = highlightLines(file.cur.text, file.cur.lang)
  const dirty = new Set(file.cur.dirtyLines)
  const blame = file.cur.blame
  const rows = html.map((line, i) => {
    const c = blame[i] ?? -1
    const bar = c >= 0 ? `border-right-color:#${commitColor(c).getHexString()}` : ''
    const title = c >= 0 ? `${commits[c].short} ${commits[c].subject}` : ''
    const classes = [dirty.has(i + 1) ? 'dirty' : '', c === state.k ? 'blame-sel' : ''].join(' ')
    return `<tr id="L${i + 1}" class="${classes}"><td class="ln" style="${bar}" title="${esc(title)}">${i + 1}</td><td class="src">${line || ' '}</td></tr>`
  })
  wrap.innerHTML = `<table class="code">${rows.join('')}</table>`
  return wrap
}

function patchHtml(patch) {
  const lines = patch.split('\n').map((l) => {
    const cls = l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : ''
    return `<div class="l ${cls}">${esc(l) || ' '}</div>`
  })
  return `<div class="patch">${lines.join('')}</div>`
}

function historyView(file) {
  const wrap = document.createElement('div')
  const rows = [...file.events].reverse().map((ev) => {
    const c = commits[ev.commit]
    const open = ev.commit === state.k
    return `<div class="list-row ${open ? 'sel' : ''}" data-commit="${ev.commit}"><span class="sha">${c.short}</span><span class="sub">${esc(c.subject)}<div class="dim">${esc(c.author)} · ${c.date.slice(0, 10)}</div></span><span><span class="add">+${ev.add}</span> <span class="del">−${ev.del}</span></span></div>${open ? patchHtml(ev.patch.patch + (ev.patch.truncated ? '\n… truncated' : '')) : ''}`
  })
  if (file.cur && file.cur.status !== 'clean') {
    rows.unshift(`<div class="list-row ${state.k >= count ? 'sel' : ''}" data-commit="${count}"><span class="sha">WT</span><span class="sub">uncommitted — ${file.cur.status}</span><span class="mod">${file.cur.dirtyLines.length} lines</span></div>`)
  }
  wrap.innerHTML = rows.join('') || '<div class="list-row dim">No history.</div>'
  wrap.querySelectorAll('.list-row[data-commit]').forEach((row) => {
    row.onclick = () => setCommit(Number(row.dataset.commit))
  })
  return wrap
}

function symbolsView(file) {
  const wrap = document.createElement('div')
  const symbols = file.cur?.symbols ?? []
  wrap.innerHTML =
    symbols
      .map((s) => `<div class="list-row symrow" style="--depth:${s.parent ? 1 : 0}" data-line="${s.line}"><span class="symkind">${s.kind}</span><span class="sub">${esc(s.name)}</span><span class="dim">${s.line}${s.end ? `–${s.end}` : ''}</span></div>`)
      .join('') || '<div class="list-row dim">No symbols parsed for this file type.</div>'
  wrap.querySelectorAll('.symrow').forEach((row) => {
    row.onclick = () => {
      state.tab = 'code'
      renderPanel()
      const tr = $(`L${row.dataset.line}`)
      tr?.scrollIntoView({ block: 'center' })
      flashLine?.classList.remove('flash')
      flashLine = tr
      tr?.classList.add('flash')
      setTimeout(() => tr?.classList.remove('flash'), 1800)
    }
  })
  return wrap
}

document.querySelectorAll('#panel-tabs button').forEach((b) => {
  b.onclick = () => {
    state.tab = b.dataset.tab
    renderPanel()
  }
})
$('panel-close').onclick = () => select(null)

const tl = $('timeline')
tl.max = count
tl.value = state.k
tl.oninput = () => setCommit(Number(tl.value))
$('ticks').innerHTML = Array.from({ length: count + 1 }, (_, i) => `<i style="left:calc(${(i / count) * 100}% + ${8 - (i / count) * 16}px)"></i>`).join('')
let playTimer = 0
function setPlaying(on) {
  state.playing = on
  $('play').textContent = on ? '❚❚' : '▶'
  clearInterval(playTimer)
  if (on) {
    if (state.k >= count) setCommit(0)
    playTimer = setInterval(() => {
      if (state.k >= count) return setPlaying(false)
      setCommit(state.k + 1)
    }, Math.max(80, Math.min(1100, 15000 / count)))
  }
}
$('play').onclick = () => setPlaying(!state.playing)
$('fly-toggle').onclick = () => setFly(!state.fly)

function toast(msg) {
  const el = $('toast')
  el.textContent = msg
  el.hidden = false
  setTimeout(() => (el.hidden = true), 2200)
}

$('current-name').textContent = repoName
$('current-meta').textContent = `${model.data.branch} @ ${model.data.head} · ${files.length} files · ${count} commits${model.data.truncated ? ' (latest)' : ''}`
if (ghCtx) $('rescan').hidden = true

// The filter only appears once the list is long enough to need it.
const REPO_FILTER_MIN = 7
$('repo-filter').hidden = manifest.length < REPO_FILTER_MIN
function renderRepos() {
  const q = $('repo-filter').value.trim().toLowerCase()
  const shown = manifest.filter((m) => !q || (m.label ?? m.name).toLowerCase().includes(q))
  $('menu-repos').innerHTML =
    shown
      .map((m) => {
        const current = m.name === repoName ? ' current' : ''
        const demo = m.base === '/demo/' ? '<span class="tag">DEMO</span>' : ''
        return `<a class="repo-row${current}" href="?repo=${encodeURIComponent(m.name)}"><span class="nm">${esc(m.label ?? m.name)}</span>${demo}<span class="dim">${m.files}f · ${m.commits}c</span></a>`
      })
      .join('') || '<div class="dim">no match</div>'
}
renderRepos()
$('repo-filter').addEventListener('input', renderRepos)
$('repo-filter').addEventListener('keydown', (e) => {
  const first = $('menu-repos').querySelector('a')
  if (e.key === 'Enter' && first) first.click()
})

$('gh-signin').hidden = !OAUTH_CLIENT_ID || !!token
$('gh-signin').onclick = startOAuth
$('gh-token').placeholder = token ? 'token set for this tab' : 'token (optional, private repos + higher limits)'
$('gh-clear').hidden = !token
$('gh-clear').onclick = () => {
  sessionStorage.removeItem(TOKEN_KEY)
  location.reload()
}
$('gh-load').onclick = () => {
  const target = $('gh-input').value.trim()
  if (!target) return
  const typed = $('gh-token').value.trim()
  if (typed) sessionStorage.setItem(TOKEN_KEY, typed)
  location.search = `?gh=${encodeURIComponent(target)}&n=${$('gh-limit').value}`
}
$('gh-input').addEventListener('keydown', (e) => e.key === 'Enter' && $('gh-load').click())

function toggleMenu(open) {
  $('menu').hidden = !open
  if (!open) return
  $('repo-filter').value = ''
  renderRepos()
  if (!$('repo-filter').hidden) $('repo-filter').focus()
}
function toggleKeys(open) {
  $('keys').hidden = !open
}
$('menu-open').onclick = () => toggleMenu(true)
$('menu-resume').onclick = () => toggleMenu(false)
$('keys-open').onclick = () => toggleKeys(true)
$('menu-keys').onclick = () => {
  toggleMenu(false)
  toggleKeys(true)
}
// Clicking the dimmed backdrop (not the card) closes an overlay.
$('menu').addEventListener('click', (e) => e.target === $('menu') && toggleMenu(false))
$('keys').addEventListener('click', (e) => e.target === $('keys') && toggleKeys(false))
$('rescan').onclick = async () => {
  $('rescan-status').textContent = 'scanning…'
  try {
    const res = await (await fetch(`/api/rescan?repo=${encodeURIComponent(repoName)}`)).json()
    $('rescan-status').textContent = res.message
    if (res.ok) location.reload()
  } catch {
    $('rescan-status').textContent = 'rescan needs the dev server (npm run dev)'
  }
}

const search = { open: false, results: [], index: 0 }
function openSearch(on) {
  search.open = on
  $('search').hidden = !on
  if (on) {
    $('search-input').value = ''
    $('search-input').focus()
    renderSearch()
  } else {
    $('search-input').blur()
  }
}
function renderSearch() {
  const q = $('search-input').value.toLowerCase()
  const fuzzy = (path) => {
    let i = 0
    for (const ch of path.toLowerCase()) if (ch === q[i]) i++
    return i === q.length
  }
  search.results = files.filter((f) => f.cur && (!q || fuzzy(f.path))).slice(0, 12)
  search.index = Math.min(search.index, Math.max(0, search.results.length - 1))
  $('search-results').innerHTML = search.results
    .map((f, i) => `<div class="list-row ${i === search.index ? 'sel' : ''}" data-i="${i}"><span class="sub">${esc(f.path)}</span><span class="dim">${f.lang}</span></div>`)
    .join('')
  $('search-results').querySelectorAll('.list-row').forEach((row) => {
    row.onclick = () => chooseSearch(Number(row.dataset.i))
  })
}
function chooseSearch(i) {
  const file = search.results[i]
  openSearch(false)
  if (file) select(file, { focus: true })
}
$('search-input').addEventListener('input', () => {
  search.index = 0
  renderSearch()
})

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase()
  if (search.open) {
    if (key === 'escape') openSearch(false)
    else if (key === 'arrowdown') search.index = Math.min(search.results.length - 1, search.index + 1)
    else if (key === 'arrowup') search.index = Math.max(0, search.index - 1)
    else if (key === 'enter') return chooseSearch(search.index)
    else return
    e.preventDefault()
    renderSearch()
    return
  }
  if (!$('keys').hidden) {
    if (key === 'escape' || key === '?') toggleKeys(false)
    return
  }
  if (key === 'escape') {
    if (!$('menu').hidden) toggleMenu(false)
    else if (state.selected) select(null)
    else toggleMenu(true)
    return
  }
  if (!$('menu').hidden) return
  keys.add(key)
  if (key === '/') {
    e.preventDefault()
    openSearch(true)
  } else if (key === '?') toggleKeys(true)
  else if (key === 'f') setFly(!state.fly)
  else if (key === '1') setView('city')
  else if (key === '2') setView('graph')
  else if (key === '3') setView('strata')
  else if (key === 'l') setLens(LENSES[(LENSES.findIndex((l) => l.id === state.lens) + 1) % LENSES.length].id)
  else if (key === 'arrowleft') setCommit(state.k - 1)
  else if (key === 'arrowright') setCommit(state.k + 1)
  else if (key === ' ') {
    e.preventDefault()
    setPlaying(!state.playing)
  } else if (key === 'home') resetView()
  else if (key === 't') viewFrom('top')
  else if (key === 'i') viewFrom('iso')
  else if (key === '.') frameSelection()
  else if (key === 'o') setOrtho(!camera.isOrthographicCamera)
  else if (key === 'backspace') {
    e.preventDefault()
    focusUp()
  }
})

document.querySelectorAll('#camera-buttons [data-preset]').forEach((b) => (b.onclick = () => viewFrom(b.dataset.preset)))
$('cam-frame').onclick = frameSelection
$('cam-ortho').onclick = () => setOrtho(!camera.isOrthographicCamera)
$('cam-reset').onclick = resetView
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()))
window.addEventListener('blur', () => keys.clear())

function resize() {
  renderer.setSize(innerWidth, innerHeight, false)
  composer.setSize(innerWidth, innerHeight)
  labels.setSize(innerWidth, innerHeight)
  const aspect = innerWidth / innerHeight
  perspCamera.aspect = aspect
  orthoCamera.left = -ORTHO_HALF * aspect
  orthoCamera.right = ORTHO_HALF * aspect
  applyViewShift()
}

// Width the open code panel covers (matches #panel's min(46vw, 760px)).
const panelWidth = () => (state.selected ? Math.min(innerWidth * 0.46, 760) : 0)

// Slides the projection centre left by half the panel width, so whatever the camera looks at sits
// in the middle of the uncovered area. Eased in frame() to follow the panel's slide.
let viewShift = 0
function applyViewShift() {
  for (const cam of [perspCamera, orthoCamera]) {
    if (viewShift > 0.5) cam.setViewOffset(innerWidth, innerHeight, viewShift, 0, innerWidth, innerHeight)
    else cam.clearViewOffset()
    cam.updateProjectionMatrix()
  }
}
window.addEventListener('resize', resize)

const clock = new THREE.Clock()
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1)
  const time = clock.elapsedTime

  viewHelper.center.copy(controls.target)
  if (viewHelper.animating) {
    viewHelper.update(dt)
    gizmoMoving = true
  } else {
    if (tween) stepTween(dt)
    if (state.fly) stepFly(dt)
    else controls.update()
    if (gizmoMoving) {
      gizmoMoving = false
      // The gizmo's +Y axis is the same top-down map as TOP.
      if (viewDir().y > 0.999 && !camera.isOrthographicCamera) setOrtho(true, { auto: true })
    }
    if (state.orthoAuto && camera.isOrthographicCamera && !tween && controls.getPolarAngle() > 0.15) setOrtho(false)
    const mapMode = camera.isOrthographicCamera && controls.getPolarAngle() < 0.15
    if (mapMode !== state.mapMode) setMapMode(mapMode)
  }

  const pulse = 0.7 + 0.3 * Math.sin(time * 4)
  const ease = Math.min(1, dt * 6)
  const shiftGoal = panelWidth() / 2
  if (Math.abs(shiftGoal - viewShift) > 0.5) {
    viewShift += (shiftGoal - viewShift) * Math.min(1, dt * 12)
    applyViewShift()
  } else if (viewShift !== shiftGoal) {
    viewShift = shiftGoal
    applyViewShift()
  }
  let graphMoved = false
  let layoutMoved = false
  files.forEach((file) => {
    const v = file.vis
    v.h += (v.target - v.h) * Math.min(1, dt * 7)
    v.r += (v.rTarget - v.r) * Math.min(1, dt * 7)
    const goalOff = file.focus.off
    const step = Math.abs(goalOff.x - v.off.x) + Math.abs(goalOff.z - v.off.z) + Math.abs(file.focus.squash - v.squash)
    if (step > 0.001) {
      v.off.x += (goalOff.x - v.off.x) * ease
      v.off.z += (goalOff.z - v.off.z) * ease
      v.squash += (file.focus.squash - v.squash) * ease
      file.tower.group.position.set(file.pos.x + v.off.x, 0, file.pos.z + v.off.z)
      file.strata.group.position.copy(file.tower.group.position)
      file.strata.group.scale.y = v.squash
      layoutMoved = true
    }

    const g = file.tower.group
    g.visible = v.h > 0.03
    g.scale.set(file.pos.w, Math.max(v.h * v.squash, 0.001), file.pos.d)

    const n = file.node.group
    n.visible = v.r > 0.05
    n.scale.setScalar(Math.max(v.r, 0.001))
    const goal = file.graphPos
    if (Math.abs(n.position.x - goal.x) + Math.abs(n.position.y - goal.y) > 0.001) {
      n.position.lerp(new THREE.Vector3(goal.x, goal.y, goal.z), 0.1)
      v.node.copy(n.position)
      graphMoved = true
    }

    const pulsing = state.lens === 'change' && ['modified', 'untracked', 'staged'].includes(file.st) && state.k >= count
    file.mats.forEach(({ material }) => {
      const base = material.userData.base ?? 1
      material.opacity = Math.min(1, base * (pulsing ? pulse : 1))
    })
    if (file === state.selected) file.mats.forEach(({ material, kind }) => kind === 'edge' && (material.opacity = 1))
    if (file === state.hovered) file.mats.forEach(({ material, kind }) => kind === 'edge' && (material.opacity = 1))
  })
  if (graphMoved) updateGraphEdges()
  if (layoutMoved && state.selected) rebuildLinks()

  if (state.selected) {
    const file = state.selected
    const p = currentPosition(file)
    beam.position.set(p.x, state.view === 'graph' ? p.y : 0, p.z)
    selLabel.position.set(p.x, p.y + 1.2, p.z)
    beam.material.opacity = 0.4 + 0.4 * Math.sin(time * 3)
  }

  dust.rotation.y += dt * 0.01
  updateDistricts(ease)
  updateHover(dt)
  composer.render()
  const gizmo = $('gizmo').getBoundingClientRect()
  viewHelper.location.right = innerWidth - gizmo.right
  viewHelper.location.bottom = innerHeight - gizmo.bottom
  // Draw the gizmo over the composed frame instead of clearing it.
  renderer.autoClear = false
  viewHelper.render(renderer)
  renderer.autoClear = true
  labels.render(scene, camera)
  requestAnimationFrame(frame)
}

const FOCUS_COLOR = new THREE.Color('#00f0ff')
const HOT_COLOR = new THREE.Color('#ffffff')
function updateDistricts(ease) {
  const focusDepth = state.focus ? state.focus.split('/').length : 0
  // Deeper folder names appear once the camera is close (or zoomed in, when orthographic).
  const closeUp = (obj) =>
    camera.isOrthographicCamera ? ORTHO_HALF / camera.zoom < city.size * 0.2 : obj.position.distanceTo(camera.position) < city.size * 0.35
  districtLabels.forEach(({ obj, district: d }) => {
    const v = d.vis
    const t = d.target
    v.x += (t.x - v.x) * ease
    v.z += (t.z - v.z) * ease
    v.w += (t.w - v.w) * ease
    v.d += (t.d - v.d) * ease
    obj.position.set(v.x, 0.1, v.z - v.d / 2 + 0.4)
    d.outline.line.position.set(v.x, 0.01, v.z)
    d.outline.line.scale.set(v.w, 1, v.d)

    const inside = inFocus(d.path)
    const ancestor = state.focus.startsWith(`${d.path}/`)
    const hot = d === hotDistrict
    d.outline.mat.color.copy(hot ? HOT_COLOR : d.path === state.focus ? FOCUS_COLOR : d.outline.base)
    d.outline.mat.opacity = hot || d.path === state.focus ? 1 : inside || ancestor ? 0.8 : 0.8 * GHOST_OPACITY
    d.label.classList.toggle('hot', hot)
    d.label.style.opacity = inside || ancestor ? '' : String(GHOST_OPACITY + 0.15)
    obj.visible =
      state.view !== 'graph' &&
      (inside ? d.depth <= focusDepth + 1 || closeUp(obj) : d.depth <= 1)
  })
}

resize()
buildButtons()
// Start pulled back so the opening frameView flies in.
camera.position.set(city.size * 0.9, city.size * 0.8, city.size * 1.0).multiplyScalar(1.6)
setView('city')
$('timeline').value = state.k
requestAnimationFrame(frame)

