import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function protocol(t, configuration) {
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
      if (message.method === 'workspace/configuration' && message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, result: message.params.items.map(configuration) })
      } else if (message.id !== undefined) { pending.get(message.id)?.(message); pending.delete(message.id) }
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
  return { send, request, notifications, stderr: () => stderr, requestId: () => id }
}

test('stdio lifecycle, diagnostics, navigation, highlighting, unsaved edits and shutdown', { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'crossbreeze-lsp-'))
  const uri = pathToFileURL(join(root, 'app.xcss')).href
  writeFileSync(join(root, 'lib.xcss'), '@injection paint($p: color = red) { color: $p; }')
  const { request, send, notifications, stderr, requestId } = protocol(t)
  const initialize = await request('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: {} })
  assert.equal(initialize.result.capabilities.hoverProvider, true)
  assert.equal(initialize.result.capabilities.semanticTokensProvider.full, true)
  assert(initialize.result.capabilities.completionProvider)
  send({ jsonrpc: '2.0', method: 'initialized', params: {} })
  const text = '/* 😀 */ @import lib from "./lib"; svg|a.button#main[data-kind="hello"]:not(.disabled)::after > * { &:hover { @:lib.paint; } }'
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'xcss', version: 1, text } } })
  const params = { textDocument: { uri }, position: { line: 0, character: text.indexOf('paint') } }
  const definition = await request('textDocument/definition', params)
  assert.equal(definition.result.length, 1, stderr())
  assert(definition.result[0].uri.endsWith('/lib.xcss'))
  const hover = await request('textDocument/hover', params)
  assert.match(hover.result.contents.value, /\$p: color = red/)
  assert.equal((await request('textDocument/references', { ...params, context: { includeDeclaration: true } })).result.length, 2)
  const tokens = await request('textDocument/semanticTokens/full', { textDocument: { uri } })
  assert(tokens.result.data.length > 0)
  assert.equal(tokens.result.data.length % 5, 0)
  const legend = initialize.result.capabilities.semanticTokensProvider.legend.tokenTypes
  const highlighted = []
  let line = 0, character = 0
  for (let i = 0; i < tokens.result.data.length; i += 5) {
    const [deltaLine, deltaCharacter, length, type] = tokens.result.data.slice(i, i + 5)
    line += deltaLine
    character = deltaLine === 0 ? character + deltaCharacter : deltaCharacter
    highlighted.push([legend[type], text.split('\n')[line].slice(character, character + length)])
  }
  assert(highlighted.some(([type, value]) => type === 'class' && value === 'button'))
  assert(highlighted.some(([type, value]) => type === 'class' && value === 'disabled'))
  for (const [kind, value] of [
    ['selectorNamespace', 'svg|'], ['selectorTag', 'a'], ['selectorId', 'main'],
    ['selectorAttribute', 'data-kind'], ['pseudoClass', ':not'], ['pseudoElement', '::after'],
    ['selectorCombinator', '>'], ['selectorUniversal', '*'], ['selectorNesting', '&'],
  ]) assert(highlighted.some(([type, name]) => type === kind && name === value), `${kind}: ${JSON.stringify(highlighted)}`)
  send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: '.button { @:missing; }' }] } })
  assert.deepEqual((await request('textDocument/definition', { ...params, position: { line: 0, character: 13 } })).result, [])
  await new Promise(resolve => setTimeout(resolve, 300))
  assert(notifications.some(n => n.method === 'textDocument/publishDiagnostics' && n.params.version === 2 && n.params.diagnostics.some(d => d.code === 'XC-212')), stderr())
  const canceled = request('textDocument/semanticTokens/full', { textDocument: { uri } })
  send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: requestId() } })
  const canceledResult = await canceled
  assert(canceledResult.result || canceledResult.error?.code === -32800)
  send({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } })
  await request('shutdown', null)
  send({ jsonrpc: '2.0', method: 'exit' })
  assert(!stderr().includes('Error:'), stderr())
})

