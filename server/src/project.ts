import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, relative, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { parse, type ParseError } from 'jsonc-parser'
import { LanguageService, inspect } from '@cross-css/native'
import { validateCss, type CssValidationOptions } from './css-validation.js'

export const excluded = new Set(['.git', '.idea', 'node_modules', 'dist', 'target', 'build', 'coverage'])
export function isExcludedPath(path: string, roots: string[], excludedRoots: string[] = []): boolean {
  const root = roots.find(root => { const rel = relative(root, path); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel) })
  const scoped = root ? relative(root, path) : path
  return scoped.split(/[\\/]/).some(part => excluded.has(part)) || excludedRoots.some(root => {
    const rel = relative(root, path); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel)
  })
}
export function canonicalUri(value: string): string {
  if (!value.startsWith('file:')) return value
  let path = resolve(fileURLToPath(value))
  try { path = realpathSync.native(path) } catch {
    // Resolve the nearest existing ancestor, including Windows short-name aliases.
    const suffix: string[] = []
    let parent = path
    while (dirname(parent) !== parent) {
      suffix.unshift(parent.slice(dirname(parent).length + 1))
      parent = dirname(parent)
      try { path = join(realpathSync.native(parent), ...suffix); break } catch { /* try the next ancestor */ }
    }
  }
  if (process.platform === 'win32') path = path.toLowerCase()
  return pathToFileURL(path).href
}
export type Aliases = Record<string, string[]>
interface Paths { base: string; paths: Aliases }
interface Entry { text: string; revision: number }

