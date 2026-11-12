import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LanguageService, inspect, type EditorDiagnostic, type EditorExportedSymbol, type EditorLocation, type EditorPosition } from '@cross-css/native'
import { parse } from 'jsonc-parser'
import ts from 'typescript'
import { languageServiceCapabilities } from '@cross-css/native'

export const typescriptFile = /\.(?:ts|tsx|mts|cts)$/
export const typescriptInput = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|xcss)$/

export interface TypescriptTarget {
  uri: string
  // Undefined allows standalone LSP clients to use the nearest tsconfig.
  config?: string | null
}

function contains(root: string, path: string) {
  const local = relative(root, path)
  return local !== '..' && !local.startsWith('../') && !local.startsWith('..\\') && !isAbsolute(local)
}

function nearestConfig(path: string, roots: string[]) {
  for (let dir = dirname(path); roots.some(root => contains(root, dir)); dir = dirname(dir)) {
    const config = join(dir, 'tsconfig.json')
    if (existsSync(config)) return config
    if (dirname(dir) === dir) break
  }
}

interface Input { uri: string; text: string; style: boolean }
type OpenInputs = ReadonlyMap<string, { text: string; uri: string }>
type StyleInputs = ReadonlyMap<string, { text: string }>
type ResolveImport = (uri: string, specifier: string) => string | undefined
interface Inventory {
  files: Map<string, Input>
  watch: Set<string>
}

class Checker {
  private service = new LanguageService()
  private anchor?: string
  private revision = 0
  private inputs = new Map<string, Input>()
  private resolutions = new Map<string, Map<string, string | undefined>>()
  inventory?: Inventory

  update(config: string, files: Map<string, Input>, resolveImport: (uri: string, specifier: string) => string | undefined) {
    let anchor = dirname(config)
    for (const path of files.keys()) {
      while (!contains(anchor, path) && dirname(anchor) !== anchor) anchor = dirname(anchor)
    }
    if (this.anchor !== anchor) {
      this.service = new LanguageService()
      this.inputs.clear()
      this.resolutions.clear()
      this.revision = 0
      this.anchor = anchor
      this.service.setTypescriptProject(relative(anchor, config).replaceAll('\\', '/'))
    }
    const inputs = new Map<string, Input>()
    const preferred = new Map<string, string>()
    for (const [path, input] of files) {
      const id = relative(anchor, path).replaceAll('\\', '/')
      if (isAbsolute(id)) continue
      inputs.set(id, input)
      if (!preferred.has(input.uri)) preferred.set(input.uri, id)
      if (this.inputs.get(id)?.text === input.text) continue
      if (input.style) this.service.setFile(id, ++this.revision, input.text)
      else this.service.setTypescriptFile(id, ++this.revision, input.text)
    }
    for (const [id, input] of this.inputs) {
      if (inputs.has(id)) continue
      if (input.style) this.service.removeFile(id, ++this.revision)
      else this.service.removeTypescriptFile(id, ++this.revision)
      this.resolutions.delete(id)
    }
    for (const [id, input] of inputs) {
      if (!input.style) continue
      const before = this.resolutions.get(id)
      const next = new Map<string, string | undefined>()
      for (const specifier of inspect(input.text).imports) {
        const target = resolveImport(input.uri, specifier)
        const resolved = target && preferred.get(target)
        next.set(specifier, resolved)
        if (before?.get(specifier) !== resolved) this.service.setResolution(id, specifier, resolved)
      }
      for (const specifier of before?.keys() ?? []) {
        if (!next.has(specifier)) this.service.setResolution(id, specifier, undefined)
      }
      this.resolutions.set(id, next)
    }
    this.inputs = inputs
    return preferred
  }

  warning() { return this.service.typescriptProjectWarning() }

  private location(value: EditorLocation): EditorLocation {
    return { ...value, uri: this.inputs.get(value.uri)?.uri ?? pathToFileURL(join(this.anchor!, value.uri)).href }
  }

