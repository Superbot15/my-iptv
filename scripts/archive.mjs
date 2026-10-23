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

// Most-downloaded items first; limit 0 = every item in the collection.
async function search(collection, limit, get) {
  const rows = limit > 0 ? Math.min(limit, 10000) : 10000
  const docs = []
  for (let page = 1; ; page++) {
    const q = encodeURIComponent(`collection:(${collection}) AND mediatype:(movies)`)
    const r = await get(`${API}/advancedsearch.php?q=${q}&fl[]=identifier&fl[]=title&fl[]=year&sort[]=downloads+desc&rows=${rows}&page=${page}&output=json`)
    docs.push(...r.response.docs)
    if (r.response.docs.length < rows || (limit > 0 && docs.length >= limit)) break
  }
  return limit > 0 ? docs.slice(0, limit) : docs
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
  for (const col of opts.collections) {
    let docs
    try {
      docs = await search(col.id, col.limit ?? opts.limit ?? 1000, get)
    } catch (e) {
      report.push({ name: `Archive: ${col.name}`, channels: 0, streams: 0, error: e.message })
      continue
    }
    const items = await pool(docs, opts.concurrency || 20, async d => {
      if (!cache[d.identifier]) {
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
    report.push({ name: `Archive: ${col.name}`, channels: items.filter(it => it?.videos.length).length, streams: added })
  }
  if (cachePath) await fs.writeFile(cachePath, JSON.stringify(cache))
  return { channels, streams, report }
}