export class Project {
  readonly service = new LanguageService()
  readonly files = new Map<string, Entry>()
  readonly open = new Map<string, { text: string; version: number }>()
  private revisions = new Map<string, number>()
  private configurations = new Map<string, Paths>()
  private requestedPaths = new Set<string>()
  private isolated = new Map<string, LanguageService>()
  constructor(readonly roots: string[], public aliases: Aliases = {}, readonly onWarning: (message: string) => void = () => {}, readonly excludedRoots: string[] = []) {
    this.roots = roots.map(root => fileURLToPath(canonicalUri(pathToFileURL(root).href)))
    this.excludedRoots = excludedRoots.map(root => fileURLToPath(canonicalUri(pathToFileURL(root).href)))
    this.aliases = this.validAliases(aliases)
  }
  private revision(uri: string) {
    const revision = (this.revisions.get(uri) ?? 0) + 1
    this.revisions.set(uri, revision)
    return revision
  }
  private inside(uri: string) {
    if (!uri.startsWith('file:')) return false
    const path = fileURLToPath(uri)
    return this.roots.some(root => { const rel = relative(root, path); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel) })
  }
  private set(uri: string, text: string) {
    if (this.files.get(uri)?.text === text) return
    const revision = this.revision(uri)
    this.files.set(uri, { text, revision })
    this.service.setFile(uri, revision, text)
  }
  private disk(uri: string) {
    try { this.set(uri, readFileSync(fileURLToPath(uri), 'utf8')) }
    catch {
      if (this.files.delete(uri)) this.service.removeFile(uri, this.revision(uri))
    }
  }
  private scan(root: string) {
    if (this.excludedRoots.some(excluded => { const rel = relative(excluded, root); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel) })) return
    let entries
    try { entries = readdirSync(root, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(root, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory() && !excluded.has(entry.name)) this.scan(path)
      else if (entry.isFile() && entry.name.endsWith('.xcss')) {
        const uri = canonicalUri(pathToFileURL(path).href)
        if (!this.open.has(uri)) this.disk(uri)
      }
    }
  }
  initialize() { for (const root of this.roots) this.scan(root); this.bind() }
  update(uri: string, text: string, version: number) {
    uri = canonicalUri(uri)
    if ((this.open.get(uri)?.version ?? -1) >= version) return
    this.open.set(uri, { text, version })
    if (this.inside(uri) || this.files.has(uri)) { this.set(uri, text); this.bind() }
    else {
      let service = this.isolated.get(uri)
      if (!service) this.isolated.set(uri, service = new LanguageService())
      service.setFile(uri, this.revision(uri), text)
    }
  }
  close(uri: string) {
    uri = canonicalUri(uri)
    this.open.delete(uri)
    if (this.isolated.delete(uri)) return
    this.disk(uri)
    this.bind()
  }
  change(uri: string) {
    uri = canonicalUri(uri)
    if (!uri.startsWith('file:')) return
    const path = fileURLToPath(uri)
    const excludedPath = isExcludedPath(path, this.roots, this.excludedRoots)
    if (excludedPath && !this.files.has(uri) && !this.requestedPaths.has(path)) return
    if (/^(tsconfig|jsconfig).*\.json$/.test(path.split(/[\\/]/).at(-1) ?? '') || this.configurations.has(path)) {
      this.configurations.clear()
    } else if (path.endsWith('.xcss') && !this.open.has(uri)) this.disk(uri)
    this.bind()
  }
  configure(aliases: Aliases) { this.aliases = this.validAliases(aliases); this.configurations.clear(); this.bind() }
  watchPaths() {
    return [...this.files.keys()].filter(uri => uri.startsWith('file:')).map(uri => fileURLToPath(uri))
      .concat([...this.configurations.keys()], [...this.requestedPaths])
  }
  cssDiagnostics(uri: string, options: CssValidationOptions) {
    if (!options.checkCssProperties && !options.checkCssValues) return []
    uri = canonicalUri(uri)
    const service = this.isolated.get(uri) ?? this.service
    return validateCss(service.cssDeclarations(uri), options, this.onWarning)
  }
  private validAliases(value: unknown): Aliases {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([key, values]) => {
      const valid = key.length > 0 && key.split('*').length <= 2 && Array.isArray(values) && values.length > 0 && values.every(v => typeof v === 'string' && v.length > 0)
      if (!valid) this.onWarning(`Ignoring invalid path alias: ${key}`)
      return valid
    }))
  }
  private config(path: string, seen = new Set<string>()): Paths {
    path = fileURLToPath(canonicalUri(pathToFileURL(path).href))
    const cached = this.configurations.get(path)
    if (cached) return cached
    if (seen.has(path)) { this.onWarning(`Cyclic configuration inheritance: ${path}`); return { base: dirname(path), paths: {} } }
    seen.add(path)
    let data: { extends?: string | string[]; compilerOptions?: { baseUrl?: string; paths?: Aliases } } = {}
    try {
      const errors: ParseError[] = []
      data = parse(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true }) ?? {}
      if (errors.length) this.onWarning(`Invalid JSON configuration: ${path}`)
    } catch { this.onWarning(`Cannot read configuration: ${path}`) }
    let inherited: Paths = { base: dirname(path), paths: {} }
    for (const parent of typeof data.extends === 'string' ? [data.extends] : Array.isArray(data.extends) ? data.extends.filter(v => typeof v === 'string') : []) {
      try {
        let target: string
        if (parent.startsWith('.') || isAbsolute(parent)) target = resolve(dirname(path), parent)
        else {
          const require = createRequire(path)
          try { target = require.resolve(`${parent}/tsconfig.json`) } catch { target = require.resolve(parent) }
        }
        if (!existsSync(target)) target += '.json'
        inherited = this.config(target, new Set(seen))
      } catch { this.onWarning(`Cannot resolve configuration ${parent} from ${path}`) }
    }
    const options = data.compilerOptions ?? {}
    const result = {
      base: typeof options.baseUrl === 'string' ? resolve(dirname(path), options.baseUrl) : options.paths ? dirname(path) : inherited.base,
      paths: options.paths ? this.validAliases(options.paths) : inherited.paths,
    }
    this.configurations.set(path, result)
    return result
  }
  private nearest(path: string): Paths {
    let directory = dirname(path)
    while (true) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const config = join(directory, name)
        if (existsSync(config)) return this.config(config)
      }
      const parent = dirname(directory)
      if (parent === directory) return { base: dirname(path), paths: {} }
      directory = parent
    }
  }
  private target(path: string): string | undefined {
    for (const candidate of [path, `${path}.xcss`, join(path, 'index.xcss')]) {
      if (!candidate.endsWith('.xcss')) continue
      this.requestedPaths.add(fileURLToPath(canonicalUri(pathToFileURL(candidate).href)))
      try { if (statSync(candidate).isFile()) return canonicalUri(pathToFileURL(candidate).href) } catch { /* try next */ }
      const uri = canonicalUri(pathToFileURL(candidate).href)
      if (this.open.has(uri)) return uri
    }
    return undefined
  }
  private resolve(importer: string, specifier: string) {
    const path = fileURLToPath(importer)
    if (specifier.startsWith('.') || isAbsolute(specifier)) return this.target(resolve(dirname(path), specifier))
    const config = this.nearest(path)
    const root = this.roots.find(root => { const rel = relative(root, path); return !rel.startsWith('..') && !isAbsolute(rel) }) ?? dirname(path)
    const rules = [
      ...Object.entries(this.aliases).map(([key, values]) => ({ key, values, base: root, override: true })),
      ...Object.entries(config.paths).map(([key, values]) => ({ key, values, base: config.base, override: false })),
    ].filter(({ key }) => !key.includes('*') ? key === specifier : specifier.startsWith(key.split('*')[0]) && specifier.endsWith(key.split('*')[1]))
      .sort((a, b) => Number(b.override) - Number(a.override) || Number(a.key.includes('*')) - Number(b.key.includes('*')) || b.key.indexOf('*') - a.key.indexOf('*'))
    // A matching explicit override is authoritative, including a missing target.
    const rule = rules[0]
    if (rule) {
      const [prefix, suffix = ''] = rule.key.split('*')
      const capture = rule.key.includes('*') ? specifier.slice(prefix.length, specifier.length - suffix.length) : ''
      for (const value of rule.values) { const target = this.target(resolve(rule.base, value.replace('*', capture))); if (target) return target }
      return undefined
    }
    return this.target(resolve(config.base, specifier))
  }
  private bind() {
    this.requestedPaths.clear()
    // Dependencies loaded during iteration are included in the same binding pass.
    for (const [uri, entry] of this.files) {
      for (const specifier of inspect(entry.text).imports) {
        const target = this.resolve(uri, specifier)
        if (target && !this.files.has(target)) {
          const overlay = this.open.get(target)
          if (overlay) this.set(target, overlay.text); else this.disk(target)
        }
        this.service.setResolution(uri, specifier, target)
      }
    }
  }
  query(method: string, uri: string, position?: { line: number; character: number }, includeDeclaration = false) {
    uri = canonicalUri(uri)
    const service = this.isolated.get(uri) ?? this.service
    switch (method) {
      case 'document': return service.document(uri)
      case 'definition': return service.definition(uri, position!)
      case 'references': return service.references(uri, position!, includeDeclaration)
      case 'hover': return service.hover(uri, position!) ?? null
      default: throw new Error(`Unsupported query ${method}`)
    }
  }
}
