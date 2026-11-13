import { Worker } from 'node:worker_threads'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createConnection, TextDocuments, TextDocumentSyncKind, ResponseError, LSPErrorCodes, ErrorCodes, DiagnosticSeverity, CompletionItemKind, type CancellationToken, type Position, type InitializeParams } from 'vscode-languageserver/node.js'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { watch, type FSWatcher } from 'chokidar'
import { languageServiceCapabilities, type EditorCompletion, type EditorDefinitionDetails, type EditorDiagnostic, type EditorDocument, type EditorExportedSymbol, type EditorHover, type EditorLocation, type SemanticToken } from '@cross-css/native'
import { canonicalUri, isExcludedPath, type Aliases } from './project.js'
import { defaultCssValidation, type CssValidationOptions } from './css-validation.js'
import { colorPresentation } from './css-values.js'
import type { ColorInformation, DefinitionLink } from 'vscode-languageserver'
import type { Diagnostic } from 'vscode-languageserver'
import * as native from '@cross-css/native'
import { formatEdits, formatOptions, type FormattingBinding, type SourceFormatResult } from './formatting.js'
import { typescriptFile, typescriptInput, type TypescriptTarget } from './typescript-projects.js'

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
worker.on('message', ({ id, result, error, warning, watchPaths, typescriptWatchPaths }) => {
  if (watchPaths) { watcher?.add(watchPaths); return }
  if (typescriptWatchPaths) { watchTypescriptPaths(typescriptWatchPaths); return }
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
let typescriptWatcher: FSWatcher | undefined
let watchedTypescriptPaths = new Set<string>()
let timer: ReturnType<typeof setTimeout> | undefined
let options: { aliases?: Aliases; excludedRoots?: string[] } & Partial<CssValidationOptions> = {}
let cssOptions = { ...defaultCssValidation }
let workspaceConfiguration = false
let definitionLinks = false
interface OpenDocument { uri: string; version: number; text: string; stylesheet: boolean; typescript: boolean }
const open = new Map<string, OpenDocument>()
const failed = (error: unknown) => connection.console.error(String(error))
function diskChanged(path: string) {
  epoch++
  ready = ready.then(() => call('change', pathToFileURL(path).href))
  ready.catch(failed)
  scheduleDiagnostics()
}
function watchTypescriptPaths(paths: string[]) {
  if (!typescriptWatcher || shutdown) return
  const next = new Set(paths)
  void typescriptWatcher.unwatch([...watchedTypescriptPaths].filter(path => !next.has(path)))
  typescriptWatcher.add(paths.filter(path => !watchedTypescriptPaths.has(path)))
  watchedTypescriptPaths = next
}
function scheduleDiagnostics() {
  clearTimeout(timer)
  timer = setTimeout(() => { void publish().catch(failed) }, 150)
}
async function typescriptTargets(uris: string[]): Promise<TypescriptTarget[]> {
  const targets = uris.map(uri => ({ uri: canonicalUri(uri) }))
  if (!workspaceConfiguration || !uris.length) return targets
  const configs = await connection.workspace.getConfiguration(uris.map(scopeUri => ({
    scopeUri, section: 'crossbreeze.typescriptProject',
  }))).catch(error => { failed(error); return [] })
  return targets.map((target, index) => ({
    ...target, config: typeof configs[index] === 'string' ? configs[index] : null,
  }))
}
let publishing = false
let publishAgain = false
async function publish() {
  if (publishing) { publishAgain = true; return }
  publishing = true
  try { await publishCurrent() } finally {
    publishing = false
    if (publishAgain && !shutdown) { publishAgain = false; scheduleDiagnostics() }
  }
}
async function publishCurrent() {
  const generation = epoch
  await ready
  if (generation !== epoch || shutdown) return
  const entries = [...open]
  const stylesheetResults = new Map<string, { document: OpenDocument; diagnostics: EditorDiagnostic[]; cssDiagnostics: Diagnostic[] }>()
  for (const [uri, document] of entries) {
    if (!document.stylesheet) continue
    const diagnostics = await call<EditorDiagnostic[]>('diagnostics', uri)
    const cssDiagnostics = await call<Diagnostic[]>('cssDiagnostics', uri, cssOptions).catch(error => {
      failed(error)
      return []
    })
    if (generation !== epoch || shutdown) return
    stylesheetResults.set(uri, { document, diagnostics, cssDiagnostics })
  }
  const typescript = entries.filter(([, document]) => document.typescript)
  const targets = await typescriptTargets(typescript.map(([, document]) => document.uri))
  if (generation !== epoch || shutdown) return
  if (!typescript.length && !watchedTypescriptPaths.size) {
    for (const value of stylesheetResults.values()) sendDiagnostics(value.document, value.diagnostics, value.cssDiagnostics)
    return
  }
  const results = await call<Map<string, EditorDiagnostic[]>>('typescriptDiagnostics', targets).catch(error => {
    failed(error)
    return new Map<string, EditorDiagnostic[]>()
  })
  if (generation !== epoch || shutdown) return
  const classWarnings = await call<Map<string, import('@cross-css/native').EditorWarning[]>>('typescriptClassWarnings', targets)
  if (generation !== epoch || shutdown) return
  for (const [uri, value] of stylesheetResults) sendDiagnostics(value.document, value.diagnostics, [
    ...value.cssDiagnostics, ...(classWarnings.get(uri) ?? []).map(w => ({ ...w, source: 'XCSS', severity: DiagnosticSeverity.Warning })),
  ])
  for (const [uri, document] of typescript) sendDiagnostics(document, results.get(uri) ?? [])
}
function sendDiagnostics(document: OpenDocument, nativeDiagnostics: EditorDiagnostic[], cssDiagnostics: Diagnostic[] = []) {
  const diagnostics = nativeDiagnostics.map((d): Diagnostic => ({
    range: visibleRange(document.text, d.location.range),
    code: d.code, source: 'XCSS', message: `${d.code} ${d.label} — ${d.message}`,
    severity: d.severity === 'error' ? DiagnosticSeverity.Error
      : d.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
    relatedInformation: d.related.map(location => ({
      location: { ...location, uri: open.get(location.uri)?.uri ?? location.uri },
      message: 'Related declaration',
    })),
  }))
  connection.sendDiagnostics({ uri: document.uri, version: document.version, diagnostics: [...diagnostics, ...cssDiagnostics] })
}
function visibleRange(text: string, range: Diagnostic['range']): Diagnostic['range'] {
  const { line, character } = range.start
  if (line !== range.end.line || character !== range.end.character) return range
  const source = text.split(/\r\n|\n|\r/)[line]
  if (!source?.length) return range
  if (character < source.length) {
    const length = source.codePointAt(character)! > 0xffff ? 2 : 1
    return { start: range.start, end: { line, character: character + length } }
  }
  const last = source.charCodeAt(source.length - 1)
  const previous = source.charCodeAt(source.length - 2)
  const length = last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? 2 : 1
  return { start: { line, character: source.length - length }, end: { line, character: source.length } }
}
connection.onInitialize((params: InitializeParams) => {
  workspaceConfiguration = params.capabilities.workspace?.configuration === true
  definitionLinks = params.capabilities.textDocument?.definition?.linkSupport === true
  options = params.initializationOptions ?? {}
  cssOptions = {
    checkCssProperties: options.checkCssProperties !== false,
    checkCssValues: options.checkCssValues !== false,
  }
  const roots = (params.workspaceFolders?.map(folder => folder.uri) ?? (params.rootUri ? [params.rootUri] : [])).filter(uri => uri.startsWith('file:')).map(uri => fileURLToPath(canonicalUri(uri)))
  ready = call('initialize', roots, options.aliases ?? {}, options.excludedRoots ?? [])
  watcher = watch(roots, { ignoreInitial: true, followSymlinks: false, ignored: (path, stats) =>
    isExcludedPath(path, roots, options.excludedRoots) || Boolean(stats?.isFile() && !typescriptInput.test(path)),
  })
  watcher.on('all', (event, path) => {
    if (['add', 'change', 'unlink'].includes(event)) diskChanged(path)
  })
  watcher.on('error', error => connection.console.warn(`CrossBreeze file watcher: ${String(error)}`))
  typescriptWatcher = watch([], { ignoreInitial: true, followSymlinks: false, ignored: (path, stats) =>
    ['.git', '.pnpm'].includes(basename(path)) || Boolean(stats?.isFile() && !typescriptInput.test(path)),
  })
  typescriptWatcher.on('all', (event, path) => {
    if (['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(event)) diskChanged(path)
  })
  typescriptWatcher.on('error', error => connection.console.warn(`CrossBreeze TypeScript file watcher: ${String(error)}`))
  const capabilities = languageServiceCapabilities()
  return { capabilities: { positionEncoding: 'utf-16', textDocumentSync: TextDocumentSyncKind.Incremental,
    definitionProvider: true, referencesProvider: true, hoverProvider: true, colorProvider: true,
    completionProvider: { triggerCharacters: ['.', '"', "'", '<'] },
    documentFormattingProvider: typeof (native as unknown as FormattingBinding).formatSource === 'function',
    semanticTokensProvider: { legend: { tokenTypes: capabilities.tokenTypes, tokenModifiers: capabilities.tokenModifiers }, full: true },
  }, serverInfo: { name: 'CrossBreeze', version: '0.1.0' } }
})
documents.onDidChangeContent(({ document }) => {
  const uri = canonicalUri(document.uri)
  if ((open.get(uri)?.version ?? -1) >= document.version) return
  const stylesheet = document.languageId === 'xcss'
  const typescript = uri.startsWith('file:') && typescriptFile.test(fileURLToPath(uri))
  const current = { uri: document.uri, version: document.version, text: document.getText(), stylesheet, typescript }
  open.set(uri, current)
  epoch++
  ready = ready.then(() => call('update', uri, current.text, current.version, stylesheet, current.uri))
  ready.catch(failed)
  scheduleDiagnostics()
})
documents.onDidClose(({ document }) => {
  const uri = canonicalUri(document.uri)
  open.delete(uri)
  epoch++
  ready = ready.then(() => call('close', uri, document.languageId === 'xcss'))
  ready.catch(failed)
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] })
  scheduleDiagnostics()
})
connection.onDidChangeConfiguration(({ settings }) => {
  cssOptions = {
    checkCssProperties: settings?.crossbreeze?.checkCssProperties ?? cssOptions.checkCssProperties,
    checkCssValues: settings?.crossbreeze?.checkCssValues ?? cssOptions.checkCssValues,
  }
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
async function currentQuery<T>(token: CancellationToken, run: (check: () => void) => Promise<T>): Promise<T> {
  const generation = epoch
  const check = () => {
    if (token.isCancellationRequested) throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Request canceled')
    if (generation !== epoch) throw new ResponseError(LSPErrorCodes.ContentModified, 'Document changed during analysis')
  }
  await ready
  check()
  const result = await run(check)
  check()
  return result
}
function query<T>(method: string, uri: string, token: CancellationToken, position?: Position, includeDeclaration?: boolean) {
  return currentQuery(token, () => call<T>(method, canonicalUri(uri), position, includeDeclaration))
}
function isTypescript(uri: string) {
  return uri.startsWith('file:') && typescriptFile.test(fileURLToPath(uri))
}
function editorUri(uri: string) {
  return open.get(canonicalUri(uri))?.uri ?? uri
}
async function typescriptQuery<T>(method: string, uri: string, position: Position | undefined, check: () => void) {
  const [target] = await typescriptTargets([editorUri(uri)])
  check()
  return call<T>('typescriptQuery', method, target, position)
}
connection.onDefinition(async (params, token) => {
  const { textDocument: { uri }, position } = params
  if (isTypescript(uri)) {
    const details = await currentQuery(token, check => typescriptQuery<EditorDefinitionDetails | null>('definition', uri, position, check))
    if (!details) return []
    const { targets: locations, origin: originSelectionRange } = details
    return definitionLinks
      ? locations.map(({ uri, range }) => ({ originSelectionRange, targetUri: editorUri(uri), targetRange: range, targetSelectionRange: range }))
      : locations.map(location => ({ ...location, uri: editorUri(location.uri) }))
  }
  if (definitionLinks) {
    const links = await query<DefinitionLink[]>('definitionLinks', uri, token, position)
    return links.map(link => ({ ...link, targetUri: editorUri(link.targetUri) }))
  }
  const locations = await query<EditorLocation[]>('definition', uri, token, position)
  return locations.map(location => ({ ...location, uri: editorUri(location.uri) }))
})
connection.onCompletion((params, token) => currentQuery(token, async check => {
  const { textDocument: { uri }, position } = params
  const items = isTypescript(uri)
    ? await typescriptQuery<EditorCompletion[]>('completion', uri, position, check)
    : await call<EditorCompletion[]>('completion', canonicalUri(uri), position)
  return items.map(item => ({
    label: item.label,
    kind: item.kind === 'class' ? CompletionItemKind.Class
      : item.kind === 'variantGroup' ? CompletionItemKind.Enum : CompletionItemKind.EnumMember,
    textEdit: { range: item.range, newText: item.newText },
  }))
}))
connection.onDocumentColor((params, token) => query<ColorInformation[]>('colors', params.textDocument.uri, token))
connection.onColorPresentation(async (params, token) => {
  const colors = await query<ColorInformation[]>('colors', params.textDocument.uri, token)
  const same = (a: ColorInformation) => a.range.start.line === params.range.start.line && a.range.start.character === params.range.start.character && a.range.end.line === params.range.end.line && a.range.end.character === params.range.end.character
  const document = documents.get(params.textDocument.uri)
  if (!document || !colors.some(same)) return []
  return colorPresentation(document.getText(params.range), params.color, params.range)
})
connection.onReferences((params, token) => currentQuery(token, async check => {
  const { textDocument: { uri }, position, context: { includeDeclaration } } = params
  const canonical = canonicalUri(uri)
  const typescript = isTypescript(uri)
  const locations = typescript ? [] : await call<EditorLocation[]>('references', canonical, position, includeDeclaration)
  check()
  const symbols = typescript
    ? await typescriptQuery<EditorExportedSymbol[]>('symbols', uri, position, check)
    : await call<EditorExportedSymbol[]>('symbols', canonical, position)
  if (symbols.length) {
    check()
    const sources = await call<string[]>('typescriptSources')
    const targets: TypescriptTarget[] = []
    for (let offset = 0; offset < sources.length; offset += 128) {
      check()
      targets.push(...await typescriptTargets(sources.slice(offset, offset + 128)))
    }
    check()
    locations.push(...await call<EditorLocation[]>('editorReferences', symbols, targets, includeDeclaration))
  }
  const unique = new Map<string, EditorLocation>()
  for (const { uri, range } of locations) {
    const { start, end } = range
    const key = JSON.stringify([canonicalUri(uri), start.line, start.character, end.line, end.character])
    unique.set(key, { uri: editorUri(uri), range })
  }
  return [...unique.values()]
}))
// Click navigation has a narrower scope than explicit Find Usages.
connection.onRequest('crossbreeze/navigation', (params: { textDocument: { uri: string }; position: Position }, token) => currentQuery(token, async check => {
  const { textDocument: { uri }, position } = params
  const kind = isTypescript(uri) ? 'definitions' : await call<string>('navigationKind', canonicalUri(uri), position)
  check()
  let locations: EditorLocation[]
  if (kind === 'definitions') {
    locations = isTypescript(uri)
      ? (await typescriptQuery<EditorDefinitionDetails | null>('definition', uri, position, check))?.targets ?? []
      : await call<EditorLocation[]>('definition', canonicalUri(uri), position)
  } else if (kind === 'classUsages') {
    const symbols = await call<EditorExportedSymbol[]>('symbols', canonicalUri(uri), position)
    const sources = await call<string[]>('typescriptSources')
    const targets = await typescriptTargets(sources)
    check()
    locations = await call<EditorLocation[]>('editorReferences', symbols, targets, false)
    locations = locations.filter(location => isTypescript(location.uri))
  } else {
    locations = await call<EditorLocation[]>('references', canonicalUri(uri), position, false)
    // Some engine symbols report their declaration even with includeDeclaration=false.
    const declarations = await call<EditorLocation[]>('definition', canonicalUri(uri), position)
    locations = locations.filter(location => !declarations.some(declaration => canonicalUri(declaration.uri) === canonicalUri(location.uri) && JSON.stringify(declaration.range) === JSON.stringify(location.range)))
  }
  check()
  return [...new Map(locations.map(location => {
    const mapped = { ...location, uri: editorUri(location.uri) }
    return [JSON.stringify(mapped), mapped]
  })).values()]
}))
connection.onHover(async (params, token) => {
  const hover = await query<EditorHover | null>('hover', params.textDocument.uri, token, params.position)
  return hover ? { contents: { kind: 'plaintext' as const, value: hover.text }, range: hover.range } : null
})
connection.onDocumentFormatting(async (params, token) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) throw new ResponseError(ErrorCodes.InvalidParams, 'Open an XCSS document before formatting')
  if (document.languageId !== 'xcss') return null
  const version = document.version
  const source = document.getText()
  const check = () => {
    if (token.isCancellationRequested) throw new ResponseError(LSPErrorCodes.RequestCancelled, 'Formatting canceled')
    if (documents.get(params.textDocument.uri) !== document || document.version !== version) throw new ResponseError(LSPErrorCodes.ContentModified, 'Document changed during formatting')
  }
  check()
  await ready
  check()
  try {
    const settings = workspaceConfiguration
      ? await connection.workspace.getConfiguration({ scopeUri: document.uri, section: 'crossbreeze.formatting' })
      : undefined
    check()
    const result = await call<SourceFormatResult>('format', source, formatOptions(params.options, settings))
    check()
    return formatEdits(source, result)
  } catch (error) {
    if (error instanceof ResponseError) throw error
    throw new ResponseError(LSPErrorCodes.RequestFailed, String(error instanceof Error ? error.message : error))
  }
})
connection.languages.semanticTokens.on(async (params, token) => {
  const uri = params.textDocument.uri
  const tokens = isTypescript(uri)
    ? await currentQuery(token, check => typescriptQuery<SemanticToken[]>('tokens', uri, undefined, check))
    : (await query<EditorDocument>('document', uri, token)).tokens
  const data: number[] = []
  let line = 0, character = 0
  for (const item of tokens) {
    data.push(item.line - line, item.line === line ? item.character - character : item.character, item.length, item.tokenType, item.declaration ? 1 : 0)
    line = item.line; character = item.character
  }
  return { data }
})
connection.onShutdown(async () => {
  shutdown = true
  clearTimeout(timer)
  await Promise.all([watcher?.close(), typescriptWatcher?.close()])
  await worker.terminate()
})
connection.onExit(() => { shutdown = true; void worker.terminate() })
documents.listen(connection)
connection.listen()
