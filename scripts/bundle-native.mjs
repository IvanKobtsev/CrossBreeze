import { readFile, writeFile, mkdir, copyFile, mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { bundleRoot, hostTarget, loader, nativePackages, targets } from './bundle-targets.mjs'

const version = JSON.parse(await readFile('package.json', 'utf8')).dependencies[loader]
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
const args = process.argv.slice(2)
let stages
if (!args.length) stages = ['common', hostTarget()]
else if (args.length === 1 && args[0] === '--common') stages = ['common']
else if (args.length === 2 && args[0] === '--target' && Object.hasOwn(targets, args[1])) stages = [args[1]]
else throw new Error('Usage: bundle-native.mjs [--common | --target <os>-<arch>]')

async function extractPackages(packages, destination, archive) {
  const manifest = []
  for (const name of packages) {
    const entry = lock.packages[`node_modules/${name}`] ?? Object.entries(lock.packages).find(([key, value]) => key.endsWith(`/node_modules/${name}`) && value.version === version)?.[1]
    assert.equal(entry?.version, version, `Missing exact registry lock entry for ${name}`)
    assert(entry.resolved.startsWith('https://registry.npmjs.org/'), 'Only published npm registry packages are allowed')
    assert.match(entry.integrity, /^sha512-/)
    const response = await fetch(entry.resolved)
    if (!response.ok) throw new Error(`Cannot fetch ${name}@${version}: ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, entry.integrity, `Integrity mismatch for ${name}`)
    await writeFile(archive, bytes)
    const target = join(destination, 'node_modules', name)
    await mkdir(target, { recursive: true })
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/)
    const allowed = name === loader
      ? ['package.json', 'index.js', 'index.d.ts', 'platform.cjs', 'LICENSE', 'README.md', 'TSRS-LICENSE', 'TSRS-NOTICE']
      : ['package.json', 'xcss.node', 'LICENSE', 'README.md']
    const files = allowed.filter(file => listing.includes(`package/${file}`))
    assert(files.includes('package.json') && files.includes('LICENSE'))
    assert(files.includes(name === loader ? 'index.js' : 'xcss.node'))
    if (name === loader) {
      for (const file of ['platform.cjs', 'TSRS-LICENSE', 'TSRS-NOTICE']) assert(files.includes(file), `Missing ${file}`)
    }
    execFileSync('tar', ['-xzf', archive, '-C', target, '--strip-components=1', ...files.map(file => `package/${file}`)])
    assert.equal(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).version, version)
    const hashes = {}
    for (const file of files) hashes[file] = createHash('sha256').update(await readFile(join(target, file))).digest('hex')
    manifest.push({ name, version, resolved: entry.resolved, integrity: entry.integrity, hashes })
  }
  return manifest
}

async function copySharedFiles(destination) {
  for (const name of ['index.cjs', 'index.cjs.map', 'worker.cjs', 'worker.cjs.map']) {
    await copyFile(join('server/out', name), join(destination, name))
  }
  const licenses = join(destination, 'licenses')
  await mkdir(licenses, { recursive: true })
  for (const key of Object.keys(lock.packages)) {
    if (!key.startsWith('node_modules/') || key.includes(`/${loader}-`)) continue
    for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'License.txt', 'license']) {
      try { await copyFile(join(key, file), join(licenses, `${key.replaceAll('/', '_')}_${file}`)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
}

await mkdir(bundleRoot, { recursive: true })
for (const stage of stages) {
  const temporary = await mkdtemp(join(bundleRoot, '.staging-'))
  try {
    const common = stage === 'common'
    const output = join(temporary, 'output')
    const server = join(output, 'server')
    await mkdir(server, { recursive: true })
    if (common) await copySharedFiles(server)
    const packages = common ? [loader] : nativePackages(stage)
    const manifest = await extractPackages(packages, server, join(temporary, 'package.tgz'))
    const manifestName = common ? 'native-loader-manifest.json' : 'native-platform-manifest.json'
    await writeFile(join(server, manifestName), JSON.stringify(manifest, null, 2) + '\n')
    // Stage names are fixed or validated against native-targets.json above.
    const destination = join(bundleRoot, stage)
    await rm(destination, { recursive: true, force: true })
    await rename(output, destination)
    console.log(`Staged XCSS ${version} packages for ${stage}`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
