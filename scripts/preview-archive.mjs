// Lists what the current config.json keeps and removes from the Internet Archive movies,
// without publishing anything. Only removals of titles released from --since on are listed,
// i.e. ones that are in the published playlist today.
// Usage: node scripts/preview-archive.mjs --section kept|year|bw|series [--since YEAR]
import path from 'node:path'
import fs from 'node:fs/promises'
import { ROOT, loadConfig } from './lib.mjs'
import { loadArchive } from './archive.mjs'

const arg = name => { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i + 1] }
const section = arg('--section') || 'kept'
const since = +(arg('--since') || 0)
const config = await loadConfig()
await fs.mkdir(path.join(ROOT, '.cache'), { recursive: true })
const r = await loadArchive({ ...config.archive, languages: config.archive.languages ?? config.filter?.languages },
  { cachePath: path.join(ROOT, '.cache', 'archive.json') })

const recent = x => !since || (x.year && x.year >= since)
const line = x => `${x.title}${x.year && !String(x.title).includes(String(x.year)) ? ` (${x.year})` : ''}${x.reason ? ` [${x.reason}]` : ''}`
const pick = {
  kept: () => [`Kept: ${r.channels.length} titles`, r.channels.map(c => c.name).sort()],
  year: () => { const l = r.removedItems.filter(x => x.reason === 'year' && recent(x)); return [`Removed, released before ${config.archive.minYear}: ${l.length}`, l.map(line).sort()] },
  bw: () => { const l = r.removedItems.filter(x => x.reason.startsWith('black') && recent(x)); return [`Removed as black-and-white: ${l.length}`, l.map(line).sort()] },
  series: () => { const l = r.removedItems.filter(x => /videos|repeated/.test(x.reason) && recent(x)); return [`Removed as series/repeated: ${l.length}`, l.map(line).sort()] }
}
const [title, lines] = pick[section]()
console.log(`## ${title}\n${lines.join('\n')}`)
// GitHub caps an annotation at ~4 KB, so long lists are split.
if (process.env.GITHUB_ACTIONS) {
  let chunk = [], size = 0, part = 1
  const flush = () => { console.log(`::notice title=${title} (part ${part++})::${chunk.join('%0A') || '(none)'}`); chunk = []; size = 0 }
  for (const l of lines.map(l => l.replace(/[\r\n%]/g, ' '))) { if (size + l.length + 3 > 3800) flush(); chunk.push(l); size += l.length + 3 }
  flush()
}
