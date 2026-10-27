// Imports on-demand movies and TV episodes from Internet Archive collections.
// Each video file becomes a VOD entry; files are seekable, so players can pause and rewind.
import fs from 'node:fs/promises'
import { pool } from './lib.mjs'

const API = 'https://archive.org'

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

// limit > 0: that many most-downloaded items. limit 0: every item, via the scrape API,
// because advancedsearch stops paging at 10,000 results.
async function search(collection, limit, get) {
  const q = encodeURIComponent(`collection:(${collection}) AND mediatype:(movies)`)
  if (limit > 0) {
    const docs = []
    const rows = Math.min(limit, 10000)
    for (let page = 1; docs.length < limit; page++) {
      const r = await get(`${API}/advancedsearch.php?q=${q}&fl[]=identifier&fl[]=title&fl[]=year&fl[]=color&sort[]=downloads+desc&rows=${rows}&page=${page}&output=json`)
      docs.push(...r.response.docs)
      if (r.response.docs.length < rows) break
    }
    return docs.slice(0, limit)
  }
  const docs = []
  let cursor = ''
  do {
    const r = await get(`${API}/services/search/v1/scrape?q=${q}&fields=identifier,title,year,color&count=10000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    docs.push(...r.items)
    cursor = r.cursor
  } while (cursor)
  return docs
}

// Why an item counts as black-and-white ('tag' or 'year'), or null to keep it.
// The archive's "color" field wins; untagged items before the cutoff year are assumed black-and-white.
export function blackAndWhite(doc, beforeYear) {
  const tag = [].concat(doc.color ?? []).join(' ').toLowerCase()
  if (/\bcolou?r\b/.test(tag) && !/b\s*&\s*w|black|mono/.test(tag)) return null
  if (/b\s*&\s*w|\bbw\b|black|mono|grayscale|greyscale/.test(tag)) return 'tag'
  const year = parseInt(String(doc.year ?? '').slice(0, 4), 10)
  return beforeYear && year && year < beforeYear ? 'year' : null
}

// One playable file per video: the original if it's an MP4, else its MP4 derivative (h.264 over 512Kb).
export function pickVideos(files) {
  const rank = f => (f.source === 'original' ? 0 : /^h\.264/i.test(f.format) ? 1 : 2)
  const groups = new Map()
  for (const f of files) {
    if (!/\.mp4$/i.test(f.name)) continue
    const key = f.source === 'original' ? f.name : (f.original || f.name)
    const best = groups.get(key)
    if (!best || rank(f) < rank(best)) groups.set(key, f)
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

export async function loadArchive(opts, { get = fetchJson, cachePath } = {}) {
  let cache = {}
  if (cachePath) cache = await fs.readFile(cachePath, 'utf8').then(JSON.parse).catch(() => ({}))
  const channels = []
  const streams = []
  const report = []
  // Looking up every item can take hours on the first run. Stop new lookups at the deadline;
  // the cache is kept, so the next build continues where this one stopped.
  const deadline = Date.now() + (opts.maxMinutes ?? 90) * 60000
  let deferred = 0
  for (const col of opts.collections) {
    let docs
    try {
      docs = await search(col.id, col.limit ?? opts.limit ?? 1000, get)
    } catch (e) {
      report.push({ name: `Archive: ${col.name}`, channels: 0, streams: 0, error: e.message })
      continue
    }
    const bw = opts.excludeBlackAndWhite
    const cutoff = col.type === 'tv' ? bw?.tvBefore : bw?.moviesBefore
    const removed = { tag: 0, year: 0, old: 0 }
    if (bw) {
      docs = docs.filter(d => {
        const why = blackAndWhite(d, cutoff)
        if (why) removed[why]++
        return !why
      })
    }
    // "minYear": leave out titles released before it. Items with no year are kept.
    if (opts.minYear) {
      docs = docs.filter(d => {
        const year = parseInt(String(d.year ?? '').slice(0, 4), 10)
        const old = year && year < opts.minYear
        if (old) removed.old++
        return !old
      })
    }
    const items = await pool(docs, opts.concurrency || 20, async d => {
      if (!cache[d.identifier]) {
        if (Date.now() > deadline) { deferred++; return null }
        try {
          const m = await get(`${API}/metadata/${encodeURIComponent(d.identifier)}`)
          cache[d.identifier] = pickVideos(m.files || []).map(f => ({ name: f.name, title: f.title || null }))
        } catch {
          return null // retried on the next build
        }
      }
      return { doc: d, videos: cache[d.identifier] }
    })
    let added = 0
    for (const it of items) {
      if (!it?.videos.length) continue
      const { doc: d, videos } = it
      const title = String(d.title || d.identifier).trim()
      const year = d.year ? ` (${String(d.year).slice(0, 4)})` : ''
      const isTv = col.type === 'tv'
      videos.forEach((v, i) => {
        const id = `~archive:${d.identifier}:${i}`
        const part = videos.length === 1 ? '' : ` - ${v.title || v.name.replace(/\.mp4$/i, '').replace(/[_.]+/g, ' ')}`
        channels.push({
          id,
          name: `${title}${part}${videos.length === 1 ? year : ''}`,
          country: '',
          categories: [isTv ? 'series' : 'movies'],
          languages: [],
          logo: `${API}/services/img/${d.identifier}`,
          website: `${API}/details/${d.identifier}`,
          group: isTv ? `TV: ${title}` : `Movies: ${col.name}`,
          vod: isTv ? 'tv' : 'movie',
          unlinked: true,
          source: 'archive'
        })
        streams.push({
          channel: id,
          url: `${API}/download/${d.identifier}/${v.name.split('/').map(encodeURIComponent).join('/')}`,
          quality: null, user_agent: null, referrer: null,
          skipCheck: true,
          source: 'archive'
        })
        added++
      })
    }
    report.push({ name: `Archive: ${col.name}`, channels: items.filter(it => it?.videos.length).length, streams: added,
      ...(bw && { removedBlackAndWhite: removed.tag + removed.year, removedByTag: removed.tag, removedByYear: removed.year }),
      ...(opts.minYear && { removedOld: removed.old }) })
  }
  if (cachePath) await fs.writeFile(cachePath, JSON.stringify(cache))
  if (deferred) console.log(`Archive: ${deferred} items not looked up yet; the next build continues`)
  return { channels, streams, report, deferred }
}
