import { readFile, readdir, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const root = resolve('dist/server')
const manifest = JSON.parse(await readFile(join(root, 'native-manifest.json'), 'utf8'))
assert.equal(manifest.length, 9)
for (const item of manifest) {
  assert.equal(item.version, '0.3.0')
  for (const [file, hash] of Object.entries(item.hashes)) {
    const path = join(root, 'node_modules', item.name, file)
    assert(!(await lstat(path)).isSymbolicLink())
    assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), hash)
  }
}
const require = createRequire(join(root, 'index.cjs'))
const { LanguageService, languageServiceCapabilities } = require('@cross-css/native')
assert.equal(languageServiceCapabilities().apiVersion, 1)
const service = new LanguageService()
service.setFile('file:///test.xcss', 1, '.button { color: red; }')
assert.equal(service.document('file:///test.xcss').diagnostics.length, 0)
assert(service.document('file:///test.xcss').tokens.length)
console.log('Bundled registry packages, integrity, and host-native loading verified')
