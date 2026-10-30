import { lexer, parse, walk, type Declaration, type SyntaxMatchError } from 'css-tree'
import type { Diagnostic, Range, Position } from 'vscode-languageserver'
import type { CssValuePart, CssDeclarations } from '@cross-css/native'
export type { CssValuePart, CssDeclaration, CssDeclarations } from '@cross-css/native'

// XCSS parsing, source ranges, and name/type resolution belong to the native API.
export interface CssValidationOptions { checkCssProperties: boolean; checkCssValues: boolean }
export const defaultCssValidation: CssValidationOptions = { checkCssProperties: true, checkCssValues: true }
export const representatives: Readonly<Record<string, string>> = Object.freeze({
  number: '1', integer: '1', length: '1px', 'length-percentage': '1px', percentage: '1%',
  angle: '1deg', time: '1s', frequency: '1Hz', resolution: '1dppx', flex: '1fr', color: 'red',
  image: 'linear-gradient(red, blue)', url: 'url("data:,")',
  'transform-function': 'matrix(1, 0, 0, 1, 0, 0)', 'transform-list': 'matrix(1, 0, 0, 1, 0, 0)',
})

function advance(start: Position, text: string): Position {
  // Match XCSS SourceFile's line model; offsets/columns count UTF-16 units.
  const lines = text.split('\n')
  return { line: start.line + lines.length - 1, character: lines.length === 1 ? start.character + text.length : lines.at(-1)!.length }
}
function project(parts: CssValuePart[]) {
  let text = ''
  const spans: { start: number; end: number; part: CssValuePart }[] = []
  for (const part of parts) {
    const replacement = part.valueType ? (Object.hasOwn(representatives, part.valueType) ? representatives[part.valueType] : undefined) : part.text
    if (replacement == null) return null
    const start = text.length
    text += replacement
    spans.push({ start, end: text.length, part })
  }
  return { text, spans }
}
function warning(code: string, message: string, range: Range): Diagnostic {
  return { source: 'CSS', severity: 2, code, message, range }
}

export function validateCss(input: CssDeclarations, options: CssValidationOptions = defaultCssValidation, log: (message: string) => void = () => {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (const declaration of input.declarations) {
    try {
      const { property } = declaration
      if (property.startsWith('--')) continue
      if (lexer.checkPropertyName(property)) {
        if (options.checkCssProperties) diagnostics.push(warning('css.unknown-property', `Unknown CSS property “${property}”.`, declaration.propertyRange))
        continue
      }
      if (!options.checkCssValues || !declaration.checkable) continue
      const projection = project(declaration.parts)
      if (!projection) continue
      // Parse a declaration to remove terminal !important structurally, then parse
      // only its value with original projected offsets (including whitespace).
      let parsed: Declaration
      try {
        parsed = parse(`x:${projection.text}`, { context: 'declaration', positions: true }) as Declaration
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        diagnostics.push(warning('css.invalid-value', `Invalid CSS value for “${property}”.`, declaration.valueRange))
        continue
      }
      if (parsed.value.type !== 'Value' || !parsed.value.loc) continue
      const begin = parsed.value.loc.start.offset - 2
      const end = parsed.value.loc.end.offset - 2
      const value = parse(projection.text.slice(begin, end), { context: 'value', positions: true, offset: begin })
      let unresolved = false
      walk(value, node => { if (node.type === 'Function' && node.name.toLowerCase() === 'var') unresolved = true })
      if (unresolved) continue
      const match = lexer.matchProperty(property, value)
      if (!match.error) continue
      if (match.error.name !== 'SyntaxMatchError') {
        log(`CSS validator could not check property ${property}: ${match.error.name}`)
        continue
      }
      const typed = declaration.parts.filter(part => part.valueType)
      const literal = projection.spans.filter(span => !span.part.valueType && span.start < end && span.end > begin)
        .map(span => projection.text.slice(Math.max(begin, span.start), Math.min(end, span.end))).join('')
      // Only examine the parsed value; its terminal !important is already excluded.
      const standalone = typed.length === 1 && !literal.replace(/\/\*[\s\S]*?\*\//g, '').trim()
      if (standalone) {
        diagnostics.push(warning('css.type-mismatch', `A value of type “${typed[0].valueType}” is not valid for CSS property “${property}”.`, typed[0].range))
        continue
      }
      const error = match.error as SyntaxMatchError
      const start = error.loc?.start.offset
      const finish = error.loc?.end.offset
      let range = declaration.valueRange
      if (start !== undefined && finish !== undefined && finish > start) {
        const first = projection.spans.find(span => span.start <= start && span.end > start)
        const last = projection.spans.find(span => span.start < finish && span.end >= finish)
        if (first && last) range = {
          start: first.part.valueType ? first.part.range.start : advance(first.part.range.start, (first.part.text ?? '').slice(0, start - first.start)),
          end: last.part.valueType ? last.part.range.end : advance(last.part.range.start, (last.part.text ?? '').slice(0, finish - last.start)),
        }
      }
      diagnostics.push(warning('css.invalid-value', `Invalid CSS value for “${property}”.`, range))
    } catch {
      // Do not leak synthetic values through library exception messages.
      log(`CSS validator failed for property ${declaration.property}; native XCSS diagnostics remain available.`)
    }
  }
  return diagnostics
}