  diagnostics(id: string): EditorDiagnostic[] {
    return this.service.document(id, false).diagnostics.map(diagnostic => ({
      ...diagnostic, location: this.location(diagnostic.location), related: diagnostic.related.map(value => this.location(value)),
    }))
  }

  definition(id: string, position: EditorPosition) {
    const details = this.service.definitionDetails(id, position)
    return details && { ...details, targets: details.targets.map(value => this.location(value)) }
  }

  tokens(id: string) {
    const tokens = [...this.service.document(id).tokens]
    const input = this.inputs.get(id)
    if (!input) return tokens
    // Bind locally without loading a second TypeScript project or resolving modules.
    const source = ts.createSourceFile(id, input.text, ts.ScriptTarget.Latest, true)
    const host: ts.CompilerHost = {
      getSourceFile: name => name === id ? source : undefined,
      getDefaultLibFileName: () => '', writeFile: () => {}, getCurrentDirectory: () => '',
      getDirectories: () => [], fileExists: name => name === id,
      readFile: name => name === id ? input.text : undefined,
      getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    }
    const checker = ts.createProgram([id], { noLib: true, noResolve: true }, host).getTypeChecker()
    const bindings = new Set<ts.Symbol>()
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || !statement.moduleSpecifier.text.endsWith('.xcss')) continue
      const imports = statement.importClause?.namedBindings
      if (!imports || !ts.isNamedImports(imports)) continue
      for (const specifier of imports.elements) {
        if (!['styles', 'cssVars'].includes((specifier.propertyName ?? specifier.name).text)) continue
        const symbol = checker.getSymbolAtLocation(specifier.name)
        if (symbol) bindings.add(symbol)
      }
    }
    const tokenType = languageServiceCapabilities().tokenTypes.indexOf('xcssImport')
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && bindings.has(checker.getSymbolAtLocation(node)!)) {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
        if (!tokens.some(token => token.line === line && token.character === character)) {
          tokens.push({ line, character, length: node.text.length, tokenType, declaration: false })
        }
      }
      ts.forEachChild(node, visit)
    }
    if (tokenType >= 0 && bindings.size) visit(source)
    return tokens.sort((a, b) => a.line - b.line || a.character - b.character)
  }

  completion(id: string, position: EditorPosition) {
    return this.service.completion(id, position)
  }

  symbols(id: string, position: EditorPosition) {
    return this.service.symbolsAt(id, position)
      .flatMap(symbol => {
        const input = this.inputs.get(symbol.module)
        return input ? [{ ...symbol, module: input.uri }] : []
      })
  }

  references(symbols: EditorExportedSymbol[], preferred: Map<string, string>, includeDeclaration: boolean) {
    const local = symbols.flatMap(symbol => {
      const module = preferred.get(symbol.module)
      return module ? [{ ...symbol, module }] : []
    })
    return this.service.referencesForSymbols(local, includeDeclaration).map(value => this.location(value))
  }
}

export class TypescriptProjects {
  private checkers = new Map<string, Checker>()
  private warnings = new Set<string>()
  private sourceUris?: string[]

  constructor(
    private readonly roots: string[],
    private readonly skip: (path: string) => boolean,
    private readonly canonical: (uri: string) => string,
    private readonly warn: (message: string) => void,
  ) {}

  invalidateDisk() {
    this.sourceUris = undefined
    for (const checker of this.checkers.values()) checker.inventory = undefined
  }

