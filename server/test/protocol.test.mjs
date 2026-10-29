import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

test('stdio lifecycle, diagnostics, navigation, highlighting, unsaved edits and shutdown', { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'crossbreeze-lsp-'))
  const uri = pathToFileURL(join(root, 'app.xcss')).href
  writeFileSync(join(root, 'lib.xcss'), '@injection paint($p: color = red) { color: $p; }')
  const child = spawn(process.execPath, [resolve('server/out/index.cjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  let stderr = '', buffer = Buffer.alloc(0), id = 0
  child.stderr.on('data', chunk => { stderr += chunk })
  const pending = new Map(), notifications = []
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const split = buffer.indexOf('\r\n\r\n')
      if (split < 0) break
      const length = Number(buffer.subarray(0, split).toString().match(/Content-Length: (\d+)/i)?.[1])
      if (buffer.length < split + 4 + length) break
      const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString())
      buffer = buffer.subarray(split + 4 + length)
      if (message.id !== undefined) { pending.get(message.id)?.(message); pending.delete(message.id) }
      else notifications.push(message)
    }
  })
  function send(message) { const body = JSON.stringify(message); child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`) }
  function request(method, params) {
    const requestId = ++id
    const response = new Promise(resolve => pending.set(requestId, resolve))
    send({ jsonrpc: '2.0', id: requestId, method, params })
    return response
  }
  const initialize = await request('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {} })
  assert.equal(initialize.result.capabilities.hoverProvider, true)
  assert.equal(initialize.result.capabilities.semanticTokensProvider.full, true)
  send({ jsonrpc: '2.0', method: 'initialized', params: {} })
  const text = '/* 😀 */ @import lib from "./lib"; .button { @:lib.paint; }'
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'xcss', version: 1, text } } })
  const params = { textDocument: { uri }, position: { line: 0, character: text.indexOf('paint') } }
  const definition = await request('textDocument/definition', params)
  assert.equal(definition.result.length, 1, stderr)
  assert(definition.result[0].uri.endsWith('/lib.xcss'))
  const hover = await request('textDocument/hover', params)
  assert.match(hover.result.contents.value, /\$p: color = red/)
  assert.equal((await request('textDocument/references', { ...params, context: { includeDeclaration: true } })).result.length, 2)
  const tokens = await request('textDocument/semanticTokens/full', { textDocument: { uri } })
  assert(tokens.result.data.length > 0)
  assert.equal(tokens.result.data.length % 5, 0)
  send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: '.button { @:missing; }' }] } })
  assert.deepEqual((await request('textDocument/definition', { ...params, position: { line: 0, character: 13 } })).result, [])
  await new Promise(resolve => setTimeout(resolve, 300))
  assert(notifications.some(n => n.method === 'textDocument/publishDiagnostics' && n.params.version === 2 && n.params.diagnostics.some(d => d.code === 'binding.unknown-injection')), stderr)
  const canceled = request('textDocument/semanticTokens/full', { textDocument: { uri } })
  send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })
  const canceledResult = await canceled
  assert(canceledResult.result || canceledResult.error?.code === -32800)
  send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } })
  await request('shutdown', null)
  send({ jsonrpc: '2.0', method: 'exit' })
  assert(!stderr.includes('Error:'), stderr)
})
