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
      const r = await get(`${API}/advancedsearch.php?q=${q}&fl[]=identifier&fl[]=title&fl[]=year&fl[]=color&fl[]=language&sort[]=downloads+desc&rows=${rows}&page=${page}&output=json`)
      docs.push(...r.response.docs)
      if (r.response.docs.length < rows) break
    }
    return docs.slice(0, limit)
  }
  const docs = []
  let cursor = ''
  do {
    const r = await get(`${API}/services/search/v1/scrape?q=${q}&fields=identifier,title,year,color,language&count=10000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    docs.push(...r.items)
    cursor = r.cursor
  } while (cursor)
  return docs
}

// 2-letter codes and spellings the archive uses for the languages in ENGLISH_AND_INDIAN.
const LANGUAGE_ALIASES = { en: 'eng', hi: 'hin', ta: 'tam', te: 'tel', ml: 'mal', kn: 'kan', bn: 'ben', bangla: 'ben',
  mr: 'mar', gu: 'guj', pa: 'pan', or: 'ori', oriya: 'ori', odia: 'ori', as: 'asm', ur: 'urd', ne: 'nep', sa: 'san', sd: 'snd', ks: 'kas' }
const NO_LANGUAGE = /^(zxx|und|mul|none|n\/a|unknown|no linguistic content|no language|silent|music)$/i
const languageNames = new Intl.DisplayNames(['en'], { type: 'language' })

// Whether an item's recorded language is outside the allowed ISO 639 codes. Items with no language are kept.
export function otherLanguage(value, allowed) {
  const parts = [].concat(value ?? []).flatMap(v => String(v).split(/[,;/&|]|\band\b/i)).map(p => p.trim().toLowerCase()).filter(Boolean)
  const real = parts.filter(p => !NO_LANGUAGE.test(p))
  if (!real.length) return false
  const names = allowed.map(code => [code, (languageNames.of(code) || '').toLowerCase()])
  const ok = p => allowed.includes(p) || allowed.includes(LANGUAGE_ALIASES[p]) ||
    names.some(([, n]) => n && new RegExp(`\\b${n}\\b`).test(p))
  return !real.some(ok)
}

// Release year: a year written in the title ("D.O.A. (1950)", "Snake 1978") wins over the archive's
// year field, which is often the upload date.
export function releaseYear(doc, now = new Date()) {
  const max = now.getFullYear() + 1
  const years = [...String(doc.title || '').matchAll(/(?<!\d)(19\d\d|20\d\d)(?!\d)/g)].map(m => +m[1]).filter(y => y >= 1890 && y <= max)
  if (years.length) return Math.min(...years)
  const y = parseInt(String(doc.year ?? '').slice(0, 4), 10)
  return Number.isFinite(y) ? y : null
}

// A title with episode/part/season markers, years and numbering removed, for spotting series.
// "Dragnet Episode 12", "Dragnet - Ep. 3" and "Dragnet S01E02" all become "dragnet".
export function baseTitle(title) {
  return String(title || '').toLowerCase()
    .replace(/\((?:19|20)\d\d\)|\[(?:19|20)\d\d\]/g, ' ')
    .replace(/\b(s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{1,3}|season\s*\d+|series\s*\d+|episode\s*\d+|ep\.?\s*\d+|part\s*(\d+|[ivx]+|one|two|three)|pt\.?\s*\d+|chapter\s*\d+|vol(ume)?\.?\s*\d+|no\.?\s*\d+|#\s*\d+)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/(\s\d{1,3})+\s*$/, '')
    .trim()
}

// Why an item counts as black-and-white ('tag' or 'year'), or null to keep it.
// The archive's "color" field wins; untagged items before the cutoff year are assumed black-and-white.
export function blackAndWhite(doc, beforeYear) {
  const tag = [].concat(doc.color ?? []).join(' ').toLowerCase()
  if (/\bcolou?r\b/.test(tag) && !/b\s*&\s*w|black|mono/.test(tag)) return null
  if (/b\s*&\s*w|\bbw\b|black|mono|grayscale|greyscale/.test(tag)) return 'tag'
  const year = releaseYear(doc)
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
  const collected = []
  const removedItems = []
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
    const removed = { tag: 0, year: 0, old: 0, language: 0, series: 0 }
    if (bw) {
      docs = docs.filter(d => {
        const why = blackAndWhite(d, cutoff)
        if (why) removed[why]++
        return !why
      })
    }
    if (opts.languages?.length) {
      docs = docs.filter(d => {
        const other = otherLanguage(d.language, opts.languages)
        if (other) removed.language++
        return !other
      })
    }
    // "minYear": leave out titles released before it, and titles with no year unless "keepUndated".
    if (opts.minYear) {
      docs = docs.filter(d => {
        const year = releaseYear(d)
        const old = year ? year < opts.minYear : !opts.keepUndated
        if (old) { removed.old++; if (year) removedItems.push({ collection: col.name, title: d.title, year, reason: 'year' }) }
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
    collected.push({ col, items: items.filter(it => it?.videos.length), removed, bw })
  }

  // "dropSeries": TV shows filed as movies. Items holding several videos, and titles that repeat
  // once episode/part markers are stripped, are all left out.
  if (opts.dropSeries) {
    const count = new Map()
    for (const { items } of collected) for (const it of items) {
      const key = baseTitle(it.doc.title)
      if (key) count.set(key, (count.get(key) || 0) + 1)
    }
    for (const c of collected) {
      c.items = c.items.filter(it => {
        const series = it.videos.length > 1 || count.get(baseTitle(it.doc.title)) > 1
        if (series) {
          c.removed.series++
          removedItems.push({ collection: c.col.name, title: it.doc.title, year: releaseYear(it.doc), reason: it.videos.length > 1 ? `${it.videos.length} videos` : 'repeated title', base: baseTitle(it.doc.title) })
        }
        return !series
      })
    }
  }

  for (const { col, items, removed, bw } of collected) {
    let added = 0
    for (const { doc: d, videos } of items) {
      const title = String(d.title || d.identifier).trim()
      const ry = releaseYear(d)
      const year = ry && !String(d.title || '').includes(String(ry)) ? ` (${ry})` : ''
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
    report.push({ name: `Archive: ${col.name}`, channels: items.length, streams: added,
      ...(bw && { removedBlackAndWhite: removed.tag + removed.year, removedByTag: removed.tag, removedByYear: removed.year }),
      ...(opts.minYear && { removedOld: removed.old }),
      ...(opts.languages?.length && { removedLanguage: removed.language }),
      ...(opts.dropSeries && { removedSeries: removed.series }) })
  }
  if (cachePath) await fs.writeFile(cachePath, JSON.stringify(cache))
  if (deferred) console.log(`Archive: ${deferred} items not looked up yet; the next build continues`)
  return { channels, streams, report, deferred, removedItems }
}
