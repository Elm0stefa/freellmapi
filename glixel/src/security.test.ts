import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Static guarantees: GLIXEL never touches key-bearing or proxy endpoints, writes
// only to its chat endpoint and the existing conversation store, writes nothing
// to browser storage, and bakes no environment into its bundle. Scans the
// source, and the built bundle when one exists.

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
    ['PATCH', /['"]PATCH['"]/],
    ['storage writes', /(localStorage|sessionStorage)\.(setItem|removeItem|clear)/],
    ['build-time environment', /import\.meta\.env|process\.env/],
    ['inline HTML injection', /dangerouslySetInnerHTML/],
  ])('never uses %s', (_, pattern) => {
    for (const { p, src } of files) expect(src, p).not.toMatch(pattern)
  })

  it('reads only the session-gated endpoints it needs', () => {
    const reads = new Set(files.flatMap(({ src }) => [...src.matchAll(/apiGet(?:<.*?>)?\(['`]([^'`$]+)/g)].map(m => m[1])))
    expect([...reads].sort()).toEqual(['/api/conversations', '/api/conversations/', '/api/health', '/api/providers'])
  })

  it('writes only to the chat endpoint and the conversation store', () => {
    const writes = files.flatMap(({ src }) => [...src.matchAll(/apiSend(?:Json)?(?:<[^>]*>)?\(\s*'(POST|PUT|DELETE)',\s*['`]([^'`$]+)/g)].map(m => `${m[1]} ${m[2]}`))
    expect([...new Set(writes)].sort()).toEqual([
      'DELETE /api/conversations/', 'POST /api/conversations', 'POST /api/glixel/chat', 'PUT /api/conversations/',
    ])
    const session = files.find(f => f.p.endsWith('session.ts'))!.src
    expect(session).toMatch(/const WRITABLE = \[/)
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
