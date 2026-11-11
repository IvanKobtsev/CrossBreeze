import ts from 'typescript'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { existsSync, readFileSync, readSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

const xcss = '@cross-css/vite'
const legacyXcss = '@cross-css/vite-plugin'
const client = xcss + '/client'
const runtime = xcss + '/react'
const viteConfigs = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'].map(ext => 'vite.config.' + ext)
const reactPlugins = new Set(['@vitejs/plugin-react', '@vitejs/plugin-react-swc', '@vitejs/plugin-react-oxc'])
const ignored = new Set(['node_modules', '.git', '.idea', 'dist', 'build', 'coverage'])

interface Input {
  root: string
  files: Record<string, string>
  sources?: string[]
}

interface Edit { path: string; before: string | null; after: string }
interface Step { message: string; path: string }
interface Plan { edits: Edit[]; steps: Step[] }

function json(text: string | undefined) {
  if (text === undefined) return undefined
  const errors: ParseError[] = []
  const result = parse(text, errors, { allowTrailingComma: true })
  return errors.length || !result || typeof result !== 'object' || Array.isArray(result) ? undefined : result
}

function style(text: string) {
  const indentation = text.match(/^[ \t]+(?=\S)/m)?.[0] ?? '  '
  return { tabSize: indentation.length, insertSpaces: !indentation.startsWith('\t'), eol: text.includes('\r\n') ? '\r\n' : '\n' }
}

function setJson(text: string, path: (string | number)[], value: unknown) {
  return applyEdits(text, modify(text, path, value, { formattingOptions: style(text) }))
}

function within(root: string, path: string) {
  const local = relative(root, path)
  return !isAbsolute(local) && local !== '..' && !local.startsWith('../') && !local.startsWith('..\\')
}

type DirectoryReader = NonNullable<ts.ParseConfigHost['readDirectory']>
type Entries = { files: string[]; directories: string[] }

function withVirtualFile(readDirectory: DirectoryReader, candidate: string): DirectoryReader {
  // Use the same include and exclude matcher as the compiler for a file that has not been created yet.
  const { matchFiles } = ts as typeof ts & {
    matchFiles(path: string, extensions: readonly string[], exclude: readonly string[] | undefined,
      include: readonly string[] | undefined, caseSensitive: boolean, cwd: string, depth: number | undefined,
      entries: (directory: string) => Entries, realpath: (path: string) => string): string[]
  }
  return (path, extensions, exclude, include, depth) => {
    const existing = readDirectory(path, extensions, exclude, include, depth)
    const prospective = matchFiles(path, extensions, exclude, include, ts.sys.useCaseSensitiveFileNames,
      ts.sys.getCurrentDirectory(), depth, directory => {
        if (!within(directory, candidate)) return { files: [], directories: [] }
        const parts = relative(directory, candidate).split(/[\\/]/)
        return parts.length === 1 ? { files: parts, directories: [] } : { files: [], directories: [parts[0]] }
      }, path => path)
    return [...existing, ...prospective]
  }
}

function parents(root: string) {
  const result: string[] = []
  for (let dir = root; ; dir = dirname(dir)) {
    result.push(dir)
    if (dirname(dir) === dir) return result
  }
}

function dependency(root: string, name: string) {
  for (const dir of parents(root)) {
    const path = join(dir, 'node_modules', name, 'package.json')
    try { return { root: dirname(path), data: json(readFileSync(path, 'utf8')) } } catch { /* try the parent */ }
  }
}

function installCommand(root: string, manager: unknown) {
  const locks = [
    ['pnpm', 'pnpm-lock.yaml'], ['yarn', 'yarn.lock'], ['npm', 'package-lock.json'],
    ['bun', 'bun.lock'], ['bun', 'bun.lockb'],
  ]
  const declared = typeof manager === 'string' ? manager.split('@')[0] : undefined
  const nearest = parents(root).map(dir => [...new Set(locks.filter(([, lock]) => existsSync(join(dir, lock))).map(([name]) => name))])
    .find(names => names.length)
  const chosen = declared ?? (nearest?.length === 1 ? nearest[0] : 'npm')
  return chosen === 'pnpm' || chosen === 'yarn' || chosen === 'bun'
    ? chosen + ' add -D ' + xcss : 'npm install -D ' + xcss
}

function property(object: ts.ObjectLiteralExpression, key: string) {
  const candidates = object.properties.filter(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key)
  if (candidates.length > 1 || object.properties.some(p => ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name)))) {
    throw new Error('Use explicit, unique properties in the Vite config before applying setup.')
  }
  const found = candidates[0]
  if (found && !ts.isPropertyAssignment(found)) throw new Error('Set ' + key + ' explicitly in the Vite config.')
  return found
}

