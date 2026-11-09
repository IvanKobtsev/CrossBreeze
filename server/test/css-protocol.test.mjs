import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function client(t, initializationOptions = {}, configure) {
  const root = mkdtempSync(join(tmpdir(), 'crossbreeze-css-'))
  const child = spawn(process.execPath, [resolve('server/out/index.cjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  let buffer = Buffer.alloc(0), id = 0, stderr = ''
  const requests = new Map(), listeners = new Set(), notifications = []
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const split = buffer.indexOf('\r\n\r\n')
      if (split < 0) return
      const length = Number(buffer.subarray(0, split).toString().match(/Content-Length: (\d+)/i)?.[1])
      if (buffer.length < split + 4 + length) return
      const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString())
      buffer = buffer.subarray(split + 4 + length)
      if (message.method === 'workspace/configuration' && configure) {
        const result = message.params.items.map(configure)
        const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
        child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      } else if (message.id !== undefined) { requests.get(message.id)?.(message); requests.delete(message.id) }
      else { notifications.push(message); for (const listener of [...listeners]) listener(message) }
    }
  })
  function send(method, params, requestId) {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, ...(requestId === undefined ? {} : { id: requestId }) })
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  function request(method, params) {
    const requestId = ++id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out: ${method}; ${stderr}`)), 10000)
      requests.set(requestId, value => { clearTimeout(timer); resolve(value) })
      send(method, params, requestId)
    })
  }
  function diagnostic(uri, version, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`No diagnostics for ${uri}@${version}; ${stderr}; ${JSON.stringify(notifications)}`)) }, 10000)
      const listener = message => {
        if (message.method === 'textDocument/publishDiagnostics' && message.params.uri === uri && message.params.version === version && predicate(message.params.diagnostics)) {
          clearTimeout(timer); listeners.delete(listener); resolve(message.params.diagnostics)
        }
      }
      listeners.add(listener)
    })
  }
  await request('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: { workspace: { configuration: Boolean(configure) } }, initializationOptions })
  send('initialized', {})
  const uri = pathToFileURL(join(root, 'app.xcss')).href
  const open = (uri, text, languageId = 'xcss') => send('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } })
  const edit = (uri, version, text) => send('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })
  return { root, uri, send, request, diagnostic, open, edit, notifications }
}

test('CSS warnings merge with XCSS, map typed values, clear on correction and honor settings', { timeout: 20000 }, async t => {
  const c = await client(t)
  const text = '/* 😀 */ @vars { --duration: time = 1s; } .a { dispay: flex; display: fex; width: --duration; @:missing; }'
  let pending = c.diagnostic(c.uri, 1)
  c.open(c.uri, text)
  let diagnostics = await pending
  assert(diagnostics.some(d => d.source === 'XCSS' && d.code === 'XC-212'))
  assert.deepEqual(diagnostics.filter(d => d.source === 'CSS').map(d => d.code), ['css.unknown-property', 'css.invalid-value', 'css.type-mismatch'])
  assert.equal(diagnostics.find(d => d.code === 'css.type-mismatch').range.start.character, text.lastIndexOf('--duration'))
  assert(diagnostics.every(d => !d.message.includes('1s') || d.source !== 'CSS'))
  pending = c.diagnostic(c.uri, 2)
  c.edit(c.uri, 2, '.a { display: flex; width: 1px; }')
  assert.deepEqual(await pending, [])

  c.send('workspace/didChangeConfiguration', { settings: { crossbreeze: { checkCssProperties: false, checkCssValues: true } } })
  pending = c.diagnostic(c.uri, 3)
  c.edit(c.uri, 3, '.a { dispay: flex; display: fex; }')
  assert.deepEqual((await pending).filter(d => d.source === 'CSS').map(d => d.code), ['css.invalid-value'])
  pending = c.diagnostic(c.uri, 3, ds => ds.some(d => d.code === 'css.unknown-property'))
  c.send('workspace/didChangeConfiguration', { settings: { crossbreeze: { checkCssProperties: true, checkCssValues: false } } })
  assert.deepEqual((await pending).filter(d => d.source === 'CSS').map(d => d.code), ['css.unknown-property'])
  pending = c.diagnostic(c.uri, 3, ds => ds.length === 0)
  c.send('workspace/didChangeConfiguration', { settings: { crossbreeze: { checkCssProperties: false, checkCssValues: false } } })
  assert.deepEqual(await pending, [])
})

test('initialization settings, dependency edits, latest unsaved revision and close', { timeout: 20000 }, async t => {
  const c = await client(t, { checkCssProperties: false, checkCssValues: true })
  const library = pathToFileURL(join(c.root, 'lib.xcss')).href
  const source = '@injection paint($p: time = 1s) { width: $p; }'
  writeFileSync(join(c.root, 'lib.xcss'), source)
  let appPending = c.diagnostic(c.uri, 1)
  let libPending = c.diagnostic(library, 1)
  c.open(c.uri, '@import lib from "./lib"; .a { dispay: flex; @:lib.paint; }')
  c.open(library, source)
  assert(!(await appPending).some(d => d.source === 'CSS'))
  assert((await libPending).some(d => d.code === 'css.type-mismatch'))
  appPending = c.diagnostic(c.uri, 1)
  libPending = c.diagnostic(library, 3)
  c.edit(library, 2, '@injection paint($p: color = red) { width: $p; }')
  c.edit(library, 3, '@injection paint($p: length = 1px) { width: $p; }')
  assert.deepEqual(await libPending, [])
  assert(!c.notifications.some(n => n.method === 'textDocument/publishDiagnostics' && n.params.uri === library && n.params.version === 2), 'superseded unsaved revision must not publish')
  assert(!(await appPending).some(d => d.source === 'CSS'))
  const result = await c.request('textDocument/hover', { textDocument: { uri: c.uri }, position: { line: 0, character: 62 } })
  assert(!result.error)
  const before = c.notifications.length
  c.send('textDocument/didClose', { textDocument: { uri: library } })
  await c.request('textDocument/semanticTokens/full', { textDocument: { uri: c.uri } })
  assert(c.notifications.slice(before).some(n => n.method === 'textDocument/publishDiagnostics' && n.params.uri === library && n.params.diagnostics.length === 0))
})

test('stylesheet diagnostics preserve analyzer metadata and make missing tokens visible', { timeout: 20000 }, async t => {
  const c = await client(t, { checkCssProperties: false, checkCssValues: false })
  const text = '/* 😀 */ bogus;\r\n@variants V: .missing;\r\n@vars { --x: mystery; }\r\n.a { @:missing; }\r\n.b {'
  let pending = c.diagnostic(c.uri, 1)
  c.open(c.uri, text)
  const diagnostics = await pending
  assert.deepEqual(new Set(diagnostics.map(d => d.code)), new Set(['XC-105', 'XC-106', 'XC-212', 'XC-311', 'XC-403']))
  assert(diagnostics.every(d => d.source === 'XCSS' && d.severity === 1))
  const syntax = diagnostics.find(d => d.code === 'XC-105')
  assert.deepEqual(syntax.range, { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } })
  assert.equal(syntax.message, 'XC-105 Invalid XCSS statement — Expected a declaration or rule')
  assert.deepEqual(diagnostics.find(d => d.code === 'XC-106').range, {
    start: { line: 4, character: 3 }, end: { line: 4, character: 4 },
  })
  pending = c.diagnostic(c.uri, 2)
  c.edit(c.uri, 2, '@injection a {} @injection a {}')
  const [duplicate] = await pending
  assert.equal(duplicate.code, 'XC-207')
  assert.deepEqual(duplicate.relatedInformation[0].location, {
    uri: c.uri, range: { start: { line: 0, character: 11 }, end: { line: 0, character: 12 } },
  })
  pending = c.diagnostic(c.uri, 3)
  c.edit(c.uri, 3, '.valid {}')
  assert.deepEqual(await pending, [])
})

test('TypeScript diagnostics use the selected project and live stylesheets', { timeout: 25000 }, async t => {
  const configs = new Map()
  const c = await client(t, {}, item => configs.get(item.scopeUri) ?? null)
  const file = path => pathToFileURL(join(c.root, path)).href
  for (const directory of ['first', 'second', 'node_modules/shared-config']) mkdirSync(join(c.root, directory), { recursive: true })
  writeFileSync(join(c.root, 'node_modules/shared-config/package.json'), '{"name":"shared-config","version":"1.0.0"}')
  const sharedConfig = join(c.root, 'node_modules/shared-config/tsconfig.json')
  const sharedText = '{"compilerOptions":{"strict":true}}'
  writeFileSync(sharedConfig, sharedText)
  const app = file('first/app.ts')
  const other = file('second/app.tsx')
  const config = file('first/tsconfig.app.json')
  const style = file('first/theme.xcss')
  const configText = JSON.stringify({
    extends: 'shared-config/tsconfig.json',
    compilerOptions: { paths: { '@styles/*': ['./*'] } },
    files: ['app.ts'],
  })
  writeFileSync(join(c.root, 'first/tsconfig.app.json'), configText)
  writeFileSync(join(c.root, 'first/theme.xcss'), '@variants V: .one; .one {}')
  writeFileSync(join(c.root, 'second/tsconfig.json'), '{"compilerOptions":{"jsx":"preserve"},"files":["app.tsx"]}')
  writeFileSync(join(c.root, 'second/theme.xcss'), '.other {}')
  configs.set(app, config)
  configs.set(other, file('second/tsconfig.json'))
  const bad = "/* 😀 */ import s, { type Variants } from '@styles/theme.xcss';\r\nimport missing from './absent.xcss';\r\nconst v: Variants<'V'> = 'two'; type W = Variants<'Wrong'>; s.missing;"
  let pending = c.diagnostic(app, 1, ds => ds.length === 4)
  const otherPending = c.diagnostic(other, 1, ds => ds.some(d => d.code === 'XC-001'))
  c.open(app, bad, 'typescript')
  c.open(other, "import s from './theme.xcss'; s.missing;", 'typescriptreact')
  const diagnostics = await pending
  assert.deepEqual(new Set(diagnostics.map(d => d.code)), new Set(['XC-001', 'XC-002', 'XC-003', 'XC-004']))
  assert(diagnostics.every(d => d.severity === 1 && d.source === 'XCSS'))
  const lastLine = bad.split('\r\n')[2]
  assert.deepEqual(diagnostics.find(d => d.code === 'XC-001').range, {
    start: { line: 2, character: lastLine.lastIndexOf('missing') },
    end: { line: 2, character: lastLine.length - 1 },
  })
  await otherPending

  pending = c.diagnostic(app, 3, ds => ds.length === 2)
  c.edit(app, 2, '')
  c.edit(app, 3, "import s, { type Variants } from '@styles/theme.xcss'; const v: Variants<'V'> = 'two'; s.missing;")
  assert.deepEqual((await pending).map(d => d.code), ['XC-003', 'XC-001'])
  assert(!c.notifications.some(n => n.params?.uri === app && n.params.version === 2))
  pending = c.diagnostic(app, 3, ds => ds.length === 0)
  c.open(style, '@variants V: .two; .two {} .missing {}')
  assert.deepEqual(await pending, [])
  pending = c.diagnostic(app, 3, ds => ds.length === 2)
  c.send('textDocument/didClose', { textDocument: { uri: style } })
  await pending

  pending = c.diagnostic(app, 3, ds => ds.length === 0)
  c.open(config, '{ invalid:', 'json')
  assert.deepEqual(await pending, [])
  pending = c.diagnostic(app, 3, ds => ds.length === 2)
  c.edit(config, 2, configText)
  await pending
  pending = c.diagnostic(app, 3, ds => ds.length === 0)
  writeFileSync(sharedConfig, '{ invalid:')
  assert.deepEqual(await pending, [])
  pending = c.diagnostic(app, 3, ds => ds.length === 2)
  writeFileSync(sharedConfig, sharedText)
  await pending
  pending = c.diagnostic(app, undefined, ds => ds.length === 0)
  c.send('textDocument/didClose', { textDocument: { uri: app } })
  assert.deepEqual(await pending, [])
})
