import { readFile, readdir, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
const version = JSON.parse(await readFile('package.json', 'utf8')).dependencies['@cross-css/native']
const root = resolve('dist/server')
const manifest = JSON.parse(await readFile(join(root, 'native-manifest.json'), 'utf8'))
assert.equal(manifest.length, 9)
for (const item of manifest) {
  assert.equal(item.version, version)
  for (const [file, hash] of Object.entries(item.hashes)) {
    const path = join(root, 'node_modules', item.name, file)
    assert(!(await lstat(path)).isSymbolicLink())
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), hash)
  }
}
const require = createRequire(join(root, 'index.cjs'))
const { LanguageService, languageServiceCapabilities } = require('@cross-css/native')
assert.equal(languageServiceCapabilities().apiVersion, 2)
const service = new LanguageService()
service.setFile('file:///test.xcss', 1, '.button { color: red; }')
assert.equal(service.document('file:///test.xcss').diagnostics.length, 0)
assert(service.document('file:///test.xcss').tokens.length)
assert.equal(service.cssDeclarations('file:///test.xcss').declarations[0].property, 'color')
const worker = new Worker(join(root, 'worker.cjs'))
let id = 0
async function call(method, ...args) {
  const requestId = ++id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.off('message', listener); reject(new Error(`Bundled worker timed out: ${method}`)) }, 10000)
    const listener = message => {
      if (message.id !== requestId) return
      worker.off('message', listener); clearTimeout(timer)
      if (message.error) reject(new Error(message.error)); else resolve(message.result)
    }
    worker.on('message', listener)
    worker.postMessage({ id: requestId, method, args })
  })
}
try {
  await call('initialize', [], {}, [])
  await call('update', 'untitled:css-smoke.xcss', '@vars { --t: time; } .a { dispay: flex; display: fex; width: --t; }', 1)
  const diagnostics = await call('cssDiagnostics', 'untitled:css-smoke.xcss', { checkCssProperties: true, checkCssValues: true })
  assert.deepEqual(diagnostics.map(d => d.code), ['css.unknown-property', 'css.invalid-value', 'css.type-mismatch'])
} finally { await worker.terminate() }
console.log('Bundled registry packages, integrity, and host-native loading verified')
