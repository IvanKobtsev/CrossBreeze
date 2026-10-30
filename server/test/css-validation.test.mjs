import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { lexer } from 'css-tree'
const require = createRequire(import.meta.url)
const { validateCss, representatives } = require('../out/css-validation.cjs')
const range = (start, end, line = 0) => ({ start: { line, character: start }, end: { line, character: end } })
function declaration(property, parts, overrides = {}) {
  return { property, parts, propertyRange: range(0, property.length), valueRange: range(10, 60), checkable: true, context: 'rule', ...overrides }
}
const literal = (text, start = 10, line = 0) => ({ text, range: range(start, start + text.length, line) })
const typed = (valueType, start = 10) => ({ valueType, range: range(start, start + 4) })
const validate = (declarations, options) => validateCss({ revision: 1, declarations }, options)

test('all representatives match their CSS type', () => {
  for (const [type, value] of Object.entries(representatives)) assert.equal(lexer.matchType(type, value).error, null, type)
})
test('property and value typos; valid CSS, custom properties and important', () => {
  const results = validate([
    declaration('dispay', [literal('fex')]), declaration('display', [literal('fex')]),
    ...['flex', 'inherit', 'initial', 'revert-layer', 'flex !important', 'flex ! /*comment*/ IMPORTANT'].map(value => declaration('display', [literal(value)])),
    declaration('--anything', [literal('any tokens go here')]),
  ])
  assert.deepEqual(results.map(d => d.code), ['css.unknown-property', 'css.invalid-value'])
  assert.deepEqual(results[1].range, range(10, 13))
})
test('typed checks hide representatives and follow broad type policy', () => {
  const results = validate([
    declaration('width', [literal(' '), typed('time', 11), literal(' !important', 15)]),
    declaration('z-index', [typed('number')]), declaration('width', [typed('length')]),
  ])
  assert.equal(results.length, 1)
  assert.equal(results[0].code, 'css.type-mismatch')
  assert.deepEqual(results[0].range, range(11, 15))
  assert.match(results[0].message, /time.*width/)
  assert(!results[0].message.includes('1s'))
})
test('mixed values map failures after substitutions without exposing synthetic text', () => {
  const results = validate([
    declaration('border', [typed('length'), literal(' solid ', 14), typed('time', 21)]),
    declaration('border', [typed('length'), literal(' solid ', 14), typed('color', 21)]),
    declaration('border', [typed('length'), literal(' solid bogus', 14)]),
  ])
  assert.equal(results.length, 2)
  assert.deepEqual(results[0].range, range(21, 25))
  assert.deepEqual(results[1].range, range(21, 26))
  assert(results.every(d => d.code === 'css.invalid-value' && !d.message.includes('1s')))
})
test('multiline, comments and UTF-16 mapping', () => {
  const results = validate([declaration('display', [literal('/* 😀 */\r\n fex', 10)])])
  assert.deepEqual(results[0].range, { start: { line: 1, character: 1 }, end: { line: 1, character: 4 } })
  const singleLine = validate([declaration('display', [literal('/* 😀 */\r fex', 10)])])
  assert.deepEqual(singleLine[0].range, range(20, 23))
})
test('unknown or unresolved values and native var are skipped', () => {
  assert.deepEqual(validate([
    declaration('width', [typed('future-type')]), declaration('width', [], { checkable: false }),
    declaration('width', [typed('constructor')]),
    declaration('width', [literal('var(--external)')]),
  ]), [])
  assert.equal(validate([declaration('dispay', [], { checkable: false })]).length, 1)
})
test('independent settings and unexpected failures', () => {
  const declarations = [declaration('dispay', []), declaration('display', [literal('fex')])]
  assert.deepEqual(validate(declarations, { checkCssProperties: false, checkCssValues: true }).map(d => d.code), ['css.invalid-value'])
  assert.deepEqual(validate(declarations, { checkCssProperties: true, checkCssValues: false }).map(d => d.code), ['css.unknown-property'])
  const messages = []
  const broken = declaration('display', [])
  Object.defineProperty(broken, 'parts', { get() { throw new Error('synthetic private value') } })
  assert.deepEqual(validateCss({ revision: 1, declarations: [broken] }, undefined, m => messages.push(m)), [])
  assert.equal(messages.length, 1)
  assert(!messages[0].includes('synthetic private value'))
})