  sources(open: OpenInputs) {
    if (!this.sourceUris) {
      const sources: string[] = []
      const scan = (dir: string) => {
        if (this.skip(dir)) return
        let entries
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) scan(path)
          else if (entry.isFile() && typescriptFile.test(path) && !this.skip(path)) {
            sources.push(this.canonical(pathToFileURL(path).href))
          }
        }
      }
      for (const root of this.roots) scan(root)
      this.sourceUris = sources
    }
    const sources = new Set(this.sourceUris)
    for (const uri of open.keys()) {
      if (!uri.startsWith('file:')) continue
      const path = fileURLToPath(uri)
      if (typescriptFile.test(path) && this.roots.some(root => contains(root, path)) && !this.skip(path)) sources.add(uri)
    }
    return [...sources]
  }

  watchPaths() {
    const paths = new Set<string>()
    for (const checker of this.checkers.values()) {
      for (const path of checker.inventory?.watch ?? []) paths.add(path)
    }
    return [...paths]
  }

  private read(path: string, files: Map<string, Input>) {
    if (!typescriptInput.test(path) || files.has(path)) return
    try {
      const text = readFileSync(path, 'utf8')
      files.set(path, { uri: this.canonical(pathToFileURL(path).href), text, style: path.endsWith('.xcss') })
    } catch { /* Missing or unreadable input. The checker reports config errors. */ }
  }

  private inventory(config: string): Inventory {
    const files = new Map<string, Input>()
    const watch = new Set<string>()
    const visited = new Set<string>()
    const scan = (dir: string, dependency: boolean, ancestors: Set<string>) => {
      if (visited.has(dir)) return
      visited.add(dir)
      let entries
      let real: string
      try {
        real = realpathSync.native(dir)
        if (ancestors.has(real)) return
        entries = readdirSync(dir, { withFileTypes: true })
      } catch { return }
      const parents = new Set(ancestors).add(real)
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.name === '.pnpm' || entry.name === '.git') continue
        if (entry.name === 'node_modules' && entry.isDirectory()) {
          watch.add(path)
          scan(path, true, parents)
        } else if (dependency || !this.skip(path)) {
          if (entry.isDirectory()) scan(path, dependency, parents)
          else if (entry.isFile()) this.read(path, files)
          else if (dependency && entry.isSymbolicLink()) {
            try {
              const target = realpathSync.native(path)
              watch.add(target)
              if (statSync(path).isDirectory()) scan(path, true, parents)
              else this.read(path, files)
            } catch { /* Broken dependency link. */ }
          }
        }
      }
    }
    for (const root of this.roots) scan(root, false, new Set())
    if (!this.roots.some(root => contains(root, config))) {
      watch.add(dirname(config))
      scan(dirname(config), false, new Set())
    }
    for (let dir = dirname(config); ; dir = dirname(dir)) {
      const modules = join(dir, 'node_modules')
      if (this.roots.some(root => contains(root, modules)) || existsSync(modules)) watch.add(modules)
      scan(modules, true, new Set())
      if (dirname(dir) === dir) break
    }
    this.read(config, files)
    return { files, watch }
  }

  private includeRelativeConfigs(config: string, files: Map<string, Input>, watch: Set<string>, seen = new Set<string>()) {
    if (seen.has(config)) return
    seen.add(config)
    const text = files.get(config)?.text
    if (!text) return
    const data = parse(text, [], { allowTrailingComma: true }) as {
      extends?: unknown
      references?: { path?: unknown }[]
    } | null
    const extended = Array.isArray(data?.extends) ? data.extends : [data?.extends]
    const references = Array.isArray(data?.references) ? data.references.map(reference => reference?.path) : []
    for (const value of [...extended, ...references]) {
      if (typeof value !== 'string' || !value.startsWith('.')) continue
      const path = resolve(dirname(config), value)
      const candidates = path.endsWith('.json') ? [path] : [`${path}.json`, join(path, 'tsconfig.json')]
      for (const candidate of candidates) {
        if (!this.roots.some(root => contains(root, candidate))) watch.add(candidate)
        this.read(candidate, files)
        if (!files.has(candidate)) continue
        this.includeRelativeConfigs(candidate, files, watch, seen)
        break
      }
    }
  }

  private groups(targets: TypescriptTarget[]) {
    const groups = new Map<string, { config: string; targets: TypescriptTarget[] }>()
    for (const target of targets) {
      if (!target.uri.startsWith('file:')) continue
      const config = target.config === undefined ? nearestConfig(fileURLToPath(target.uri), this.roots)
        : target.config?.startsWith('file:') ? fileURLToPath(target.config) : undefined
      if (!config) continue
      const key = this.canonical(pathToFileURL(config).href)
      const group = groups.get(key) ?? { config: fileURLToPath(key), targets: [] }
      group.targets.push(target)
      groups.set(key, group)
    }
    return groups
  }

  private prepare(key: string, config: string, open: OpenInputs, styles: StyleInputs, resolveImport: ResolveImport) {
    let checker = this.checkers.get(key)
    if (!checker) this.checkers.set(key, checker = new Checker())
    checker.inventory ??= this.inventory(config)
    const files = new Map<string, Input>()
    const known = new Set<string>()
    for (const [path, input] of checker.inventory.files) {
      const overlay = open.get(input.uri)
      files.set(path, overlay ? { ...input, text: overlay.text } : input)
      known.add(input.uri)
    }
    for (const [uri, input] of styles) {
      if (!uri.startsWith('file:') || known.has(uri)) continue
      const path = fileURLToPath(uri)
      files.set(path, { uri, text: input.text, style: true })
      known.add(uri)
    }
    for (const [uri, input] of open) {
      if (!uri.startsWith('file:') || known.has(uri)) continue
      const path = fileURLToPath(uri)
      if (typescriptInput.test(path)) files.set(path, { uri, text: input.text, style: path.endsWith('.xcss') })
    }
    this.includeRelativeConfigs(config, files, checker.inventory.watch)
    return { checker, preferred: checker.update(config, files, resolveImport) }
  }

  query(method: 'definition' | 'completion' | 'symbols' | 'tokens', target: TypescriptTarget, position: EditorPosition | undefined,
    open: OpenInputs, styles: StyleInputs, resolveImport: ResolveImport) {
    for (const [key, { config }] of this.groups([target])) {
      try {
        const { checker, preferred } = this.prepare(key, config, open, styles, resolveImport)
        const id = preferred.get(target.uri)
        if (id) return method === 'tokens' ? checker.tokens(id) : checker[method](id, position!)
      } catch (error) {
        this.checkers.delete(key)
        this.report(key, String(error))
      }
    }
    return method === 'definition' ? null : []
  }

  references(symbols: EditorExportedSymbol[], targets: TypescriptTarget[], includeDeclaration: boolean,
    open: OpenInputs, styles: StyleInputs, resolveImport: ResolveImport) {
    const locations: EditorLocation[] = []
    const groups = this.groups(targets)
    for (const key of this.checkers.keys()) if (!groups.has(key)) this.checkers.delete(key)
    for (const [key, { config, targets: group }] of groups) {
      try {
        const { checker, preferred } = this.prepare(key, config, open, styles, resolveImport)
        const sources = new Set(group.map(target => target.uri))
        locations.push(...checker.references(symbols, preferred, includeDeclaration)
          .filter(value => !typescriptFile.test(value.uri) || sources.has(value.uri)))
      } catch (error) {
        this.checkers.delete(key)
        this.report(key, String(error))
      }
    }
    return locations
  }

  diagnostics(targets: TypescriptTarget[], open: OpenInputs, styles: StyleInputs, resolveImport: ResolveImport) {
    const results = new Map<string, EditorDiagnostic[]>()
    for (const [key, { config, targets: group }] of this.groups(targets)) {
      try {
        const { checker, preferred } = this.prepare(key, config, open, styles, resolveImport)
        const warning = checker.warning()
        if (warning) this.report(key, warning)
        else for (const { uri } of group) {
          const id = preferred.get(uri)
          if (id) results.set(uri, checker.diagnostics(id))
        }
      } catch (error) {
        this.checkers.delete(key)
        this.report(key, String(error))
      }
    }
    return results
  }

  private report(key: string, message: string) {
    const warning = `${key}: ${message}`
    if (this.warnings.has(warning)) return
    this.warnings.add(warning)
    this.warn(warning)
  }
}
