import { lexer, parse, walk } from 'css-tree'
import type { CssValues, SemanticToken } from '@cross-css/native'
import type { Color, ColorInformation, ColorPresentation, Range } from 'vscode-languageserver'
import { advance, project } from './css-validation.js'
import { namedColors } from './color-names.js'

const clamp = (n: number) => Math.max(0, Math.min(1, n))
const rgba = (red: number, green: number, blue: number, alpha = 1): Color => ({ red: clamp(red), green: clamp(green), blue: clamp(blue), alpha: clamp(alpha) })
export function parseColor(text: string): Color | null {
  text = text.replace(/\/\*[\s\S]*?\*\//g, ' ').trim().toLowerCase()
  if (text === 'transparent') return rgba(0, 0, 0, 0)
  if (Object.hasOwn(namedColors, text) && !lexer.matchType('color', text).error) text = '#' + namedColors[text]
  if (/^#[\da-f]{3,4}$/.test(text)) text = '#' + [...text.slice(1)].map(c => c + c).join('')
  if (/^#[\da-f]{6}([\da-f]{2})?$/.test(text)) {
    const bytes = text.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
    return rgba(bytes[0], bytes[1], bytes[2], bytes[3] ?? 1)
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/s.exec(text)
  if (!fn || lexer.matchType('color', text).error) return null
  const args = fn[2].trim().split(/\s*[,/]\s*|\s+/).filter(Boolean)
  if (args.length < 3 || args.length > 4) return null
  const numeric = /^[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?(%|deg|grad|rad|turn)?$/
  if (args.some(v => !numeric.test(v))) return null
  const alpha = args[3] ? parseFloat(args[3]) / (args[3].endsWith('%') ? 100 : 1) : 1
  if (fn[1].startsWith('rgb')) {
    const rgb = args.slice(0, 3).map(v => parseFloat(v) / (v.endsWith('%') ? 100 : 255))
    return rgba(rgb[0], rgb[1], rgb[2], alpha)
  }
  const hue = args[0], unit = hue.match(/[a-z]+$/)?.[0]
  const degrees = parseFloat(hue) * (unit === 'turn' ? 360 : unit === 'rad' ? 180 / Math.PI : unit === 'grad' ? .9 : 1)
  const h = ((degrees % 360) + 360) % 360 / 60, s = clamp(parseFloat(args[1]) / 100), l = clamp(parseFloat(args[2]) / 100)
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2
  const rgb = h < 1 ? [c,x,0] : h < 2 ? [x,c,0] : h < 3 ? [0,c,x] : h < 4 ? [0,x,c] : h < 5 ? [x,0,c] : [c,0,x]
  return rgba(rgb[0] + m, rgb[1] + m, rgb[2] + m, alpha)
}

export function colorPresentation(original: string, color: Color, range: Range): ColorPresentation[] {
  if (Object.values(color).some(v => !Number.isFinite(v) || v < 0 || v > 1)) return []
  const {red:r, green:g, blue:b, alpha:a} = color
  const n = (v: number) => String(Number(v.toFixed(4)))
  let label: string
  if (/^\s*hsla?\(/i.test(original)) {
    const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min, l = (max + min) / 2
    let h = d === 0 ? 0 : max === r ? ((g-b)/d + (g < b ? 6 : 0)) * 60 : max === g ? ((b-r)/d+2)*60 : ((r-g)/d+4)*60
    const s = d === 0 ? 0 : d / (1 - Math.abs(2*l - 1))
    label = `hsl(${n(h)} ${n(s*100)}% ${n(l*100)}%${a < 1 ? ` / ${n(a)}` : ''})`
  } else if (/^\s*rgba?\(/i.test(original)) {
    label = `rgb(${n(r*255)} ${n(g*255)} ${n(b*255)}${a < 1 ? ` / ${n(a)}` : ''})`
  } else {
    label = '#' + [r,g,b,...(a < 1 ? [a] : [])].map(v => Math.round(v*255).toString(16).padStart(2,'0')).join('')
  }
  return [{ label, textEdit: { range, newText: label } }]
}

// A replacement may never point into a synthetic typed representative.
function originalRange(projection: NonNullable<ReturnType<typeof project>>, start: number, end: number): Range | null {
  const spans = projection.spans.filter(s => s.start < end && s.end > start)
  if (!spans.length || spans.some(s => s.part.valueType)) return null
  const first = spans[0], last = spans.at(-1)!
  return { start: advance(first.part.range.start, first.part.text!.slice(0, start-first.start)), end: advance(last.part.range.start, last.part.text!.slice(0, end-last.start)) }
}
export function inspectValues(input: CssValues, legend: readonly string[]) {
  const colors: ColorInformation[] = [], tokens: SemanticToken[] = []
  function token(range: Range, kind: string) {
    if (range.start.line === range.end.line && range.end.character > range.start.character) tokens.push({ line: range.start.line, character: range.start.character, length: range.end.character-range.start.character, tokenType: legend.indexOf(kind), declaration: false })
  }
  for (const value of input.values) {
    for (const fn of value.functions) token(fn.range, 'cssFunction')
    if (!value.checkable) continue
    const projection = project(value.parts)
    if (!projection) continue
    try {
      const ast = parse(projection.text, { context: 'value', positions: true })
      const match = value.property ? lexer.matchProperty(value.property, ast) : lexer.matchType('color', ast)
      const covered: {start:number;end:number}[] = []
      walk(ast, node => {
        if (!node.loc || covered.some(r => r.start <= node.loc!.start.offset && r.end >= node.loc!.end.offset)) return
        if (!['Identifier','Hash','Function'].includes(node.type)) return
        const start = node.loc.start.offset, end = node.loc.end.offset
        const range = originalRange(projection, start, end)
        if (!range) return
        const colorContext = match.isType(node, 'color')
        const text = projection.text.slice(start, end)
        const color = colorContext ? parseColor(text) : null
        if (color) {
          colors.push({ color, range }); covered.push({start,end})
          // Keep numeric arguments and comments in their existing lexical styles.
          token(node.type === 'Function' ? { start: range.start, end: advance(range.start, text.slice(0, text.indexOf('('))) } : range, 'cssColor')
        } else if (node.type === 'Identifier' && match.isKeyword(node) && !colorContext) {
          token(range, 'cssKeyword')
        }
      })
    } catch { /* Incomplete values retain native function highlighting. */ }
  }
  // Color functions use color styling rather than overlapping function tokens.
  const sorted = tokens.sort((a,b) => a.line-b.line || a.character-b.character || b.length-a.length || b.tokenType-a.tokenType)
  const accepted: SemanticToken[] = []
  for (const t of sorted) if (t.tokenType >= 0 && !accepted.some(a => a.line === t.line && a.character < t.character+t.length && t.character < a.character+a.length)) accepted.push(t)
  return { colors, tokens: accepted }
}