function insert(text: string, offset: number, value: string) {
  return text.slice(0, offset) + value + text.slice(offset)
}

function addProperty(text: string, object: ts.ObjectLiteralExpression, value: string) {
  return insert(text, object.getStart() + 1, ' ' + value + (object.properties.length ? ', ' : ' '))
}

function viteEdit(path: string, source: string, config: string | undefined, react: boolean, oxc: boolean, notes: string[]) {
  let text = source
  function parseVite() {
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) {
      throw new Error('Fix the Vite config syntax before registering ' + xcss + '.')
    }
    const imports = new Map<string, string>()
    const defaultImports = new Map<string, ts.ImportDeclaration>()
    const defineConfig = new Set<string>()
    const lazyPlugins = new Set<string>()
    const occupied = new Set<string>()
    function collectNames(node: ts.Node) {
      if (ts.isIdentifier(node)) occupied.add(node.text)
      ts.forEachChild(node, collectNames)
    }
    collectNames(file)
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const specifier = statement.moduleSpecifier.text
      const clause = statement.importClause
      if (!clause || clause.isTypeOnly) continue
      if (clause.name) {
        imports.set(clause.name.text, specifier)
        defaultImports.set(clause.name.text, statement)
      }
      if ((specifier === 'vite' || specifier === 'vite-plus') && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const item of clause.namedBindings.elements) {
          if (item.isTypeOnly) continue
          const name = (item.propertyName ?? item.name).text
          if (name === 'defineConfig') defineConfig.add(item.name.text)
          if (specifier === 'vite-plus' && name === 'lazyPlugins') lazyPlugins.add(item.name.text)
        }
      }
    }
    const assignment = file.statements.find(ts.isExportAssignment)
    let expression = assignment?.expression
    while (expression && (ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isAsExpression(expression))) {
      expression = expression.expression
    }
    if (expression && ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && defineConfig.has(expression.expression.text)) {
      expression = expression.arguments.length === 1 ? expression.arguments[0] : undefined
    }
    if (!expression || !ts.isObjectLiteralExpression(expression)) {
      throw new Error('CrossBreeze could not verify the dynamic or unsupported Vite export. Check its XCSS plugin registration manually.')
    }
    let plugins = property(expression, 'plugins')?.initializer
    if (plugins && ts.isCallExpression(plugins) && ts.isIdentifier(plugins.expression) && lazyPlugins.has(plugins.expression.text)) {
      const factory = plugins.arguments.length === 1 ? plugins.arguments[0] : undefined
      if (factory && ts.isArrowFunction(factory) && !factory.parameters.length &&
          !factory.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) &&
          ts.isArrayLiteralExpression(factory.body)) {
        plugins = factory.body
      }
    }
    if (plugins && !ts.isArrayLiteralExpression(plugins)) {
      throw new Error('CrossBreeze could not verify the computed Vite plugin list. Check its XCSS registration manually.')
    }
    if (plugins?.elements.some(item => !ts.isCallExpression(item) || !ts.isIdentifier(item.expression) || !imports.has(item.expression.text))) {
      throw new Error('Register ' + xcss + ' before JSX transforms in the Vite plugins array. The existing list contains entries that setup cannot resolve.')
    }
    const calls = plugins?.elements.filter(ts.isCallExpression) ?? []
    const from = (call: ts.CallExpression) => imports.get((call.expression as ts.Identifier).text)!
    const list = plugins?.getChildren(file).find(node => node.kind === ts.SyntaxKind.SyntaxList)
    const separatorAfter = (call: ts.CallExpression) => list?.getChildren(file).find(node => node.getStart(file) >= call.end)
    return { file, object: expression, plugins, calls, from, imports, defaultImports, occupied, separatorAfter }
  }

  let state = parseVite()
  const legacy = state.calls.filter(call => state.from(call) === legacyXcss)
  if (legacy.length) {
    const call = legacy[0]
    const declaration = state.defaultImports.get((call.expression as ts.Identifier).text)!
    if (legacy.length !== 1 || state.calls.some(call => state.from(call) === xcss) ||
        call.arguments.length || declaration.importClause?.namedBindings) {
      throw new Error('Migrate the existing @cross-css/vite-plugin registration to @cross-css/vite manually before applying setup.')
    }
    const specifier = declaration.moduleSpecifier
    text = text.slice(0, specifier.getStart() + 1) + xcss + text.slice(specifier.end - 1)
    notes.push('Switch the existing XCSS plugin import to ' + xcss + ' to enable the JSX runtime.')
    state = parseVite()
  }
  const existing = state.calls.filter(call => state.from(call) === xcss)
  if (existing.length > 1) throw new Error('Keep a single ' + xcss + ' registration before applying setup.')
  if (existing.length) {
    const call = existing[0]
    if (config) {
      const options = call.arguments[0]
      if (call.arguments.length > 1 || (options && !ts.isObjectLiteralExpression(options))) {
        throw new Error('Point the existing xcss() call at ' + config + ' manually.')
      }
      const option = options && property(options, 'tsconfig')
      if (option && (!ts.isStringLiteral(option.initializer) || resolve(dirname(path), option.initializer.text) !== resolve(dirname(path), config))) {
        throw new Error('Check the existing xcss() tsconfig option. The detected application config is ' + config + '.')
      }
      if (!option) {
        notes.push('Point xcss() at ' + config + '.')
        text = options ? addProperty(text, options, 'tsconfig: ' + JSON.stringify(config))
          : insert(text, call.end - 1, '{ tsconfig: ' + JSON.stringify(config) + ' }')
      }
    }
    state = parseVite()
    const installed = state.calls.find(call => state.from(call) === xcss)!
    const jsx = state.calls.find(call => reactPlugins.has(state.from(call)))
    if (jsx && installed.getStart() > jsx.getStart()) {
      // Move the call itself and keep comments and the relative order of other plugins.
      const moved = installed.getText()
      const comma = state.separatorAfter(installed)
      if (comma?.kind === ts.SyntaxKind.CommaToken) {
        text = text.slice(0, comma.getStart()) + text.slice(comma.end)
        text = text.slice(0, installed.getStart()) + text.slice(installed.end)
      } else {
        const previous = state.calls[state.calls.indexOf(installed) - 1]
        const separator = state.separatorAfter(previous)
        if (separator?.kind !== ts.SyntaxKind.CommaToken) throw new Error('Move xcss() before the JSX transform manually.')
        text = text.slice(0, installed.getStart()) + text.slice(installed.end)
        text = text.slice(0, separator.getStart()) + text.slice(separator.end)
      }
      text = insert(text, jsx.getStart(), moved + ', ')
    }
  } else {
    let binding = [...state.imports].find(([, source]) => source === xcss)?.[0]
    const needsImport = !binding
    if (!binding) {
      binding = 'xcss'
      for (let suffix = 2; state.occupied.has(binding); suffix++) binding = 'xcss' + suffix
    }
    const call = binding + (config ? '({ tsconfig: ' + JSON.stringify(config) + ' })' : '()')
    if (config) notes.push('Point xcss() at ' + config + '.')
    text = state.plugins
      ? insert(text, state.plugins.getStart() + 1, call + (state.calls.length ? ', ' : ''))
      : addProperty(text, state.object, 'plugins: [' + call + ']')
    if (needsImport) {
      const first = state.file.statements[0]?.getStart() ?? 0
      text = insert(text, first, 'import ' + binding + ' from ' + JSON.stringify(xcss) + ';' + style(text).eol)
    }
  }

  if (!react) return text
  state = parseVite()
  const transforms = state.calls.filter(call => reactPlugins.has(state.from(call)))
  if (transforms.length > 1 || transforms.some(call => state.from(call) !== '@vitejs/plugin-react')) {
    throw new Error('Set the JSX import source to ' + runtime + ' in the active React transform manually.')
  }
  const transform = transforms[0]
  if (transform) {
    const options = transform.arguments[0]
    if (transform.arguments.length > 1 || (options && !ts.isObjectLiteralExpression(options))) {
      throw new Error('Set jsxImportSource to ' + runtime + ' in the existing React plugin options.')
    }
    if (!options) {
      notes.push('Set the React plugin’s jsxImportSource to ' + runtime + '.')
      return insert(text, transform.end - 1, '{ jsxImportSource: ' + JSON.stringify(runtime) + ' }')
    }
    const source = property(options, 'jsxImportSource')
    const mode = property(options, 'jsxRuntime')
    if ((source && (!ts.isStringLiteral(source.initializer) || !['react', runtime].includes(source.initializer.text))) ||
        (mode && (!ts.isStringLiteral(mode.initializer) || mode.initializer.text !== 'automatic'))) {
      throw new Error('Resolve the existing React JSX runtime options before switching to ' + runtime + '.')
    }
    if (source && ts.isStringLiteral(source.initializer) && source.initializer.text === runtime) return text
    notes.push('Set the React plugin’s jsxImportSource to ' + runtime + '.')
    if (!source) return addProperty(text, options, 'jsxImportSource: ' + JSON.stringify(runtime))
    return text.slice(0, source.initializer.getStart()) + JSON.stringify(runtime) + text.slice(source.initializer.end)
  }
  if (!oxc || property(state.object, 'esbuild')) throw new Error('Configure a supported Vite React JSX transform with import source ' + runtime + ' manually.')
  const options = property(state.object, 'oxc')?.initializer
  const jsx = "{ runtime: 'automatic', importSource: " + JSON.stringify(runtime) + ' }'
  if (!options) return addProperty(text, state.object, 'oxc: { jsx: ' + jsx + ' }')
  if (!ts.isObjectLiteralExpression(options)) throw new Error('Set oxc.jsx to use ' + runtime + ' in the Vite config manually.')
  const current = property(options, 'jsx')?.initializer
  if (!current) return addProperty(text, options, 'jsx: ' + jsx)
  if (ts.isObjectLiteralExpression(current)) {
    const mode = property(current, 'runtime')?.initializer
    const source = property(current, 'importSource')?.initializer
    if ((!mode || ts.isStringLiteral(mode) && mode.text === 'automatic') &&
        (!source || ts.isStringLiteral(source) && ['react', runtime].includes(source.text))) {
      if (!mode) text = addProperty(text, current, "runtime: 'automatic'")
      const updated = parseVite()
      const updatedOxc = property(updated.object, 'oxc')!.initializer as ts.ObjectLiteralExpression
      const updatedJsx = property(updatedOxc, 'jsx')!.initializer as ts.ObjectLiteralExpression
      const updatedSource = property(updatedJsx, 'importSource')?.initializer
      if (!updatedSource) return addProperty(text, updatedJsx, 'importSource: ' + JSON.stringify(runtime))
      if (ts.isStringLiteral(updatedSource) && updatedSource.text === runtime) return text
      return text.slice(0, updatedSource.getStart()) + JSON.stringify(runtime) + text.slice(updatedSource.end)
    }
  }
  throw new Error('Resolve the existing oxc.jsx options before switching to ' + runtime + '.')
}

