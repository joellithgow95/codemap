// Validates every guide in `.codemap/guides/` of a checkout: the YAML parses, the schema holds,
// and every file, symbol and folder a step points at exists in the tree. Run by CI; also handy
// before committing a guide an agent wrote:  node scripts/check-guides.mjs [repo root]
//
// Guides are untrusted input in a PR, so this only reads them. It never runs anything from them.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { GUIDE_DIR, parseGuide, validateGuide } from '../src/guide.js'
import { MAX_TEXT_BYTES, extractSymbols, langOf, parsesSymbols } from '../src/parse.js'

const root = resolve(process.argv[2] ?? '.')
const dir = join(root, GUIDE_DIR)
if (!existsSync(dir)) {
  console.log(`No ${GUIDE_DIR}/ in ${root}: nothing to check.`)
  process.exit(0)
}

const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean)
const paths = new Set(tracked)
const folders = new Set()
tracked.forEach((p) => {
  const parts = p.split('/')
  for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
})

// Symbols are read lazily and cached: only the files a guide actually points at get opened.
const symbolCache = new Map()
function lookup(path) {
  if (!paths.has(path)) return null
  if (!symbolCache.has(path)) {
    const lang = langOf(path)
    let symbols = []
    if (parsesSymbols(lang)) {
      const file = join(root, path)
      if (statSync(file).size <= MAX_TEXT_BYTES) symbols = extractSymbols(readFileSync(file, 'utf8'), lang)
    }
    symbolCache.set(path, { symbols })
  }
  return symbolCache.get(path)
}

const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()
let failed = 0
for (const name of files) {
  const label = `${GUIDE_DIR}/${name}`
  const { guide, errors, warnings } = parseGuide(readFileSync(join(dir, name), 'utf8'))
  warnings.forEach((w) => console.log(`warn  ${label}: ${w}`))
  if (!guide) {
    errors.forEach((e) => console.log(`FAIL  ${label}: ${e}`))
    failed++
    continue
  }
  const problems = validateGuide(guide, { lookup, folders })
  problems.forEach((p) => console.log(`FAIL  ${label}: step ${p.step + 1} "${guide.steps[p.step].title}": ${p.message}`))
  if (problems.length) failed++
  else console.log(`ok    ${label} (${guide.steps.length} steps)`)
}

if (!files.length) console.log(`${GUIDE_DIR}/ has no guides.`)
process.exit(failed ? 1 : 0)
