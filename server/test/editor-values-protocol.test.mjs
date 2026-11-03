import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'


test('color protocol, definition links, latest revisions and semantic value tokens', {timeout:20000}, async t => {
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

  const init = await request('initialize', {processId:process.pid, capabilities:{textDocument:{definition:{linkSupport:true}}},workspaceFolders:[]})
  assert.equal(init.result.capabilities.colorProvider,true)
  send({jsonrpc:'2.0',method:'initialized',params:{}})
  const uri='untitled:values.xcss', source='/* 😀 */ $tone = red; .a { color: $tone; background: linear-gradient(#fff, rgba(0,0,0,.5)); cursor: pointer; }'
  send({jsonrpc:'2.0',method:'textDocument/didOpen',params:{textDocument:{uri,languageId:'xcss',version:1,text:source}}})
  const refs=await request('textDocument/definition',{textDocument:{uri},position:{line:0,character:source.lastIndexOf('$tone')+2}})
  assert.equal(refs.result.length,1)
  const link=refs.result[0]
  assert.equal(link.targetUri,uri)
  assert.equal(link.originSelectionRange.start.character,source.lastIndexOf('$tone'))
  assert.equal(link.originSelectionRange.end.character,source.lastIndexOf('$tone')+5)
  const colors=(await request('textDocument/documentColor',{textDocument:{uri}})).result
  assert.equal(colors.length,3)
  assert.equal(colors[1].range.start.character,source.indexOf('#fff'))
  const picker=(await request('textDocument/colorPresentation',{textDocument:{uri},range:colors[1].range,color:{red:0,green:1,blue:0,alpha:.5}})).result
  assert.equal(picker[0].textEdit.newText,'#00ff0080')
  assert.deepEqual(picker[0].textEdit.range,colors[1].range)
  const invalid=(await request('textDocument/colorPresentation',{textDocument:{uri},range:{start:{line:0,character:0},end:{line:0,character:1}},color:colors[0].color})).result
  assert.deepEqual(invalid,[])
  send({jsonrpc:'2.0',method:'textDocument/didChange',params:{textDocument:{uri,version:2},contentChanges:[{text:'.a { color: hsl(120 100% 50%); filter: blur(2px); position: relative; }'}]}})
  const updated=(await request('textDocument/documentColor',{textDocument:{uri}})).result
  assert.equal(updated.length,1)
  assert.deepEqual(updated[0].color,{red:0,green:1,blue:0,alpha:1})
  const semantic=(await request('textDocument/semanticTokens/full',{textDocument:{uri}})).result.data
  const legend=init.result.capabilities.semanticTokensProvider.legend.tokenTypes
  const kinds=Array.from({length:semantic.length/5},(_,i)=>legend[semantic[i*5+3]])
  for(const kind of ['cssColor','cssFunction','cssKeyword'])assert(kinds.includes(kind),kind)
  send({jsonrpc:'2.0',method:'textDocument/didClose',params:{textDocument:{uri}}})
  await request('shutdown',null)
  send({jsonrpc:'2.0',method:'exit'})
  assert(!stderr.includes('Error:'),stderr)
})
