import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { formatOptions, formatEdits } from '../out/formatting.cjs'

test('formatter options use IDE settings and support additional LSP options', () => {
  assert.deepEqual(formatOptions({ tabSize: 4, insertSpaces: false }), { tabWidth: 4, useTabs: true, printWidth: 80, endOfLine: 'lf' })
  assert.deepEqual(formatOptions({ tabSize: 4, insertSpaces: true, 'crossbreeze.printWidth': 60 }, { tabWidth: 2, useTabs: true, printWidth: 100, endOfLine: 'crlf' }), { tabWidth: 2, useTabs: true, printWidth: 60, endOfLine: 'crlf' })
  assert.throws(() => formatOptions({ tabSize: 0, insertSpaces: true }))
  assert.throws(() => formatOptions({ tabSize: 2, insertSpaces: true, 'crossbreeze.endOfLine': 'wrong' }))
})
test('format edits use UTF-16 positions and reject invalid syntax without replacement', () => {
  assert.deepEqual(formatEdits('😀', { text: '😀', diagnostics: [] }), [])
  assert.deepEqual(formatEdits('/* 😀 */\r\n.a{}', { text: 'formatted', diagnostics: [] })[0].range.end, { line: 1, character: 4 })
  assert.equal(formatEdits('😀', { text: 'formatted', diagnostics: [] })[0].range.end.character, 2)
  assert.throws(() => formatEdits('broken', { diagnostics: [{ message: 'Unclosed block', code: 'syntax' }] }), /Unclosed block/)
})

test('formatting protocol: unsaved source, settings, errors, cancellation and stale results', { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, [resolve('server/out/index.cjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  let buffer = Buffer.alloc(0), id = 0, configHandler
  const pending = new Map()
  const send = message => { const body = JSON.stringify(message); child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`) }
  const request = (method, params) => { const requestId = ++id; const promise = new Promise(resolve => pending.set(requestId, resolve)); send({ jsonrpc: '2.0', id: requestId, method, params }); return promise }
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const split = buffer.indexOf('\r\n\r\n')
      if (split < 0) return
      const length = Number(buffer.subarray(0, split).toString().match(/Content-Length: (\d+)/i)?.[1])
      if (buffer.length < split + 4 + length) return
      const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length))
      buffer = buffer.subarray(split + 4 + length)
      if (message.method === 'workspace/configuration') {
        configHandler?.(message)
      } else if (message.id !== undefined) { pending.get(message.id)?.(message); pending.delete(message.id) }
    }
  })
  const initialized = await request('initialize', { processId: process.pid, capabilities: { workspace: { configuration: true } }, workspaceFolders: [] })
  assert.equal(initialized.result.capabilities.documentFormattingProvider, true)
  assert.equal(initialized.result.capabilities.documentRangeFormattingProvider, undefined)
  send({ jsonrpc: '2.0', method: 'initialized', params: {} })
  const uri = 'untitled:format.xcss'
  let version = 0
  const update = text => send({ jsonrpc: '2.0', method: version ? 'textDocument/didChange' : 'textDocument/didOpen', params: version
    ? { textDocument: { uri, version: ++version }, contentChanges: [{ text }] }
    : { textDocument: { uri, languageId: 'xcss', version: ++version, text } } })
  const params = { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } }
  const settings = { useTabs: true, tabWidth: 4, printWidth: 80, endOfLine: 'crlf' }
  configHandler = message => send({ jsonrpc: '2.0', id: message.id, result: [settings] })
  update('/* 😀 */ .a{color:red}')
  const formatted = await request('textDocument/formatting', params)
  assert.equal(formatted.result[0].newText, '/* 😀 */\r\n.a {\r\n\tcolor: red;\r\n}\r\n')
  assert.equal(formatted.result[0].range.end.character, 22)
  update(formatted.result[0].newText)
  assert.deepEqual((await request('textDocument/formatting', params)).result, [])
  update('.a{')
  assert.equal((await request('textDocument/formatting', params)).error.code, -32803)
  update('.a{color:$missing;}')
  assert((await request('textDocument/formatting', params)).result.length > 0)
  // Hold configuration to deterministically exercise change/cancellation races.
  let received
  const configRequest = () => new Promise(resolve => { configHandler = message => { received = message; resolve() } })
  let waiting = configRequest()
  const stale = request('textDocument/formatting', params)
  await waiting
  update('.a{color:blue}')
  // A query following didChange ensures the new revision has reached the server.
  await request('textDocument/semanticTokens/full', { textDocument: { uri } })
  send({ jsonrpc: '2.0', id: received.id, result: [settings] })
  assert.equal((await stale).error.code, -32801)
  waiting = configRequest()
  const canceled = request('textDocument/formatting', params)
  const canceledId = id
  await waiting
  send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: canceledId } })
  send({ jsonrpc: '2.0', id: received.id, result: [settings] })
  assert.equal((await canceled).error.code, -32800)
  waiting = configRequest()
  const reopened = request('textDocument/formatting', params)
  await waiting
  send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } })
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'xcss', version, text: '.a{color:white}' } } })
  await request('textDocument/semanticTokens/full', { textDocument: { uri } })
  send({ jsonrpc: '2.0', id: received.id, result: [settings] })
  assert.equal((await reopened).error.code, -32801)
  await request('shutdown', null)
  send({ jsonrpc: '2.0', method: 'exit' })
})