test('stylesheet symbols cross TypeScript projects with unsaved edits and precise completion', { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'crossbreeze-symbols-'))
  const uri = file => pathToFileURL(join(root, file)).href
  const css = '.primary {} .secondary {}\n@variants Button: .primary, .secondary;\n@variants Other: .primary;\n.primary {}\n@vars { @provided --button-width: length; }\n@vars { @provided { --gap: length; } }'
  const ts = 'import { styles, cssVars as vars, type Variants as V } from "./theme.xcss";\n/* 😀 */ styles.primary; const value: V<"Button"> = "primary";\nvars.buttonWidth; vars["gap"];'
  const write = (file, text) => writeFileSync(join(root, file), text)
  write('theme.xcss', css)
  write('open.ts', 'export {};')
  write('closed.ts', 'import type { Variants as V } from "./theme.xcss"; const closed: V<"Button"> = "primary";')
  write('unconfigured.ts', 'import type { Variants as V } from "./theme.xcss"; const skipped: V<"Button"> = "primary";')
  write('tsconfig.app.json', JSON.stringify({ files: ['open.ts'], compilerOptions: { strict: true } }))
  write('tsconfig.other.json', JSON.stringify({ files: ['closed.ts', 'unconfigured.ts'], compilerOptions: { strict: true } }))
  const { request, send } = protocol(t, ({ scopeUri }) => scopeUri.endsWith('/open.ts')
    ? uri('tsconfig.app.json') : scopeUri.endsWith('/closed.ts') ? uri('tsconfig.other.json') : null)
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params })
  const initialized = await request('initialize', {
    rootUri: pathToFileURL(root).href,
    capabilities: { workspace: { configuration: true }, textDocument: { definition: { linkSupport: true } } },
  })
  assert(initialized.result.capabilities.completionProvider)
  notify('initialized', {})
  const open = (file, languageId, text) => notify('textDocument/didOpen', { textDocument: { uri: uri(file), languageId, text, version: 1 } })
  open('theme.xcss', 'xcss', css)
  open('open.ts', 'typescript', ts)
  const params = (file, line, character) => ({ textDocument: { uri: uri(file) }, position: { line, character } })
  const refs = async (source, includeDeclaration = false) => {
    const response = await request('textDocument/references', { ...source, context: { includeDeclaration } })
    assert(!response.error, JSON.stringify(response.error))
    return response.result
  }
  const secondLine = ts.split('\n')[1]
  const member = params('theme.xcss', 1, css.split('\n')[1].indexOf('.primary') + 1)
  const value = params('open.ts', 1, secondLine.indexOf('"primary"') + 1)
  const group = params('open.ts', 1, secondLine.indexOf('"Button"') + 1)
  const styles = params('open.ts', 1, secondLine.indexOf('styles.primary') + 'styles.'.length)
  const [valueLink] = (await request('textDocument/definition', value)).result
  assert.equal(valueLink.targetUri, uri('theme.xcss'))
  assert.deepEqual(valueLink.targetSelectionRange.start, member.position)
  assert.deepEqual((await request('textDocument/definition', group)).result[0].targetSelectionRange.start, { line: 1, character: 10 })
  const classLinks = (await request('textDocument/definition', styles)).result
  assert.deepEqual(classLinks.map(link => link.targetSelectionRange.start), [{ line: 0, character: 1 }, { line: 3, character: 1 }])
  assert.deepEqual(classLinks[0].originSelectionRange.start, styles.position)
  const navigate = async source => {
    const response = await request('crossbreeze/navigation', source)
    assert(!response.error, JSON.stringify(response.error))
    return response.result
  }
  assert.deepEqual((await navigate(styles)).map(location => location.range.start), classLinks.map(link => link.targetSelectionRange.start))
  assert.deepEqual((await navigate(member)).map(location => location.range.start), [{ line: 0, character: 1 }, { line: 3, character: 1 }])
  const classUsages = await navigate(params('theme.xcss', 0, 1))
  assert.equal(classUsages.length, 1)
  assert.equal(classUsages[0].uri, uri('open.ts'))
  const animation = '@keyframes fade { from { opacity: 0; } to { opacity: 1; } } .animated { animation: fade 1s; }'
  open('animation.xcss', 'xcss', animation)
  const animationUsages = await navigate(params('animation.xcss', 0, animation.indexOf('fade')))
  assert.deepEqual(animationUsages.map(location => location.range.start.character), [animation.lastIndexOf('fade')])
  const definitions = async (line, character) => (await request('textDocument/definition', params('open.ts', line, character))).result
  assert.deepEqual((await definitions(1, secondLine.indexOf('styles')))[0].targetSelectionRange.start, { line: 0, character: 0 })
  assert.deepEqual((await definitions(1, secondLine.indexOf('V<'))).map(link => link.targetSelectionRange.start.line), [1, 2])
  assert.deepEqual((await definitions(2, 0)).map(link => link.targetSelectionRange.start.line), [4, 5])
  assert.equal((await definitions(2, 5))[0].targetSelectionRange.start.line, 4)
  assert.equal((await definitions(2, 25))[0].targetSelectionRange.start.line, 5)
  const legend = initialized.result.capabilities.semanticTokensProvider.legend.tokenTypes
  const { result: { data } } = await request('textDocument/semanticTokens/full', { textDocument: { uri: uri('open.ts') } })
  const tokens = []
  let line = 0, character = 0
  for (let i = 0; i < data.length; i += 5) {
    const [lineDelta, characterDelta, length, kind] = data.slice(i, i + 5)
    line += lineDelta
    character = lineDelta ? characterDelta : character + characterDelta
    tokens.push([legend[kind], ts.split('\n')[line].slice(character, character + length)])
  }
  assert.deepEqual(tokens, [
    ['xcssImport', 'styles'], ['xcssImport', 'cssVars'], ['xcssImport', 'vars'],
    ['xcssImport', 'Variants'], ['xcssImport', 'V'], ['xcssImport', 'styles'], ['xcssClassMember', 'primary'],
    ['xcssImport', 'vars'], ['xcssProvidedVariable', 'buttonWidth'], ['xcssImport', 'vars'], ['xcssProvidedVariable', 'gap'],
  ])
  assert.deepEqual(new Set((await refs(member)).map(result => result.uri.split('/').at(-1))), new Set(['open.ts', 'closed.ts']))
  assert.equal((await refs(value, true)).length, 3)
  assert.equal((await refs(params('theme.xcss', 2, 18))).length, 0)
  assert.equal((await refs(params('theme.xcss', 0, 1))).length, 3)
  notify('textDocument/didChange', {
    textDocument: { uri: uri('open.ts'), version: 2 },
    contentChanges: [{ text: ts.replace('"primary"', '"sec"') }],
  })
  const completions = (await request('textDocument/completion', { ...value, position: { ...value.position, character: value.position.character + 3 } })).result
  const secondary = completions.find(item => item.label === 'secondary')
  assert.deepEqual(secondary.textEdit, {
    newText: 'secondary',
    range: { start: value.position, end: { line: 1, character: value.position.character + 3 } },
  })
  assert.deepEqual((await refs(member)).map(result => result.uri.split('/').at(-1)), ['closed.ts'])
  await request('shutdown', null)
  notify('exit')
})
