// Builds playlists into public/.
// Usage: node scripts/build.mjs [--check] [--no-import]
import fs from 'node:fs/promises'
import path from 'node:path'
import { ROOT, loadConfig, loadLocal, loadIptvOrg, merge, toM3u, checkStream, pool } from './lib.mjs'

const args = new Set(process.argv.slice(2))
const config = await loadConfig()
const out = path.join(ROOT, 'public')

const local = await loadLocal()
let remote = { channels: [], streams: [] }
if (config.import?.enabled && !args.has('--no-import')) {
  remote = await loadIptvOrg(config.import)
  console.log(`iptv-org: ${remote.channels.length} channels, ${remote.streams.length} streams`)
}
const { channels, streams } = merge(local, remote)
let live = streams

if (args.has('--check')) {
  const { timeoutMs = 8000, concurrency = 20, dropDead = true } = config.check || {}
  console.log(`Checking ${streams.length} streams...`)
  const results = await pool(streams, concurrency, s => checkStream(s, timeoutMs))
  const dead = streams.filter((_, i) => !results[i].ok)
  for (const s of dead.filter(s => s.source === 'local')) {
    console.warn(`  dead (local): ${s.channel} ${s.url} — ${results[streams.indexOf(s)].reason}`)
  }
  console.log(`  ${streams.length - dead.length} online, ${dead.length} offline`)
  if (dropDead) live = streams.filter((_, i) => results[i].ok)
}

const entries = live
  .map(s => ({ channel: channels.get(s.channel), stream: s }))
  .sort((a, b) => a.channel.name.localeCompare(b.channel.name))

await fs.rm(out, { recursive: true, force: true })
await fs.mkdir(path.join(out, 'countries'), { recursive: true })
await fs.mkdir(path.join(out, 'categories'), { recursive: true })

const write = (file, list) => fs.writeFile(path.join(out, file), toM3u(list, config))
const groupBy = (keyFn) => {
  const m = new Map()
  for (const e of entries) for (const k of keyFn(e)) m.set(k, [...(m.get(k) || []), e])
  return new Map([...m].sort(([a], [b]) => a.localeCompare(b)))
}

await write('index.m3u', entries)
const byCountry = groupBy(e => [e.channel.country.toLowerCase()])
for (const [k, list] of byCountry) await write(`countries/${k}.m3u`, list)
const byCategory = groupBy(e => (e.channel.categories.length ? e.channel.categories : ['undefined']))
for (const [k, list] of byCategory) await write(`categories/${k}.m3u`, list)

await fs.writeFile(path.join(out, 'channels.json'), JSON.stringify(
  entries.map(e => ({ ...e.channel, url: e.stream.url, quality: e.stream.quality })), null, 2))

const link = (href, label, n) => `<li><a href="${href}">${label}</a> <small>${n} streams</small></li>`
await fs.writeFile(path.join(out, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${config.title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 16px;color:#222;background:#fff}
code{background:#f2f2f2;padding:2px 6px;border-radius:4px;word-break:break-all}small{color:#777}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#111}code{background:#222}a{color:#8ab4f8}}</style>
</head><body>
<h1>${config.title}</h1>
<p>Main playlist (${entries.length} streams): <code id="main">index.m3u</code></p>
<script>document.getElementById('main').textContent = new URL('index.m3u', location.href).href</script>
<p>Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
<h2>By country</h2><ul>${[...byCountry].map(([k, l]) => link(`countries/${k}.m3u`, k.toUpperCase(), l.length)).join('')}</ul>
<h2>By category</h2><ul>${[...byCategory].map(([k, l]) => link(`categories/${k}.m3u`, k, l.length)).join('')}</ul>
</body></html>
`)

console.log(`Wrote public/index.m3u with ${entries.length} streams (${byCountry.size} countries, ${byCategory.size} categories)`)
