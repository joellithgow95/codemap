import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'

const scanner = resolve(import.meta.dirname, '../scan/scan.py')
const outDir = resolve(import.meta.dirname, 'local-maps')

const functionHandlers = {
  '/.netlify/functions/github-token': () => import('./netlify/functions/github-token.mjs'),
}

const netlifyFunctions = () => ({
  name: 'netlify-functions-dev',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const load = functionHandlers[new URL(req.url, 'http://localhost').pathname]
      if (!load) return next()
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? Buffer.concat(chunks) : undefined
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      })
      const response = await (await load()).default(request)
      res.statusCode = response.status
      response.headers.forEach((value, key) => res.setHeader(key, value))
      res.end(Buffer.from(await response.arrayBuffer()))
    })
  },
})

const rescan = () => ({
  name: 'codemap-rescan',
  configureServer(server) {
    server.middlewares.use('/maps/', (req, res, next) => {
      const file = resolve(outDir, basename(new URL(req.url, 'http://localhost').pathname))
      if (!existsSync(file)) return next()
      res.setHeader('content-type', 'application/json')
      res.end(readFileSync(file))
    })
    server.middlewares.use('/api/rescan', (req, res) => {
      const name = new URL(req.url, 'http://localhost').searchParams.get('repo')
      const manifestPath = resolve(outDir, 'manifest.json')
      const known = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : []
      const entry = known.find((m) => m.name === name)
      if (!entry) {
        res.statusCode = 404
        res.end(JSON.stringify({ ok: false, message: `unknown repo ${name}` }))
        return
      }
      execFile('python3', ['-I', scanner, entry.path, '--out-dir', outDir], (error, stdout, stderr) => {
        res.setHeader('content-type', 'application/json')
        res.statusCode = error ? 500 : 200
        res.end(JSON.stringify({ ok: !error, message: (error ? stderr : stdout).trim() }))
      })
    })
  },
})

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, import.meta.dirname, ''))
  return { plugins: [rescan(), netlifyFunctions()], server: { host: '127.0.0.1', port: 5179 } }
})
