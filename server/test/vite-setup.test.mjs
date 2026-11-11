import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const { planSetup } = createRequire(import.meta.url)('../out/vite-setup.cjs')
const dependency = '@cross-css/vite'
const runtime = dependency + '/react'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'crossbreeze-vite-setup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, value) => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
    return file
  }
  const installed = () => {
    put('node_modules/@cross-css/vite/package.json', { version: '0.11.0' })
    put('node_modules/vite/package.json', { version: '8.0.0' })
  }
  const run = (path = '', files = {}) => planSetup({ root: join(root, path), files })
  const apply = plan => plan.edits.forEach(edit => writeFileSync(edit.path, edit.after))
  return { put, installed, run, apply }
}

test('offers dependency instructions before setup and rescans independent Vite packages', t => {
  const { put, installed, run } = fixture(t)
  put('pnpm-lock.yaml', '')
  put('apps/a/package.json', { devDependencies: { vite: '^8' } })
  put('apps/b/package.json', { devDependencies: { vite: '^8', [dependency]: '^0.11' } })
  put('apps/plain/package.json', {})
  assert.deepEqual(run('apps/a').edits, [])
  assert.match(run('apps/a').steps[0].message, /pnpm add -D @cross-css\/vite/)
  assert.equal(run('apps/plain'), null)
  installed()
  assert.equal(run('apps/b').edits.length, 1)
  assert.match(run('apps/a').steps[0].message, /Install/)
})

test('previews and completes a fresh React TS Vite app with project references and extends', t => {
  const { put, installed, run, apply } = fixture(t)
  installed()
  put('package.json', { dependencies: { react: '^19' }, devDependencies: { vite: '^8', [dependency]: '^0.11', '@vitejs/plugin-react': '*' } })
  put('src/app.tsx', 'export const App = () => <div />;')
  put('tsconfig.json', { files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }] })
  put('tsconfig.node.json', { files: ['vite.config.ts'] })
  put('tsconfig.base.json', { compilerOptions: { strict: true }, include: ['src'] })
  put('tsconfig.app.json', { extends: './tsconfig.base.json' })
  const env = put('src/vite-env.d.ts', '/// <reference types="vite/client" />\n')
  const vite = put('vite.config.ts', "import { defineConfig as cfg } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default cfg({ plugins: [react()], server: { port: 3001 } });\n")
  const plan = run()
  assert.equal(plan.edits.length, 3)
  assert.equal(readFileSync(env, 'utf8'), '/// <reference types="vite/client" />\n')
  const nextVite = plan.edits.find(edit => edit.path === vite).after
  assert.match(nextVite, /plugins: \[xcss\(\{ tsconfig: "\.\/tsconfig\.app\.json" \}\), react\(\{ jsxImportSource: "@cross-css\/vite\/react" \}\)\]/)
  assert.match(nextVite, /server: \{ port: 3001 \}/)
  const nextConfig = JSON.parse(plan.edits.find(edit => edit.path.endsWith('tsconfig.app.json')).after)
  assert.deepEqual(nextConfig, {
    extends: './tsconfig.base.json', compilerOptions: { jsx: 'react-jsx', jsxImportSource: runtime },
  })
  apply(plan)
  assert.deepEqual(run(), { edits: [], steps: [] })
})

test('creates an included declaration without changing implicit include, and leaves JS apps at Vite setup', t => {
  const { put, installed, run } = fixture(t)
  installed()
  put('package.json', { devDependencies: { vite: '^8', [dependency]: '*' } })
  put('src/main.ts', 'export {}')
  put('tsconfig.json', '{}')
  const plan = run()
  assert.equal(plan.edits.length, 2)
  assert(plan.edits.some(edit => edit.path.endsWith('src\\xcss-env.d.ts') || edit.path.endsWith('src/xcss-env.d.ts')))
  put('js/package.json', { dependencies: { react: '^19', vite: '^8', [dependency]: '*' } })
  const js = run('js')
  assert.equal(js.edits.length, 1)
  assert.match(js.edits[0].path, /vite\.config\.js$/)
  assert(js.steps.some(step => /xClass and xVars need/.test(step.message)))
})

