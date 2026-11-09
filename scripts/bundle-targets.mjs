import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const bundleRoot = resolve('dist/bundle')
export const targets = JSON.parse(await readFile(new URL('./native-targets.json', import.meta.url), 'utf8'))
export const loader = '@cross-css/native'
export const nativePackages = target => targets[target].map(suffix => `${loader}-${suffix}`)

export function hostTarget() {
  const os = { linux: 'linux', darwin: 'mac', win32: 'windows' }[process.platform]
  const arch = { x64: 'x86_64', arm64: 'arm64' }[process.arch]
  const target = `${os}-${arch}`
  assert(Object.hasOwn(targets, target), `Unsupported Node platform: ${process.platform}/${process.arch}`)
  return target
}
