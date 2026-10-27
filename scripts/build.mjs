// Builds playlists into public/.
// Usage: node scripts/build.mjs [--check] [--no-import]
import fs from 'node:fs/promises'
import path from 'node:path'
import { ROOT, loadConfig, loadLocal, loadIptvOrg, loadM3uSource, merge, toM3u, checkStream, pool } from './lib.mjs'
import { loadArchive } from './archive.mjs'

const args = new Set(process.argv.slice(2))
const config = await loadConfig()
const out = path.join(ROOT, 'public')

const report = { sources: [], check: null }
const note = (name, r, error) => {
  report.sources.push({ name, channels: r?.channels.length ?? 0, streams: r?.streams.length ?? 0, ...(error && { error }) })
  console.log(error ? `${name}: skipped (${error})` : `${name}: ${r.channels.length} channels, ${r.streams.length} streams`)
}

const local = await loadLocal()
note('local', local)
let remote = { channels: [], streams: [] }
if (config.import?.enabled && !args.has('--no-import')) {
  remote = await loadIptvOrg(config.import)
  note('iptv-org', remote)
}
const extra = []
for (const src of args.has('--no-import') ? [] : (config.sources || []).filter(s => s.enabled !== false)) {
  // One unreachable source shouldn't block the whole build.
  try {
    const r = await loadM3uSource(src)
    note(src.name, r)
    extra.push(r)
  } catch (e) {
    note(src.name, null, e.message)
  }
}
if (config.archive?.enabled && !args.has('--no-import')) {
  await fs.mkdir(path.join(ROOT, '.cache'), { recursive: true })
  const r = await loadArchive(config.archive, { cachePath: path.join(ROOT, '.cache', 'archive.json') })
  for (const row of r.report) {
    report.sources.push(row)
    const bw = (row.removedBlackAndWhite ? `, ${row.removedBlackAndWhite} black-and-white removed (${row.removedByTag} tagged, ${row.removedByYear} by year)` : '') +
      (row.removedOld ? `, ${row.removedOld} before ${config.archive.minYear} removed` : '')
    console.log(row.error ? `${row.name}: skipped (${row.error})` : `${row.name}: ${row.channels} titles, ${row.streams} videos${bw}`)
  }
  extra.push(r)
}
const { channels, streams } = merge(local, remote, ...extra)
const epgUrl = [...new Set([config.epgUrl, ...extra.flatMap(r => r.epg)].filter(Boolean))].join(',')
let live = streams
let offline = []
let online = null

if (args.has('--check')) {
  const { timeoutMs = 8000, concurrency = 20, dropDead = true, keepBlocked = true } = config.check || {}
  // On-demand files (Internet Archive) are stable, so only live streams are checked.
  const toCheck = streams.filter(s => !s.skipCheck)
  console.log(`Checking ${toCheck.length} streams...`)
  const checked = await pool(toCheck, concurrency, s => checkStream(s, timeoutMs))
  const byStream = new Map(toCheck.map((s, i) => [s, checked[i]]))
  const results = streams.map(s => byStream.get(s) || { ok: true })
  const keep = (_, i) => results[i].ok || (keepBlocked && results[i].blocked)
  const dead = streams.filter((s, i) => !keep(s, i))
  for (const s of dead.filter(s => s.source === 'local')) {
    console.warn(`  dead (local): ${s.channel} ${s.url} — ${results[streams.indexOf(s)].reason}`)
  }
  const blocked = results.filter(r => r.blocked).length
  console.log(`  ${toCheck.length - dead.length} kept (${blocked} possibly geo-blocked), ${dead.length} offline`)
  const reasons = {}
  for (const r of results) if (!r.ok) reasons[r.reason] = (reasons[r.reason] || 0) + 1
  report.check = { checked: toCheck.length, kept: toCheck.length - dead.length, blocked, offline: dead.length, reasons }
  offline = dead
  if (dropDead) live = streams.filter(keep)
  online = streams.filter(keep)
  // Fail rather than publish an empty playlist (e.g. the runner lost network), so the last good one stays live.
  if (streams.length && !online.length) throw new Error('Every stream failed the check; not publishing')
}

const toEntries = list => list
  .map(s => ({ channel: channels.get(s.channel), stream: s }))
  .sort((a, b) => a.channel.name.localeCompare(b.channel.name))
const entries = toEntries(live)

await fs.rm(out, { recursive: true, force: true })
await fs.mkdir(path.join(out, 'countries'), { recursive: true })
await fs.mkdir(path.join(out, 'categories'), { recursive: true })

const write = (file, list) => fs.writeFile(path.join(out, file), toM3u(list, { epgUrl }))
const groupBy = (keyFn) => {
  const m = new Map()
  for (const e of entries) for (const k of keyFn(e)) m.set(k, [...(m.get(k) || []), e])
  return new Map([...m].sort(([a], [b]) => a.localeCompare(b)))
}

