import { Worker } from 'node:worker_threads'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createConnection, TextDocuments, TextDocumentSyncKind, ResponseError, LSPErrorCodes, ErrorCodes, type CancellationToken, type Position, type InitializeParams } from 'vscode-languageserver/node.js'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { watch, type FSWatcher } from 'chokidar'
import { languageServiceCapabilities, type EditorDocument, type EditorHover, type EditorLocation } from '@cross-css/native'
import { canonicalUri, isExcludedPath, type Aliases } from './project.js'

const [major, minor] = process.versions.node.split('.').map(Number)
if (!(major === 20 && minor >= 19 || major === 22 && minor >= 12 || major > 22)) {
  process.stderr.write('CrossBreeze requires Node.js 20.19.x or Node.js 22.12 or newer. Configure a supported local Node interpreter in WebStorm.\n')
  process.exit(1)
}
const connection = createConnection(process.stdin, process.stdout)
const documents = new TextDocuments(TextDocument)
const worker = new Worker(join(__dirname, 'worker.cjs'))
let nextId = 0, epoch = 0, shutdown = false
let pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
function call<T>(method: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); worker.postMessage({ id, method, args }) })
}
worker.on('message', ({ id, result, error, warning, watchPaths }) => {
  if (watchPaths) { watcher?.add(watchPaths); return }
  if (warning) { connection.console.warn(warning); return }
  const request = pending.get(id)
  if (!request) return
  pending.delete(id)
  if (error) request.reject(new Error(error)); else request.resolve(result)
})
worker.on('error', error => { for (const item of pending.values()) item.reject(error); pending.clear(); connection.window.showErrorMessage(`CrossBreeze analysis stopped: ${error.message}. Restart the language server.`) })
worker.on('exit', code => { if (!shutdown) { for (const item of pending.values()) item.reject(new Error(`Analysis worker exited (${code})`)); pending.clear(); process.exitCode = 1; connection.dispose() } })
let ready: Promise<unknown> = Promise.resolve()
let watcher: FSWatcher | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let options: { aliases?: Aliases; excludedRoots?: string[] } = {}
const open = new Map<string, { uri: string; version: number }>()
const failed = (error: unknown) => connection.console.error(String(error))
function scheduleDiagnostics() {
  clearTimeout(timer)
  timer = setTimeout(() => { void publish().catch(failed) }, 150)
}
async function publish() {
  await ready
  const generation = epoch
  for (const [uri, document] of open) {
    const result = await call<EditorDocument>('document', uri)
    if (generation !== epoch || open.get(uri)?.version !== document.version) return
    connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics: result.diagnostics.map(d => ({
      range: d.location.range, code: d.code, source: 'XCSS', message: d.message,
      severity: d.severity === 'error' ? 1 : d.severity === 'warning' ? 2 : 3,
      relatedInformation: d.related.map(location => ({ location, message: 'Related declaration' })),
    })) })
  }
}
connection.onInitialize((params: InitializeParams) => {
  options = params.initializationOptions ?? {}
  const roots = (params.workspaceFolders?.map(folder => folder.uri) ?? (params.rootUri ? [params.rootUri] : [])).filter(uri => uri.startsWith('file:')).map(uri => fileURLToPath(canonicalUri(uri)))
  ready = call('initialize', roots, options.aliases ?? {}, options.excludedRoots ?? [])
  watcher = watch(roots, { ignoreInitial: true, followSymlinks: false, ignored: (path, stats) =>
    isExcludedPath(path, roots, options.excludedRoots) || Boolean(stats?.isFile() && !path.endsWith('.xcss') && !path.endsWith('.json')),
  })
  watcher.on('all', (event, path) => {
    if (!['add', 'change', 'unlink'].includes(event)) return
    epoch++
    ready = ready.then(() => call('change', pathToFileURL(path).href))
    ready.catch(failed)
    scheduleDiagnostics()
  })
  watcher.on('error', error => connection.console.warn(`CrossBreeze file watcher: ${String(error)}`))
  const capabilities = languageServiceCapabilities()
  return { capabilities: { positionEncoding: 'utf-16', textDocumentSync: TextDocumentSyncKind.Incremental,
    definitionProvider: true, referencesProvider: true, hoverProvider: true,
    semanticTokensProvider: { legend: { tokenTypes: capabilities.tokenTypes, tokenModifiers: capabilities.tokenModifiers }, full: true },
  }, serverInfo: { name: 'CrossBreeze', version: '0.1.0' } }
})
documents.onDidChangeContent(({ document }) => {
  const uri = canonicalUri(document.uri)
  if ((open.get(uri)?.version ?? -1) >= document.version) return
  open.set(uri, { uri: document.uri, version: document.version })
  epoch++
  ready = ready.then(() => call('update', uri, document.getText(), document.version))
  ready.catch(failed)
  scheduleDiagnostics()
})
documents.onDidClose(({ document }) => {
  const uri = canonicalUri(document.uri)
  open.delete(uri)
  epoch++
  ready = ready.then(() => call('close', uri))
  ready.catch(failed)
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] })
  scheduleDiagnostics()
})
connection.onDidChangeConfiguration(({ settings }) => {
  epoch++
  ready = ready.then(() => call('configure', settings?.crossbreeze?.aliases ?? {}))
  ready.catch(failed)
  scheduleDiagnostics()
})
connection.onDidChangeWatchedFiles(({ changes }) => {
  epoch++
  ready = ready.then(async () => { for (const change of changes) await call('change', change.uri) })
  ready.catch(failed)
  scheduleDiagnostics()
})
async function query<T>(method: string, uri: string, token: CancellationToken, position?: Position, includeDeclaration?: boolean): Promise<T> {
  const generation = epoch
  await ready
  if (token.isCancellationRequested) throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Request canceled')
  const result = await call<T>(method, canonicalUri(uri), position, includeDeclaration)
  if (token.isCancellationRequested) throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Request canceled')
  if (generation !== epoch) throw new ResponseError(LSPErrorCodes.ContentModified, 'Document changed during analysis')
  return result
}
connection.onDefinition((params, token) => query<EditorLocation[]>('definition', params.textDocument.uri, token, params.position))
connection.onReferences((params, token) => query<EditorLocation[]>('references', params.textDocument.uri, token, params.position, params.context.includeDeclaration))
connection.onHover(async (params, token) => {
  const hover = await query<EditorHover | null>('hover', params.textDocument.uri, token, params.position)
  return hover ? { contents: { kind: 'plaintext' as const, value: hover.text }, range: hover.range } : null
})
connection.languages.semanticTokens.on(async (params, token) => {
  const document = await query<EditorDocument>('document', params.textDocument.uri, token)
  const data: number[] = []
  let line = 0, character = 0
  for (const item of document.tokens) {
    data.push(item.line - line, item.line === line ? item.character - character : item.character, item.length, item.tokenType, item.declaration ? 1 : 0)
    line = item.line; character = item.character
  }
  return { data }
})
connection.onShutdown(async () => { shutdown = true; clearTimeout(timer); await watcher?.close(); await worker.terminate() })
connection.onExit(() => { shutdown = true; void worker.terminate() })
documents.listen(connection)
connection.listen()