test('recognizes an existing ambient declaration and makes no paired JSX changes on conflicts', t => {
  const { put, installed, run } = fixture(t)
  installed()
  put('package.json', { dependencies: { react: '^19', vite: '^8', [dependency]: '*' } })
  put('tsconfig.json', { include: ['src'] })
  put('src/app.tsx', 'export {}')
  put('src/env.d.ts', "declare module '*.xcss' {}")
  const vite = put('vite.config.ts', 'export default { plugins: [] }')
  assert.equal(run().edits.length, 2)
  assert.match(run().edits[0].after, /oxc: \{ jsx:/)
  const dynamic = run('', { [vite]: 'export default () => ({ plugins: [] })' })
  assert.deepEqual(dynamic.edits, [])
  assert.match(dynamic.steps[0].message, /dynamic/)
  const conflict = run('', { [vite]: 'export default { oxc: { jsx: { importSource: "another-runtime" } } }' })
  assert.deepEqual(conflict.edits, [])
  assert.match(conflict.steps[0].message, /Resolve the existing oxc/)
})

test('moves an existing XCSS registration ahead of React and preserves other plugin order', t => {
  const { put, installed, run } = fixture(t)
  installed()
  put('package.json', { dependencies: { react: '^19', vite: '^8', [dependency]: '*' } })
  put('tsconfig.json', { files: ['main.tsx', 'env.d.ts'] })
  put('main.tsx', 'export {}')
  put('env.d.ts', '/// <reference types="@cross-css/vite/client" />\n')
  const config = put('vite.config.ts', [
    "import react from '@vitejs/plugin-react';",
    "import colors from 'colors-plugin';",
    "import css from '@cross-css/vite';",
    'export default { plugins: [react(), colors(), css()] };',
  ].join('\n'))
  const plan = run()
  const after = plan.edits.find(edit => edit.path === config).after
  assert(after.indexOf('css()') < after.indexOf('react({'))
  assert(after.indexOf('react({') < after.indexOf('colors()'))
  assert.equal((after.match(/\bcss\(\)/g) ?? []).length, 1)
})

test('recognizes Vite Plus lazy plugins and previews migration of the existing legacy registration', t => {
  const { put, installed, run, apply } = fixture(t)
  installed()
  put('package.json', { dependencies: { react: '^19', 'vite-plus': '*', [dependency]: '*' } })
  put('tsconfig.json', { files: [], references: [{ path: './tsconfig.app.json' }] })
  put('tsconfig.app.json', { compilerOptions: { jsx: 'react-jsx', types: ['vite/client'] }, include: ['src'] })
  put('src/app.tsx', 'export {}')
  const vite = put('vite.config.ts', [
    'import { defineConfig as config, lazyPlugins as lazy } from "vite-plus";',
    'import xcss from "@cross-css/vite-plugin";',
    'import react, { reactCompilerPreset } from "@vitejs/plugin-react";',
    'import babel from "@rolldown/plugin-babel";',
    'export default config({ fmt: {}, plugins: lazy(() => [xcss(), react(), babel({ presets: [reactCompilerPreset()] })]) });',
  ].join('\n'))
  const plan = run()
  const after = plan.edits.find(edit => edit.path === vite).after
  assert.match(after, /import xcss from "@cross-css\/vite"/)
  assert.match(after, /lazy\(\(\) => \[xcss\(\{ tsconfig: "\.\/tsconfig\.app\.json" \}\), react\(\{ jsxImportSource: "@cross-css\/vite\/react" \}\), babel/)
  assert.equal((after.match(/\bxcss\(/g) ?? []).length, 1)
  assert(plan.steps.some(step => step.message.includes('tsconfig.app.json')))
  assert(plan.steps.some(step => step.message.includes('jsxImportSource')))
  apply(plan)
  assert.deepEqual(run(), { edits: [], steps: [] })
})