await write('index.m3u', entries)
// Streams the checker removed. GitHub checks from the US, so some may still play where you are.
await write('offline.m3u', toEntries(offline))
await write('movies.m3u', entries.filter(e => e.channel.vod === 'movie'))
await write('tv.m3u', entries.filter(e => e.channel.vod === 'tv'))
// With dropDead off, index.m3u has everything and online.m3u only the streams that passed.
if (online) await write('online.m3u', toEntries(online))
const byCountry = groupBy(e => (e.channel.vod ? [] : [e.channel.country.toLowerCase() || 'undefined']))
for (const [k, list] of byCountry) await write(`countries/${k}.m3u`, list)
const byCategory = groupBy(e => (e.channel.categories.length ? e.channel.categories : ['undefined']))
for (const [k, list] of byCategory) await write(`categories/${k}.m3u`, list)

await fs.writeFile(path.join(out, 'channels.json'), JSON.stringify(
  entries.map(e => ({ ...e.channel, url: e.stream.url, quality: e.stream.quality })), null, 2))
await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))

const link = (href, label, n) => `<li><a href="${href}">${label}</a> <small>${n} streams</small></li>`
const esc = v => String(v).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)
const sourceRows = report.sources.map(s =>
  `<tr><td>${esc(s.name)}</td><td>${s.error ? `<b>failed:</b> ${esc(s.error)}` : `${s.channels} channels, ${s.streams} streams`}${
    s.removedBlackAndWhite ? ` <small>(${s.removedBlackAndWhite} black-and-white removed)</small>` : ''}${
    s.removedOld ? ` <small>(${s.removedOld} before ${config.archive.minYear} removed)</small>` : ''}</td></tr>`).join('')
const c = report.check
const checkHtml = c ? `<p>Checked ${c.checked} streams after removing duplicates: ${c.kept} passed (${c.blocked} of them possibly geo-blocked), ${c.offline} failed${config.check?.dropDead === false ? ' (kept in index.m3u anyway)' : ' and were removed'}.
Failed streams are in <a href="offline.m3u">offline.m3u</a> (some may still play from your location); streams that passed are in <a href="online.m3u">online.m3u</a>.</p>
<table>${Object.entries(c.reasons).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([r, n]) => `<tr><td>${esc(r)}</td><td>${n}</td></tr>`).join('')}</table>` : ''
await fs.writeFile(path.join(out, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${config.title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 16px;color:#222;background:#fff}
code{background:#f2f2f2;padding:2px 6px;border-radius:4px;word-break:break-all}small{color:#777}
td{padding:2px 12px 2px 0;vertical-align:top}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#111}code{background:#222}a{color:#8ab4f8}}</style>
</head><body>
<h1>${config.title}</h1>
<p>Main playlist (${entries.length} streams): <code id="main">index.m3u</code></p>
<script>document.getElementById('main').textContent = new URL('index.m3u', location.href).href</script>
<p>Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
<p>On demand: <a href="movies.m3u">movies.m3u</a> (${entries.filter(e => e.channel.vod === 'movie').length}) and <a href="tv.m3u">tv.m3u</a> (${entries.filter(e => e.channel.vod === 'tv').length} episodes)</p>
<h2>Sources</h2><table>${sourceRows}</table>
${checkHtml}
<h2>By country</h2><ul>${[...byCountry].map(([k, l]) => link(`countries/${k}.m3u`, k.toUpperCase(), l.length)).join('')}</ul>
<h2>By category</h2><ul>${[...byCategory].map(([k, l]) => link(`categories/${k}.m3u`, k, l.length)).join('')}</ul>
</body></html>
`)

console.log(`Wrote public/index.m3u with ${entries.length} streams (${byCountry.size} countries, ${byCategory.size} categories)`)

// In GitHub Actions, also post the counts as annotations so they show on the run page.
if (process.env.GITHUB_ACTIONS) {
  const summary = report.sources.map(r => `${r.name}: ${r.error ? `failed (${r.error})` : `${r.channels} channels, ${r.streams} streams`}` +
    (r.removedBlackAndWhite ? `, ${r.removedBlackAndWhite} black-and-white removed (${r.removedByTag} tagged, ${r.removedByYear} by year)` : '') +
    (r.removedOld ? `, ${r.removedOld} before ${config.archive.minYear} removed` : ''))
  if (c) summary.push(`Check: ${c.kept} of ${c.checked} live streams passed`)
  summary.push(`Published: ${entries.length} entries`)
  console.log(`::notice title=Playlist report::${summary.join('%0A')}`)
}
