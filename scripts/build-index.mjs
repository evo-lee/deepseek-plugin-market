#!/usr/bin/env node
/**
 * Generate the DSH plugin index for this repository.
 *
 * One source of truth: each plugin's `package.json` (name, version, description)
 * plus its `locale/*.json` (titles, descriptions) and `icon.svg`. Nothing about
 * a plugin is retyped here.
 *
 * The index must name an absolute repository URL and an exact 40-hex commit, so
 * generation needs a git remote. Without one the script fails with the exact
 * commands to run rather than writing a plausible-looking but wrong index.
 *
 * Usage:
 *   node scripts/build-index.mjs                      # uses `origin`
 *   node scripts/build-index.mjs --repo-url https://github.com/you/repo
 *   node scripts/build-index.mjs --out /tmp/index.json
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Plugin directories, in display order. */
const ORDER = ['dsh-english-buddy', 'dsh-deepseek-meter']

/** Category per package name; `metadata.categories` below declares them. */
const CATEGORY = {
  'dsh-english-buddy': 'coaching',
  'dsh-deepseek-meter': 'observability',
}

/** Largest inline icon the index format allows. */
const ICON_LIMIT = 32 * 1024

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

/** Parse `--flag value` pairs. */
function args(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      index += 1
    }
  }
  return out
}

/** Read one plugin's locale metadata, or undefined when absent. */
function localeMeta(dir, language) {
  try {
    const text = readFileSync(join(dir, 'locale', `${language}.json`), 'utf8')
    const parsed = JSON.parse(text)
    return parsed?.meta ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Build a LocalizedText value.
 *
 * The format requires `en` inside an object, so a plugin with only one language
 * emits a plain string instead of an object.
 */
function localized(zh, en) {
  if (typeof zh === 'string' && typeof en === 'string' && zh.length > 0 && en.length > 0) return { en, zh }
  if (typeof en === 'string' && en.length > 0) return en
  if (typeof zh === 'string' && zh.length > 0) return zh
  return undefined
}

/** Inline one icon as a data URL, refusing anything over the format limit. */
function iconOf(dir, name) {
  const file = join(dir, 'icon.svg')
  let bytes
  try {
    bytes = readFileSync(file)
  } catch {
    return undefined
  }
  if (bytes.length > ICON_LIMIT) {
    process.stderr.write(`warn: ${name}/icon.svg is ${bytes.length} bytes, over the 32 KiB inline limit; skipped\n`)
    return undefined
  }
  return `data:image/svg+xml;base64,${bytes.toString('base64')}`
}

/** Web URL for the repository, from an explicit flag or `origin`. */
function repositoryUrl(flags) {
  if (typeof flags['repo-url'] === 'string') return flags['repo-url'].replace(/\.git$/, '').replace(/\/$/, '')
  let remote
  try {
    remote = git('remote', 'get-url', 'origin')
  } catch {
    remote = undefined
  }
  if (remote === undefined || remote.length === 0) {
    process.stderr.write([
      'No git remote named `origin`, and no --repo-url given.',
      'The index must name an absolute source URL and an exact commit, so there is',
      'nothing truthful to generate yet. Create the repository first:',
      '',
      '  git remote add origin https://github.com/<owner>/deepseek-plugin-market.git',
      '  git push -u origin main',
      '  node scripts/build-index.mjs',
      '',
      'Or pass the URL directly: node scripts/build-index.mjs --repo-url https://github.com/<owner>/deepseek-plugin-market',
    ].join('\n') + '\n')
    process.exit(1)
  }
  return remote
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
}

const flags = args(process.argv.slice(2))
const repoUrl = repositoryUrl(flags)
const commit = flags.commit === undefined ? git('rev-parse', 'HEAD') : String(flags.commit)
if (!/^[0-9a-f]{40}$/.test(commit)) {
  process.stderr.write(`error: commit must be a 40-character sha, got ${JSON.stringify(commit)}\n`)
  process.exit(1)
}
const publishTimestamp = Number(git('log', '-1', '--format=%ct'))

const pluginRoot = join(ROOT, 'plugins')
// Only DSH bundles belong in this index. A Claude Code plugin (for clds) has a
// package.json too, but no dsh.bundle.patch; listing it here would offer DSH
// users an install that cannot work.
function isDshPlugin(directory) {
  try {
    if (!statSync(join(pluginRoot, directory, 'package.json')).isFile()) return false
    const manifest = JSON.parse(readFileSync(join(pluginRoot, directory, 'package.json'), 'utf8'))
    return typeof manifest.dsh?.bundle?.patch === 'string'
  } catch {
    return false
  }
}
const available = readdirSync(pluginRoot).filter(isDshPlugin)
const directories = ORDER.filter(name => available.includes(name))
  .concat(available.filter(name => !ORDER.includes(name)).sort())

const plugins = []
for (const directory of directories) {
  const dir = join(pluginRoot, directory)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const zh = localeMeta(dir, 'zh')
  const en = localeMeta(dir, 'en')
  const relativePath = relative(ROOT, dir).split('\\').join('/')
  const entry = {
    name: manifest.name,
    versions: [{
      version: manifest.version,
      publishTimestamp,
      source: { type: 'git', url: repoUrl, commit, path: relativePath },
    }],
    repository: { url: repoUrl, directory: relativePath },
  }
  const title = localized(zh?.title, en?.title)
  const description = localized(zh?.description, en?.description)
  if (title !== undefined) entry.title = title
  if (description !== undefined) entry.description = description
  const icon = iconOf(dir, manifest.name)
  if (icon !== undefined) entry.icon = icon
  if (CATEGORY[manifest.name] !== undefined) entry.metadata = { category: CATEGORY[manifest.name] }
  plugins.push(entry)
}

const index = {
  format: 1,
  title: { en: 'DeepSeek Harness plugins by litang', zh: 'litang 的 DeepSeek Harness 插件' },
  description: {
    en: 'A prompt coach and a usage meter for DeepSeek Harness.',
    zh: 'DeepSeek Harness 的英文提示教练与用量表。',
  },
  metadata: {
    categories: {
      coaching: { title: { en: 'Language coaching', zh: '语言教练' } },
      observability: { title: { en: 'Usage and balance', zh: '用量与余额' } },
    },
  },
  plugins,
}

const out = typeof flags.out === 'string' ? resolve(flags.out) : join(ROOT, 'index.json')
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`)
process.stdout.write(`wrote ${out}: ${plugins.length} plugin(s) at ${commit.slice(0, 12)} from ${repoUrl}\n`)