export function planSetup(input: Input): Plan | null {
  const { root } = input
  const manifestPath = join(root, 'package.json')
  const files = new Map(Object.entries(input.files).map(([path, content]) => [resolve(path), content]))
  const read = (path: string) => files.get(resolve(path)) ?? ts.sys.readFile(path)
  const manifest = json(read(manifestPath))
  if (!manifest) return null
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
  const configs = viteConfigs.map(name => join(root, name)).filter(path => read(path) !== undefined)
  const scripts = Object.values(manifest.scripts ?? {})
  if (!configs.length && !dependencies.vite && !scripts.some(script => typeof script === 'string' && /^vite(?:\s|$)/.test(script.trim()))) return null
  const result: Plan = { edits: [], steps: [] }
  const step = (message: string, path: string) => result.steps.push({ message, path })
  const edit = (path: string, after: string, message: string) => {
    const before = read(path) ?? null
    if (before !== after) {
      result.edits.push({ path, before, after })
      step(message, path)
    }
  }
  const installed = dependency(root, xcss)
  if (!installed?.data || !dependencies[xcss]) {
    step('Install the XCSS Vite plugin in this package: ' + installCommand(root, manifest.packageManager), manifestPath)
    return result
  }
  const customConfig = scripts.some(script =>
    typeof script === 'string' && /\bvite\b[^\n;&]*(?:--config(?:\s|=)|-c\s)/.test(script))
  if (configs.length > 1 || customConfig) {
    step('Register ' + xcss + ' before JSX transforms in the Vite config selected by this package.', configs[0] ?? manifestPath)
    return result
  }
  const tsRoot = join(root, 'tsconfig.json')
  const appConfig = join(root, 'tsconfig.app.json')
  const configEntry = [tsRoot, appConfig].find(path => read(path) !== undefined)
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    readFile: read,
    fileExists: path => files.has(resolve(path)) || ts.sys.fileExists(path),
    readDirectory: (path, extensions, exclude, include, depth) =>
      ts.sys.readDirectory(path, extensions, [...(exclude ?? []), ...ignored].map(value => ignored.has(value) ? '**/' + value : value), include, depth),
    onUnRecoverableConfigFileDiagnostic: () => {},
  }
  const sources = input.sources && new Set(input.sources.map(path => resolve(path)))
  const parsed = new Map<string, ts.ParsedCommandLine>()
  const visited = new Set<string>()
  function scan(path: string) {
    if (visited.has(path) || !within(root, path)) return
    visited.add(path)
    const config = ts.getParsedCommandLineOfConfigFile(path, {}, host)
    if (!config || config.errors.length) return
    if (config.fileNames.some(file =>
      within(root, file) && (!sources || sources.has(resolve(file))) &&
      !file.endsWith('.d.ts') && !/^vite\.config\.|(?:^|\.)(?:test|spec)\./.test(basename(file)) &&
      /\.(?:tsx?|mts|cts)$/.test(file)
    )) parsed.set(path, config)
    for (const reference of config.projectReferences ?? []) scan(ts.resolveProjectReferencePath(reference))
  }
  if (configEntry) scan(configEntry)
  const [selected] = parsed
  const configPath = parsed.size === 1 ? selected[0] : undefined
  const config = parsed.size === 1 ? selected[1] : undefined
  if (configEntry && !config) {
    step('Select the application tsconfig and point xcss({ tsconfig: … }) at it. Setup could not identify one TypeScript application.', configEntry)
    return result
  }
  const react = Boolean(dependencies.react && config)
  const vitePath = configs[0] ?? join(root, config ? 'vite.config.ts' : 'vite.config.js')
  let viteSource = read(vitePath)
  if (viteSource === undefined) {
    const reactImport = react && dependencies['@vitejs/plugin-react'] ? 'import react from "@vitejs/plugin-react";\n' : ''
    viteSource = 'import { defineConfig } from "vite";\n' + reactImport +
      'export default defineConfig({ plugins: [' + (reactImport ? 'react()' : '') + '] });\n'
  }
  let proposedVite: string | undefined
  let proposedConfig = configPath && read(configPath)
  const canSetRuntime = !react || (
    (!config?.options.jsxImportSource || ['react', runtime].includes(config.options.jsxImportSource)) &&
    config?.options.jsx !== ts.JsxEmit.React && config?.options.jsx !== ts.JsxEmit.ReactNative
  )
  const explicitConfig = configPath && configPath !== tsRoot ? './' + relative(root, configPath).replaceAll('\\', '/') : undefined
  if (canSetRuntime) {
    try {
      const notes: string[] = []
      proposedVite = viteEdit(vitePath, viteSource, explicitConfig, react, Number(dependency(root, 'vite')?.data?.version?.split('.')[0]) >= 8, notes)
      for (const note of notes) step(note, vitePath)
    } catch (error) {
      step(error instanceof Error ? error.message : String(error), vitePath)
      if (explicitConfig) step('Check that xcss() targets the application config with tsconfig: ' + JSON.stringify(explicitConfig) + '.', vitePath)
      if (react) {
        step('Check that the React transform uses jsxImportSource: ' + JSON.stringify(runtime) + ' (or the equivalent Oxc option).', vitePath)
        if (config?.options.jsx !== ts.JsxEmit.ReactJSX || config.options.jsxImportSource !== runtime) {
          step('Set compilerOptions.jsx to "react-jsx" and jsxImportSource to ' + JSON.stringify(runtime) + ' together with the Vite change.', configPath!)
        }
      }
    }
  } else {
    step('Resolve the configured JSX runtime and import source before switching to ' + runtime + '.', configPath!)
  }
  if (react && proposedVite && proposedConfig !== undefined && config) {
    if (config.options.jsx !== ts.JsxEmit.ReactJSX) proposedConfig = setJson(proposedConfig, ['compilerOptions', 'jsx'], 'react-jsx')
    if (config.options.jsxImportSource !== runtime) proposedConfig = setJson(proposedConfig, ['compilerOptions', 'jsxImportSource'], runtime)
  }
  if (proposedVite !== undefined) edit(vitePath, proposedVite, 'Configure the XCSS Vite plugin' + (react ? ' and React JSX runtime' : ''))
  if (!configEntry && (result.edits.length || result.steps.length)) {
    step('Stylesheet imports can work without TypeScript. xClass and xVars need a suitable tsconfig and the XCSS JSX runtime.', manifestPath)
  }
  if (config && configPath && proposedConfig !== undefined) {
    const declarations = config.fileNames.filter(path => path.endsWith('.d.ts'))
    const declared = config.options.types?.includes(client) || declarations.some(path => {
      const source = read(path) ?? ''
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest)
      return file.typeReferenceDirectives.some(ref => ref.fileName === client) || file.statements.some(statement =>
        !ts.isExternalModule(file) && ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name) && statement.name.text === '*.xcss' ||
        ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === client)
    })
    if (!declared) {
      const env = declarations.find(path => within(root, path) && /(?:^|-)env\.d\.ts$/.test(basename(path)))
      if (env) {
        const before = read(env)!
        const directive = '/// <reference types="' + client + '" />' + style(before).eol
        const start = before.startsWith('\uFEFF') ? 1 : 0
        edit(env, insert(before, start, directive), 'Add the XCSS client reference')
      } else if (config.options.types) {
        proposedConfig = setJson(proposedConfig, ['compilerOptions', 'types'], [...config.options.types, client])
      } else {
        const folder = dirname(config.fileNames.find(file => within(root, file) && /\.(?:tsx?|mts|cts)$/.test(file) && !file.endsWith('.d.ts')) ?? configPath)
        const envPath = ['xcss-env.d.ts', 'crossbreeze-xcss-env.d.ts'].map(name => join(folder, name)).find(path => read(path) === undefined)
        if (envPath) {
          const configData = json(proposedConfig)
          const virtual = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
            ...host,
            readDirectory: withVirtualFile(host.readDirectory, envPath),
          })
          const included = virtual?.fileNames.some(path => resolve(path) === envPath)
          const entries = Array.isArray(configData?.files) ? configData.files : undefined
          if (included || entries) {
            if (!included && entries) proposedConfig = setJson(proposedConfig, ['files'], [...entries, './' + relative(dirname(configPath), envPath).replaceAll('\\', '/')])
            edit(envPath, '/// <reference types="' + client + '" />\n', 'Create an included XCSS environment declaration')
          } else {
            step('Add the XCSS client reference to an included declaration file. The app does not include the proposed file.', configPath)
          }
        } else {
          step('Add the XCSS client reference to an included declaration file. Both proposed filenames are occupied.', configPath)
        }
      }
    }
    edit(configPath, proposedConfig, 'Update the application TypeScript configuration')
  }
  return result
}

if (require.main === module) {
  const chunks: Buffer[] = []
  for (;;) {
    const chunk = Buffer.alloc(65536)
    const count = readSync(0, chunk)
    if (!count) break
    chunks.push(chunk.subarray(0, count))
  }
  const inputs: Input[] = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const results = inputs.map(input => ({ root: input.root, plan: planSetup(input) }))
  process.stdout.write(JSON.stringify(results))
}

