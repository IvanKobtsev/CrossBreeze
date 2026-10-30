import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LanguageService } from '@cross-css/native'
import validator from '../out/css-validation.cjs'

test('native projection and CSSTree agree on typed, mixed, nested and ordinary CSS values', () => {
  const service = new LanguageService()
  const source = `/* 😀 */
@vars { --size: length = 1px; --t: time = 1s; }
@injection paint($p: time = 1s) { width: $p; }
.a {
  width: --t !important;
  border: --size solid red;
  color: rgb(1 2 3 / .5);
  animation-duration: --t + --t;
  @media (width > 1px) { display: fex; }
  height: var(--external, 1px);
  transition: (opacity, color) 1s;
  --custom: arbitrary tokens;
  content: preserve;
}
@font-face { font-family: arbitrary; src: url(font.woff); }
@property --other { syntax: "<color>"; inherits: false; initial-value: red; }`
  service.setFile('untitled:integration', 1, source)
  const diagnostics = validator.validateCss(service.cssDeclarations('untitled:integration'))
  assert.deepEqual(diagnostics.map(d => d.code), ['css.type-mismatch', 'css.type-mismatch', 'css.invalid-value'])
  assert.deepEqual(diagnostics[0].range.start, { line: 2, character: source.split('\n')[2].lastIndexOf('$p') })
  assert.equal(diagnostics[1].range.start.line, 4)
  assert.equal(diagnostics[2].range.start.line, 8)
  assert(diagnostics.every(d => !d.message.includes('1s')))
})
