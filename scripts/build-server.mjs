import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
await mkdir('server/out', { recursive: true })
for (const name of ['index', 'worker', 'project']) await build({
  entryPoints: [`server/src/${name}.ts`], outfile: `server/out/${name}.cjs`,
  bundle: true, platform: 'node', target: 'node20', format: 'cjs', sourcemap: true,
  external: ['@cross-css/native'],
  alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
})
