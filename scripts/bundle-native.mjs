import { readFile, writeFile, mkdir, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const version = JSON.parse(await readFile('package.json', 'utf8')).dependencies['@cross-css/native']
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
const destination = resolve('dist/server')
await mkdir(destination, { recursive: true })
for (const name of ['index.cjs', 'index.cjs.map', 'worker.cjs', 'worker.cjs.map']) await copyFile(join('server/out', name), join(destination, name))
const packages = ['@cross-css/native', ...['darwin-arm64', 'darwin-x64', 'win32-arm64-msvc', 'win32-x64-msvc', 'linux-arm64-gnu', 'linux-x64-gnu', 'linux-arm64-musl', 'linux-x64-musl'].map(target => `@cross-css/native-${target}`)]
const manifest = []
const temporary = await mkdtemp(join(tmpdir(), 'crossbreeze-packages-'))
try {
  for (const name of packages) {
    const entry = lock.packages[`node_modules/${name}`] ?? Object.entries(lock.packages).find(([key, value]) => key.endsWith(`/node_modules/${name}`) && value.version === version)?.[1]
    assert.equal(entry?.version, version, `Missing exact registry lock entry for ${name}`)
    assert(entry.resolved.startsWith('https://registry.npmjs.org/'), 'Only published npm registry packages are allowed')
    assert.match(entry.integrity, /^sha512-/)
    const response = await fetch(entry.resolved)
    if (!response.ok) throw new Error(`Cannot fetch ${name}@${version}: ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, entry.integrity, `Integrity mismatch for ${name}`)
    const archive = join(temporary, 'package.tgz')
    await writeFile(archive, bytes)
    const target = join(destination, 'node_modules', name)
    await mkdir(target, { recursive: true })
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/)
    const allowed = name === '@cross-css/native' ? ['package.json', 'index.js', 'index.d.ts', 'LICENSE', 'README.md'] : ['package.json', 'xcss.node', 'LICENSE', 'README.md']
    const files = allowed.filter(file => listing.includes(`package/${file}`))
    assert(files.includes('package.json') && files.includes('LICENSE'))
    assert(files.includes(name === '@cross-css/native' ? 'index.js' : 'xcss.node'))
    execFileSync('tar', ['-xzf', archive, '-C', target, '--strip-components=1', ...files.map(file => `package/${file}`)])
    assert.equal(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).version, version)
    const hashes = {}
    for (const file of files) hashes[file] = createHash('sha256').update(await readFile(join(target, file))).digest('hex')
    manifest.push({ name, version, resolved: entry.resolved, integrity: entry.integrity, hashes })
  }
  const licenses = join(destination, 'licenses')
  await mkdir(licenses, { recursive: true })
  for (const key of Object.keys(lock.packages).filter(key => key.startsWith('node_modules/'))) {
    for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'License.txt', 'license']) {
      try { await copyFile(join(key, file), join(licenses, `${key.replaceAll('/', '_')}_${file}`)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  await writeFile(join(destination, 'native-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert(basename(temporary).startsWith('crossbreeze-packages-'))
  await rm(temporary, { recursive: true, force: true })
}
console.log('Bundled the published XCSS loader and all eight native platforms')
