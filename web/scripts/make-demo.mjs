import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadGithub, parseRepoSpec } from '../src/github.js'

const [target, limit = '40'] = process.argv.slice(2)
const outDir = resolve(import.meta.dirname, '../public/demo')
const spec = parseRepoSpec(target)
const { doc } = await loadGithub(spec, {
  token: process.env.GITHUB_TOKEN ?? '',
  commitLimit: Number(limit),
  onProgress: (label, done, total) => process.stderr.write(`\r${label} ${done}/${total}      `),
})
mkdirSync(outDir, { recursive: true })
const name = `${spec.owner}-${spec.repo}`.toLowerCase()
writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify(doc))

const manifestPath = resolve(outDir, 'manifest.json')
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : []
const entry = { name, label: `${spec.owner}/${spec.repo}`, files: doc.files.length, commits: doc.commits.length, generated: doc.generated }
writeFileSync(manifestPath, JSON.stringify([...manifest.filter((m) => m.name !== name), entry], null, 1))
console.error(`\n${entry.label}: ${entry.files} files, ${entry.commits} commits -> ${name}.json`)
