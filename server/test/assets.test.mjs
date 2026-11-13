import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import projectModule from '../out/project.cjs'
const { Project, canonicalUri, assetWatchRoots } = projectModule

test('asset watch subscriptions retain their parent when missing directories appear', () => {
  const root = mkdtempSync(join(tmpdir(), 'crossbreeze-watch-roots-'))
  const asset = join(root, 'images', 'icon.png')
  const initial = assetWatchRoots([asset], new Set())
  assert(initial.has(root))
  mkdirSync(dirname(asset))
  writeFileSync(asset, '')
  const created = assetWatchRoots([asset], initial)
  assert(created.has(root), 'Creating a directory must not unsubscribe its active parent watcher')
  assert(created.has(dirname(asset)))
  unlinkSync(asset)
  assert.deepEqual(assetWatchRoots([asset], created), created)
  assert.equal(assetWatchRoots([], created).size, 0, 'Unreferenced roots must still be removed')
})

function fixture(aliases = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crossbreeze-assets-'))
  const uri = path => canonicalUri(pathToFileURL(join(root, path)).href)
  const put = (path, text = '') => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
    return uri(path)
  }
  const project = new Project([root], aliases)
  const css = text => {
    const file = put('src/app.xcss', text)
    project.initialize()
    return file
  }
  const diagnostics = file => project.cssDiagnostics(file, { checkCssProperties: false, checkCssValues: false }).filter(d => d.code === 'asset.not-found')
  const definition = (file, text, value) => project.query('definition', file, { line: 0, character: text.indexOf(value) })
  return { root, uri, put, project, css, diagnostics, definition }
}

test('asset navigation resolves exact relative filenames, aliases and escaped URLs with precise ranges', () => {
  const f = fixture({ '@override/*': ['absent/*', 'assets/*'] })
  f.put('base.json', JSON.stringify({ compilerOptions: { paths: { '@img/*': ['assets/*'] } } }))
  f.put('tsconfig.json', '{"extends":"./base.json"}')
  const image = f.put('assets/logo.svg')
  const spaced = f.put('src/a b😀.png')
  const text = '.a { a: url("@img/logo.svg?raw#icon"); b: url(./a\\ b😀.png); c: url(@override/logo.svg); d: url(a%20b😀.png); }'
  const file = f.css(text)
  for (const value of ['@img/', '@override/']) assert.equal(f.definition(file, text, value)[0]?.uri, image)
  for (const value of ['./a', 'a%20']) assert.equal(f.definition(file, text, value)[0]?.uri, spaced)
  assert.deepEqual(f.diagnostics(file), [])
  const links = f.project.query('definitionLinks', file, { line: 0, character: text.indexOf('@img/') })
  assert.deepEqual(links[0].originSelectionRange, { start: { line: 0, character: text.indexOf('@img/') }, end: { line: 0, character: text.indexOf('"', text.indexOf('@img/')) } })
  assert.deepEqual(links[0].targetSelectionRange, { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } })
  assert(!f.project.files.has(image))
})

test('missing local assets are errors; remote, empty, fragment and non-URL strings are ignored', () => {
  const f = fixture()
  f.put('src/missing.png.xcss', '')
  mkdirSync(join(f.root, 'src/directory'), { recursive: true })
  const text = '.a { a: url("missing.png"); b: url(directory); c: url(https://example.com/a.png); d: url(//cdn/a); e: url(data:image/png;base64,abc); f: url(#icon); g: url(""); content: "url(fake.png)"; /* url(comment.png) */ }'
  const file = f.css(text)
  const errors = f.diagnostics(file)
  assert.equal(errors.length, 2)
  for (const [error, name] of errors.map((error, i) => [error, ['missing.png', 'directory'][i]])) {
    assert.equal(error.severity, 1)
    assert.equal(text.slice(error.range.start.character, error.range.end.character), name)
  }
  assert.deepEqual(f.definition(file, text, 'missing.png'), [])
})

test('asset creation, deletion, unsaved edits and alias overrides refresh resolution', () => {
  const f = fixture({ '@img/*': ['missing/*'] })
  f.put('tsconfig.json', '{"compilerOptions":{"paths":{"@img/*":["assets/*"]}}}')
  f.put('assets/logo.png')
  const text = '.a { a: url(@img/logo.png); }'
  const file = f.css(text)
  assert.equal(f.diagnostics(file).length, 1)
  const asset = f.put('missing/logo.png')
  assert(f.project.assetWatchPaths().some(path => path.endsWith('logo.png')))
  f.project.change(asset)
  assert.equal(f.diagnostics(file).length, 0)
  unlinkSync(join(f.root, 'missing/logo.png'))
  f.project.change(asset)
  assert.equal(f.diagnostics(file).length, 1)
  f.project.configure({})
  assert.equal(f.diagnostics(file).length, 0)
  f.project.update(file, '.a { a: url(other.png); }', 1)
  assert.equal(f.diagnostics(file).length, 1)
  assert.deepEqual(f.definition(file, text, '@img/'), [])
})

test('public URLs honor nearest Vite root/publicDir literals and skip uncertain configurations', () => {
  const f = fixture()
  f.put('package.json', '{}')
  const image = f.put('public/logo.png')
  const text = '.a { a: url(/logo.png); }'
  const file = f.css(text)
  assert.equal(f.definition(file, text, '/logo')[0]?.uri, image)
  const custom = f.put('web/static/logo.png')
  const config = f.put('vite.config.ts', 'export default defineConfig({ root: "web", publicDir: "static" });')
  f.project.change(config)
  assert.equal(f.definition(file, text, '/logo')[0]?.uri, custom)
  for (const value of ['{ publicDir: false }', '{ publicDir: getPublicDir() }', '() => ({})', '{ ...settings }']) {
    f.put('vite.config.ts', `export default defineConfig(${value});`)
    f.project.change(config)
    assert.deepEqual(f.definition(file, text, '/logo'), [])
    assert.deepEqual(f.diagnostics(file), [])
  }
  f.project.update(config, 'export default { publicDir: "absent" };', 1, false)
  assert.equal(f.diagnostics(file).length, 1)
  const asset = f.put('absent/logo.png')
  f.project.change(asset)
  assert.equal(f.diagnostics(file).length, 0)
})

test('URL ranges use UTF-16 positions across lines', () => {
  const f = fixture()
  const text = '.a {\n /* 😀 */ a: url("missing.png");\n}'
  const file = f.css(text)
  const [error] = f.diagnostics(file)
  assert.deepEqual(error.range, { start: { line: 1, character: text.split('\n')[1].indexOf('missing') }, end: { line: 1, character: text.split('\n')[1].indexOf('missing') + 11 } })
})
