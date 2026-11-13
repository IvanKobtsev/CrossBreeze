import { parse, walk } from 'css-tree'
import ts from 'typescript'
import { dirname, join, resolve } from 'node:path'
import type { CssValues, EditorRange } from '@cross-css/native'
import { advance } from './css-validation.js'

export interface AssetUrl { value: string; range: EditorRange }

/** Parse only native-identified CSS values, never comments, strings or raw XCSS bodies. */
export function assetUrls(values: CssValues): AssetUrl[] {
  const urls: AssetUrl[] = []
  for (const value of values.values) {
    try {
      const ast = parse(value.text, { context: 'value', positions: true })
      walk(ast, node => {
        if (node.type !== 'Url' || !node.loc) return
        const text = value.text.slice(node.loc.start.offset, node.loc.end.offset)
        let start = text.indexOf('(') + 1, end = text.lastIndexOf(')')
        while (/\s/.test(text[start] ?? '') && start < end) start++
        while (end > start && /\s/.test(text[end - 1])) end--
        if (text[start] === '"' || text[start] === "'") { start++; end-- }
        if (end <= start) return
        const range = {
          start: advance(value.range.start, value.text.slice(0, node.loc.start.offset + start)),
          end: advance(value.range.start, value.text.slice(0, node.loc.start.offset + end)),
        }
        const compare = (a: EditorRange['start'], b: EditorRange['start']) => a.line - b.line || a.character - b.character
        if (value.parts.some(part => part.valueType && compare(part.range.start, range.end) < 0 && compare(part.range.end, range.start) > 0)) return
        urls.push({ value: node.value, range })
      })
    } catch { /* Incomplete or dynamic values are not filesystem references. */ }
  }
  return urls
}

export function localAssetPath(value: string): string | undefined {
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return undefined
  const path = value.split(/[?#]/, 1)[0]
  if (!path) return undefined
  try { return decodeURIComponent(path) } catch { return path }
}

const configs = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'].map(ext => `vite.config.${ext}`)
const contains = (root: string, file: string) => file === root || file.startsWith(root + '/') || file.startsWith(root + '\\')

/** Read literal configuration without importing or executing project code. */
export function publicDirectory(file: string, roots: string[], read: (path: string) => string | undefined): string | undefined {
  const boundary = roots.filter(root => contains(root, file)).sort((a, b) => b.length - a.length)[0]
  if (!boundary) return undefined
  let packageRoot: string | undefined
  for (let directory = dirname(file); contains(boundary, directory); directory = dirname(directory)) {
    if (!packageRoot && read(join(directory, 'package.json')) !== undefined) packageRoot = directory
    const found = configs.map(name => ({ path: join(directory, name), text: read(join(directory, name)) })).filter(item => item.text !== undefined)
    if (found.length > 1) return undefined
    if (found.length) {
      const { path, text } = found[0]
      const source = ts.createSourceFile(path, text!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const exported = source.statements.find(ts.isExportAssignment)
      if (!exported) return undefined
      let expression = exported.expression
      if (ts.isCallExpression(expression)) {
        const names = new Set(['defineConfig'])
        for (const statement of source.statements) {
          if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'vite') continue
          const bindings = statement.importClause?.namedBindings
          if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
            if ((binding.propertyName ?? binding.name).text === 'defineConfig') names.add(binding.name.text)
          }
        }
        if (!ts.isIdentifier(expression.expression) || !names.has(expression.expression.text) || expression.arguments.length !== 1) return undefined
        expression = expression.arguments[0]
      }
      while (ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isAsExpression(expression)) expression = expression.expression
      if (!ts.isObjectLiteralExpression(expression) || expression.properties.some(p => ts.isSpreadAssignment(p) || p.name && ts.isComputedPropertyName(p.name))) return undefined
      const literal = (name: string): string | false | undefined | null => {
        const properties = expression.properties.filter(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name)
        if (!properties.length) return undefined
        if (properties.length !== 1 || !ts.isPropertyAssignment(properties[0])) return null
        const value = properties[0].initializer
        return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : value.kind === ts.SyntaxKind.FalseKeyword ? false : null
      }
      const root = literal('root'), publicDir = literal('publicDir')
      if (root === null || root === false || publicDir === null || publicDir === false) return undefined
      return resolve(directory, root ?? '.', publicDir ?? 'public')
    }
    if (directory === boundary || dirname(directory) === directory) break
  }
  return join(packageRoot ?? boundary, 'public')
}
