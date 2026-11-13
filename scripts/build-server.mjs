import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
await mkdir('server/out', { recursive: true })
for (const name of ['index', 'worker', 'project', 'css-validation', 'formatting', 'css-values', 'vite-setup']) await build({
  entryPoints: [`server/src/${name}.ts`], outfile: `server/out/${name}.cjs`,
  bundle: true, platform: 'node', target: 'node20', format: 'cjs', sourcemap: true,
  external: ['@cross-css/native'],
  packages: 'bundle',
  alias: { '@cross-css/native/css-validation.cjs': require.resolve('@cross-css/native/css-validation.cjs'), 'jsonc-parser': 'jsonc-parser/lib/esm/main.js', 'css-tree': require.resolve('css-tree') },
})
