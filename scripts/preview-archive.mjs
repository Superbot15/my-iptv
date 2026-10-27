// Lists the Internet Archive titles the current config.json would remove, without publishing anything.
// Usage: node scripts/preview-archive.mjs [--since YEAR]   (--since: only list year removals from YEAR on)
import path from 'node:path'
import fs from 'node:fs/promises'
import { ROOT, loadConfig } from './lib.mjs'
import { loadArchive } from './archive.mjs'

const args = process.argv.slice(2)
const since = +(args[args.indexOf('--since') + 1] || 0)
const config = await loadConfig()
await fs.mkdir(path.join(ROOT, '.cache'), { recursive: true })
const r = await loadArchive({ ...config.archive, languages: config.archive.languages ?? config.filter?.languages },
  { cachePath: path.join(ROOT, '.cache', 'archive.json') })

const year = r.removedItems.filter(x => x.reason === 'year' && x.year >= since)
const series = r.removedItems.filter(x => x.reason !== 'year')
const line = x => `${x.title}${x.year ? ` (${String(x.year).slice(0, 4)})` : ''} [${x.collection}${x.reason === 'year' ? '' : `, ${x.reason}`}]`
const sections = [
  [`Kept after all rules: ${r.report.reduce((n, x) => n + x.channels, 0)} titles`, r.channels.map(c => c.name).sort()],
  [`Removed by minYear ${config.archive.minYear}${since ? ` (released ${since} or later)` : ''}: ${year.length}`, year.map(line).sort()],
  [`Removed as series/repeated titles: ${series.length}`, series.sort((a, b) => (a.base || '').localeCompare(b.base || '')).map(line)]
]
for (const [title, lines] of sections) {
  console.log(`\n## ${title}\n${lines.join('\n')}`)
  // Annotations are capped in size, so long lists are split across several.
  if (process.env.GITHUB_ACTIONS) {
    let chunk = [], size = 0, part = 1
    const flush = () => { console.log(`::notice title=${title} (part ${part++})::${chunk.join('%0A') || '(none)'}`); chunk = []; size = 0 }
    for (const l of lines) { if (size + l.length > 30000) flush(); chunk.push(l.replace(/[\r\n%]/g, ' ')); size += l.length + 3 }
    flush()
  }
}
