// The Claude Code manifest is a contract, not decoration: the declared
// `network.hosts` is the set of endpoints this plugin may reach, and the plugin
// deliberately supports every Anthropic-compatible launcher. A new provider
// family without its host here would fail only at run time, on the user's
// machine, as a blocked request.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const manifestPath = `${here}/../.claude-plugin/plugin.json`
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

/** Every host a provider family in `scripts/lib/provider.mjs` can target. */
const PROVIDER_HOSTS = [
  'api.deepseek.com', // clds / DeepSeek
  'api.anthropic.com', // no launcher
  'api.kimi.com', // clkc / Kimi Code
  'api.kimi.ai',
  'api.moonshot.cn', // clki / Moonshot
  'api.moonshot.ai',
  'localhost', // local endpoints
  '127.0.0.1',
]

test('the manifest allows every host the provider can target', () => {
  const hosts = new Set(manifest.network?.hosts ?? [])
  for (const host of PROVIDER_HOSTS) {
    assert.ok(hosts.has(host), `plugin.json network.hosts is missing ${host}`)
  }
})

test('the manifest keeps its plugin identity', () => {
  const directory = basename(dirname(here))
  assert.equal(manifest.name, directory, 'plugin.json name must match the directory')
  assert.match(manifest.version, /^\d+\.\d+\.\d+/, 'version must be exact SemVer')
  assert.equal(manifest.dsh, undefined, 'a Claude Code plugin must not carry a DSH bundle field')
})

test('the marketplace lists this plugin at this directory', () => {
  const marketplace = JSON.parse(readFileSync(`${here}/../../../.claude-plugin/marketplace.json`, 'utf8'))
  const entry = marketplace.plugins.find(plugin => plugin.name === manifest.name)
  assert.ok(entry, 'the marketplace must list this plugin')
  assert.equal(entry.source, `./plugins/${manifest.name}`)
  assert.equal(entry.version, manifest.version, 'the marketplace version must match the manifest')
})
