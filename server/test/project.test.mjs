import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import projectModule from '../out/project.cjs'
const { Project, canonicalUri } = projectModule
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'crossbreeze-test-'))
  const put = (path, text) => { const file = join(root, path); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); return canonicalUri(pathToFileURL(file).href) }
  return { root, put }
}
const pos = (source, name) => ({ line: 0, character: source.indexOf(name) })

test('CSS validation is queried separately and isolated documents use their own service', () => {
  const { root, put } = fixture()
  const app = put('app.xcss', '.a { display: fex; }')
  const project = new Project([root])
  project.initialize()
  assert.equal(project.cssDiagnostics(app, { checkCssProperties: true, checkCssValues: true })[0].code, 'css.invalid-value')
  project.update('untitled:isolated', '.a { dispay: flex; }', 1)
  assert.equal(project.cssDiagnostics('untitled:isolated', { checkCssProperties: true, checkCssValues: true })[0].code, 'css.unknown-property')
  project.service.cssDeclarations = () => { throw new Error('must not run for navigation or semantic tokens') }
  assert(project.query('document', app).tokens.length)
  assert.deepEqual(project.query('definition', app, { line: 0, character: 0 }), [])
  assert.deepEqual(project.cssDiagnostics(app, { checkCssProperties: false, checkCssValues: false }), [])
})

test('aliases, inheritance, overlay precedence, revisions, close and deletion', () => {
  const { root, put } = fixture()
  put('config/base.json', '{ "compilerOptions": { "baseUrl": "..", "paths": { "@theme/*": ["styles/*"] } } }')
  put('tsconfig.json', '{ /* JSONC */ "extends": "./config/base.json", }')
  const lib = put('styles/lib.xcss', '@injection paint {}')
  const text = '@import theme from "@theme/lib"; .a { @:theme.paint; }'
  const app = put('app #é.xcss', text)
  const project = new Project([root])
  project.initialize()
  assert.deepEqual(project.query('document', app).diagnostics, [])
  assert.equal(project.query('definition', app, pos(text, 'paint'))[0].uri, lib)
  project.update(lib, '@injection changed {}', 2)
  project.update(lib, '@injection paint {}', 1)
  assert(project.query('document', app).diagnostics.length)
  writeFileSync(join(root, 'styles/lib.xcss'), '@injection paint {}')
  project.change(lib)
  assert(project.query('document', app).diagnostics.length, 'disk must not overwrite an open buffer')
  project.close(lib)
  assert.deepEqual(project.query('document', app).diagnostics, [])
  unlinkSync(join(root, 'styles/lib.xcss'))
  project.change(lib)
  assert(project.query('document', app).diagnostics.some(d => d.code === 'binding.unresolved-import'))
})
test('global injection changes, excluded directories, explicit overrides and isolated files', () => {
  const { root, put } = fixture()
  put('one.xcss', '@injection paint {}')
  put('node_modules/ignored.xcss', '@injection paint {}')
  const text = '.a { @:paint; }'
  const app = put('app.xcss', text)
  const project = new Project([root])
  project.initialize()
  assert.deepEqual(project.query('document', app).diagnostics, [])
  const conflict = put('two.xcss', '@injection paint {}')
  project.change(conflict)
  assert(project.query('document', app).diagnostics.some(d => d.code === 'binding.ambiguous-injection'))
  unlinkSync(join(root, 'two.xcss')); project.change(conflict)
  assert.deepEqual(project.query('document', app).diagnostics, [])
  project.update('untitled:outside.xcss', text, 1)
  assert(project.query('document', 'untitled:outside.xcss').diagnostics.some(d => d.code === 'binding.unknown-injection'))
  const override = put('override.xcss', '@injection paint {}')
  const imports = '@import theme from "@theme"; .a { @:theme.paint; }'
  project.update(app, imports, 1)
  project.configure({ '@theme': ['override.xcss'] })
  assert.equal(project.query('definition', app, pos(imports, 'paint'))[0].uri, override)
  project.configure({ '@theme': ['missing.xcss'] })
  assert(project.query('document', app).diagnostics.some(d => d.code === 'binding.unresolved-import'))
})
test('inherited config edits and excluded-root events refresh only project sources', () => {
  const { root, put } = fixture()
  const config = put('Config/Base.json', '{"compilerOptions":{"baseUrl":"..","paths":{"@theme":["one.xcss"]}}}')
  put('tsconfig.json', '{"extends":"./Config/Base.json"}')
  const one = put('one.xcss', '@injection paint {}')
  const two = put('two.xcss', '@injection paint {}')
  const ignored = put('generated/conflict.xcss', '@injection paint {}')
  const text = '@import theme from "@theme"; .a { @:theme.paint; }'
  const app = put('app.xcss', text)
  const project = new Project([root], {}, () => {}, [join(root, 'generated')])
  project.initialize()
  assert.equal(project.query('definition', app, pos(text, 'paint'))[0].uri, one)
  writeFileSync(join(root, 'Config/Base.json'), '{"compilerOptions":{"baseUrl":"..","paths":{"@theme":["two.xcss"]}}}')
  project.change(config)
  assert.equal(project.query('definition', app, pos(text, 'paint'))[0].uri, two)
  project.change(ignored)
  assert(!project.files.has(ignored))
})
