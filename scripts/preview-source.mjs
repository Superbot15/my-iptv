// Shows what an M3U playlist would add before you put it in config.json.
// Usage: node scripts/preview-source.mjs <playlist url or path> [name]
// In GitHub Actions the report is also written to the run's summary page.
import fs from 'node:fs/promises'
import { ROOT, loadConfig, loadIptvOrg, loadM3uSource, parseM3u, rawUrl, checkStream, pool } from './lib.mjs'
import path from 'node:path'

const [url, name = 'New source'] = process.argv.slice(2)
if (!url) {
  console.error('Usage: node scripts/preview-source.mjs <playlist url> [name]')
  process.exit(1)
}

const config = await loadConfig()
const candidate = await loadM3uSource({ name, url, epg: true })
const raw = parseM3u(/^https?:/.test(url) ? await (await fetch(rawUrl(url))).text() : await fs.readFile(path.resolve(ROOT, url), 'utf8'))

// Everything the playlist already has, to tell new channels from duplicates.
const known = { ids: new Set(), urls: new Set() }
const add = r => { for (const c of r.channels) known.ids.add(c.id); for (const s of r.streams) known.urls.add(s.url) }
if (config.import?.enabled) add(await loadIptvOrg(config.import))
for (const src of (config.sources || []).filter(s => s.enabled !== false && rawUrl(s.url) !== rawUrl(url))) {
  try { add(await loadM3uSource(src)) } catch (e) { console.warn(`${src.name}: skipped (${e.message})`) }
}

const newChannels = candidate.channels.filter(c => !known.ids.has(c.id) && !c.unlinked)
const unlinked = candidate.channels.filter(c => !known.ids.has(c.id) && c.unlinked)
const newStreams = candidate.streams.filter(s => !known.urls.has(s.url))
const top = (list, key, n) => {
  const m = {}
  for (const x of list) for (const k of [].concat(key(x))) m[k] = (m[k] || 0) + 1
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n)
}

// Check a sample rather than everything, to keep the preview quick.
const sample = [...candidate.streams].sort(() => Math.random() - 0.5).slice(0, 40)
const results = await pool(sample, 20, s => checkStream(s, config.check?.timeoutMs || 10000))
const passed = results.filter(r => r.ok || r.blocked).length

const table = rows => ['| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k || '(none)'} | ${v} |`)].join('\n')
const md = `## Preview: ${name}

\`${rawUrl(url)}\`

| | |
|---|---|
| Entries | ${candidate.streams.length} streams, ${candidate.channels.length} channels |
| New channels (matched to iptv-org ids, not already in your playlist) | ${newChannels.length} |
| New channels without an id (matched by name only) | ${unlinked.length} |
| Stream links not already in your playlist | ${newStreams.length} |
| Sample check | ${passed} of ${sample.length} played |
| TV guide declared by the playlist | ${candidate.epg.length} URLs |

### Top countries
${table(top(candidate.channels, c => c.country, 10))}

### Top groups
${table(top(raw, e => e.attrs['group-title'] || '', 15))}

### Sample of new channel names
${[...newChannels, ...unlinked].slice(0, 30).map(c => c.name).join(', ') || '(none)'}

### To add it, put this in "sources" in config.json
\`\`\`json
{ "name": ${JSON.stringify(name)}, "url": ${JSON.stringify(rawUrl(url))} }
\`\`\`
`

console.log(md)
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md)
