import { cp, readFile, readdir, lstat, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { tmpdir } from 'node:os'
import { bundleRoot, hostTarget, loader, nativePackages } from './bundle-targets.mjs'

async function verify(root, target) {
  const version = JSON.parse(await readFile('package.json', 'utf8')).dependencies[loader]
  const manifests = await Promise.all(['native-loader-manifest.json', 'native-platform-manifest.json']
    .map(async name => JSON.parse(await readFile(join(root, name), 'utf8'))))
  const manifest = manifests.flat()
  const expected = [loader, ...nativePackages(target)].sort()
  assert.deepEqual(manifest.map(item => item.name).sort(), expected)
  assert.deepEqual((await readdir(join(root, 'node_modules', '@cross-css'))).map(name => `@cross-css/${name}`).sort(), expected)
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
  for (const item of manifest) {
    assert.equal(item.version, version)
    const locked = lock.packages[`node_modules/${item.name}`]
    assert.equal(item.resolved, locked.resolved)
    assert.equal(item.integrity, locked.integrity)
    assert.deepEqual((await readdir(join(root, 'node_modules', item.name))).sort(), Object.keys(item.hashes).sort())
    for (const [file, hash] of Object.entries(item.hashes)) {
      const path = join(root, 'node_modules', item.name, file)
      assert(!(await lstat(path)).isSymbolicLink())
      assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), hash)
    }
  }
  const require = createRequire(join(root, 'index.cjs'))
  const { name: binary } = require(join(root, 'node_modules', loader, 'platform.cjs'))
  assert(nativePackages(target).includes(binary))
  assert.equal(require.resolve(binary), join(root, 'node_modules', binary, 'xcss.node'))
  const { LanguageService, languageServiceCapabilities, formatSource } = require(loader)
  assert.equal(typeof formatSource, 'function', 'Bundled engine must include the XCSS formatter')
  assert.equal(formatSource('.a{color:red}').text, '.a {\n  color: red;\n}\n')
  assert.equal(languageServiceCapabilities().apiVersion, 4)
  const service = new LanguageService()
  service.setFile('file:///test.xcss', 1, '.button { color: red; }')
  assert.equal(service.document('file:///test.xcss').diagnostics.length, 0)
  assert(service.document('file:///test.xcss').tokens.length)
  assert.equal(service.cssDeclarations('file:///test.xcss').declarations[0].property, 'color')
  assert.equal(service.cssValues('file:///test.xcss').values[0].property, 'color')
  service.setFile('file:///broken.xcss', 1, 'bogus;')
  const [syntaxError] = service.document('file:///broken.xcss').diagnostics
  assert.equal(syntaxError.code, 'XC-105')
  assert.equal(syntaxError.label, 'Invalid XCSS statement')
  assert.deepEqual(languageServiceCapabilities().tokenTypes.slice(-3), ['cssFunction', 'cssKeyword', 'cssColor'])
  service.setFile('file:///selectors.xcss', 1, '#root, .parent { svg|a.button[data-kind="hello"]:where(.disabled)::after > * { & + .child {} } }')
  const selectors = service.selectors('file:///selectors.xcss')
  assert.equal(selectors.selectors.length, 4)
  assert.deepEqual(selectors.selectors[2].specificity, { ids: 1, classes: 2, types: 2 })
  const legend = languageServiceCapabilities().tokenTypes
  const selectorTokens = service.document('file:///selectors.xcss').tokens
  for (const kind of ['class', 'selectorId', 'selectorTag', 'selectorAttribute', 'pseudoClass', 'pseudoElement', 'selectorUniversal', 'selectorNesting', 'selectorCombinator', 'selectorNamespace']) {
    assert(selectorTokens.some(token => legend[token.tokenType] === kind), `Missing bundled selector token: ${kind}`)
  }
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
    const formatted = await call('format', '.a{color:red}', { tabWidth: 2, useTabs: false, printWidth: 80, endOfLine: 'lf' })
    assert.equal(formatted.text, '.a {\n  color: red;\n}\n')
    await call('update', 'untitled:css-smoke.xcss', '@vars { --t: time; } .a { dispay: flex; display: fex; width: --t; }', 1)
    const diagnostics = await call('cssDiagnostics', 'untitled:css-smoke.xcss', { checkCssProperties: true, checkCssValues: true })
    assert.deepEqual(diagnostics.map(d => d.code), ['css.unknown-property', 'css.invalid-value', 'css.type-mismatch'])
  } finally { await worker.terminate() }
  console.log('Bundled registry packages, integrity, and host-native loading verified')
}

const target = hostTarget()
if (process.argv[2] === '--smoke') {
  await verify(process.argv[3], target)
} else {
  const root = await mkdtemp(join(tmpdir(), 'crossbreeze-bundle-'))
  try {
    await cp(join(bundleRoot, 'common', 'server'), root, { recursive: true })
    await cp(join(bundleRoot, target, 'server'), root, { recursive: true })
    // Windows keeps the loaded native library open until the process exits.
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--smoke', root], { stdio: 'inherit' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
