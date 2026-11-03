import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { LanguageService, languageServiceCapabilities } from '@cross-css/native'
const require = createRequire(import.meta.url)
const { inspectValues, parseColor, colorPresentation } = require('../out/css-values.cjs')
const { validateCss } = require('../out/css-validation.cjs')
function analyze(source) {
  const service = new LanguageService()
  service.setFile('file:///test.xcss', 1, source)
  return { service, ...inspectValues(service.cssValues('file:///test.xcss'), languageServiceCapabilities().tokenTypes) }
}
test('reported gradient and malformed dimension typos produce precise diagnostics', () => {
  const {service} = analyze('$x = 20px; .a { mask-image: linear-gradient(90deg,black (100% - 350px),transprent 100%); width: 10ss0%; background: linear-gradient(red ($x + 2px),blue); }')
  const diagnostics = validateCss(service.cssDeclarations('file:///test.xcss'))
  assert.equal(diagnostics.length, 2)
  assert(diagnostics.every(d => d.code === 'css.invalid-value'))
  assert.equal(diagnostics[0].range.end.character - diagnostics[0].range.start.character, 'transprent'.length)
})
test('CSS functions, contextual keywords, colors and symbol priority', () => {
  const source = '/* 😀 */ $tone = red; @vars { --accent: color = #fff; } @injection paint($c: color = hsl(120 100% 50%)) {} .a { position: relative; cursor: pointer; outline: none; background: linear-gradient(red, rgb(0 0 255 / 50%)); transform: translateY(-25.5px); filter: blur(2px); animation-name: pointer; font-family: red; content: "blue"; color: --accent; }'
  const {tokens,colors} = analyze(source), legend = languageServiceCapabilities().tokenTypes
  const texts = kind => tokens.filter(t => legend[t.tokenType] === kind).map(t => source.slice(t.character,t.character+t.length))
  assert.deepEqual(texts('cssKeyword'), ['relative','pointer','none'])
  assert(texts('cssFunction').includes('linear-gradient'))
  assert(texts('cssFunction').includes('translateY'))
  assert(texts('cssFunction').includes('blur'))
  assert.equal(colors.length, 5)
  assert(!colors.some(c => c.range.start.character === source.lastIndexOf('--accent')))
})
test('color parsing, aliases, alpha, clamping and unsupported expressions', () => {
  for (const s of ['red','rebeccapurple','grey','slategrey','#abc','#abcd','#112233','#11223344','rgb(100%, 0%, 0%)','rgba(255,0,0,.5)','rgb(255 0 0 / 50%)','hsl(0.5turn 100% 50%)','hsla(120,100%,50%,0.5)','transparent']) assert(parseColor(s),s)
  for (const s of ['transprent','#12','rgb(none 0 0)','rgb(var(--r) 0 0)','currentColor','oklch(.5 .2 120)','red junk','rgb(1 2)']) assert.equal(parseColor(s),null,s)
  assert.deepEqual(parseColor('hsl(120 100% 50%)'),{red:0,green:1,blue:0,alpha:1})
  assert.deepEqual(parseColor('rgb(300 -2 0 / 120%)'),{red:1,green:0,blue:0,alpha:1})
})
test('presentations preserve families, alpha and exact replacement range', () => {
  const range={start:{line:2,character:4},end:{line:2,character:7}}, color={red:0,green:1,blue:0,alpha:.5}
  for (const [old,prefix] of [['red','#'],['#fff','#'],['rgb(0 0 0)','rgb('],['hsl(0 0% 0%)','hsl(']]) {
    const p=colorPresentation(old,color,range)[0]
    assert(p.label.startsWith(prefix));assert.deepEqual(p.textEdit.range,range)
    const parsed=parseColor(p.label)
    assert(Math.abs(parsed.alpha-.5)<.003)
    assert.equal(parsed.green,1)
  }
})
test('strings, URLs, raw blocks and custom names do not expose colors', () => {
  const {colors,tokens}=analyze('@raw { .a { color: red; } } .a { font-family: red; animation-name: blue; content: "#fff"; background: url(red); color: currentColor; }')
  assert.deepEqual(colors,[])
  assert(!tokens.some(t => languageServiceCapabilities().tokenTypes[t.tokenType] === 'cssColor'))
})

test('full TitleButton regression has exactly the two reported CSS errors', async () => {
  const {readFileSync} = await import('node:fs')
  const source=readFileSync(new URL('./fixtures/title-button.xcss',import.meta.url),'utf8')
  const {service}=analyze(source)
  const errors=validateCss(service.cssDeclarations('file:///test.xcss'))
  assert.equal(errors.length,2)
  const corrected=source.replace('transprent','transparent').replace('10ss0%','100%')
  const next=analyze(corrected)
  assert.deepEqual(validateCss(next.service.cssDeclarations('file:///test.xcss')),[])
  assert(next.colors.length>5)
})
test('multiline color functions do not recolor numeric arguments or comments', () => {
  const {tokens,colors}=analyze('.a { color: rgb(\n 255 /* comment */ 0 0\n); }')
  assert.equal(colors.length,1)
  assert.equal(colors[0].range.end.line,2)
  const color=tokens.find(t=>languageServiceCapabilities().tokenTypes[t.tokenType]==='cssColor')
  assert.equal(color.length,3)
})
