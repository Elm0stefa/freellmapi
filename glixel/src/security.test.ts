import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Static guarantees for Increment 1: GLIXEL is read-only, never touches
// key-bearing or proxy endpoints, writes nothing to storage, and bakes no
// environment into its bundle. Scans the source, and the built bundle when one
// exists.

const here = path.dirname(fileURLToPath(import.meta.url))
const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name)
  if (e.isDirectory()) return sources(p)
  return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : []
})
const files = sources(here).map(p => ({ p: path.relative(here, p), src: fs.readFileSync(p, 'utf8') }))

describe('GLIXEL source', () => {
  it.each([
    ['the unified-key endpoint', /api-key/],
    ['the /v1 proxy', /['"`]\/v1\//],
    ['write methods', /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i],
    ['storage writes', /(localStorage|sessionStorage)\.(setItem|removeItem|clear)/],
    ['build-time environment', /import\.meta\.env|process\.env/],
    ['inline HTML injection', /dangerouslySetInnerHTML/],
  ])('never uses %s', (_, pattern) => {
    for (const { p, src } of files) expect(src, p).not.toMatch(pattern)
  })

  it('reads only the session-gated endpoints of this increment', () => {
    const endpoints = new Set(files.flatMap(({ src }) => [...src.matchAll(/apiGet<[^>]*>\('([^']+)'\)/g)].map(m => m[1])))
    expect([...endpoints].sort()).toEqual(['/api/health', '/api/providers'])
  })
})

describe('GLIXEL bundle', () => {
  const dist = path.resolve(here, '../dist/assets')
  const built = fs.existsSync(dist)
  it.skipIf(!built)('contains no key-shaped strings or server secrets', () => {
    for (const name of fs.readdirSync(dist).filter(n => n.endsWith('.js') || n.endsWith('.css'))) {
      const body = fs.readFileSync(path.join(dist, name), 'utf8')
      expect(body, name).not.toMatch(/freellmapi-[A-Za-z0-9_-]{20,}|sk-cp-[A-Za-z0-9]{10,}|ENCRYPTION_KEY|AIza[0-9A-Za-z_-]{30,}/)
    }
  })
})
