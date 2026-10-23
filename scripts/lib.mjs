import fs from 'node:fs/promises'
import path from 'node:path'

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const IPTV_ORG_API = process.env.IPTV_ORG_API || 'https://iptv-org.github.io/api'

// Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF).
export function parseCsv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  const [header, ...body] = rows.filter(r => r.some(v => v.trim() !== ''))
  if (!header) return []
  return body.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])))
}

const list = s => (s ? s.split(';').map(v => v.trim()).filter(Boolean) : [])

export async function loadConfig() {
  return JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'))
}

export async function loadLocal() {
  const read = f => fs.readFile(path.join(ROOT, 'data', f), 'utf8').then(parseCsv)
  const channels = (await read('channels.csv')).map(c => ({
    id: c.id,
    name: c.name,
    country: c.country.toUpperCase(),
    categories: list(c.categories),
    languages: list(c.languages),
    logo: c.logo || null,
    website: c.website || null,
    source: 'local'
  }))
  const streams = (await read('streams.csv')).map(s => ({
    channel: s.channel,
    url: s.url,
    quality: s.quality || null,
    user_agent: s.user_agent || null,
    referrer: s.referrer || null,
    source: 'local'
  }))
  return { channels, streams }
}

async function getJson(name) {
  // IPTV_ORG_API may be a local directory (used by tests) or a URL.
  if (!/^https?:/.test(IPTV_ORG_API)) {
    return JSON.parse(await fs.readFile(path.join(IPTV_ORG_API, name), 'utf8'))
  }
  const res = await fetch(`${IPTV_ORG_API}/${name}`)
  if (!res.ok) throw new Error(`GET ${name}: HTTP ${res.status}`)
  return res.json()
}

export async function loadIptvOrg(opts) {
  const [channels, streams, logos] = await Promise.all([
    getJson('channels.json'),
    getJson('streams.json'),
    getJson('logos.json').catch(() => [])
  ])
  const logoFor = new Map()
  for (const l of logos) {
    // Prefer the channel-level logo over feed-specific ones.
    if (!logoFor.has(l.channel) || !l.feed) logoFor.set(l.channel, l.url)
  }
  const countries = new Set(opts.countries.map(c => c.toUpperCase()))
  const categories = new Set(opts.categories)
  const picked = new Map()
  for (const c of channels) {
    if (c.closed && !opts.includeClosed) continue
    if (opts.excludeNsfw && c.is_nsfw) continue
    if (countries.size && !countries.has(c.country)) continue
    if (categories.size && !(c.categories || []).some(x => categories.has(x))) continue
    picked.set(c.id, {
      id: c.id,
      name: c.name,
      country: c.country,
      categories: c.categories || [],
      languages: c.languages || [],
      logo: c.logo || logoFor.get(c.id) || null,
      website: c.website || null,
      source: 'iptv-org'
    })
  }
  // Streams iptv-org hasn't linked to a channel have no country or category, so
  // they are only included when nothing is being filtered on.
  if (opts.includeUnlinked && !countries.size && !categories.size) {
    for (const s of streams) {
      if (s.channel || !s.title) continue
      s.channel = `~${s.title}`
      if (!picked.has(s.channel)) {
        picked.set(s.channel, { id: s.channel, name: s.title, country: '', categories: [], languages: [], logo: null, website: null, unlinked: true, source: 'iptv-org' })
      }
    }
  }
  const pickedStreams = streams
    .filter(s => s.channel && picked.has(s.channel))
    .map(s => ({
      channel: s.channel,
      url: s.url,
      quality: s.quality || null,
      user_agent: s.user_agent || s.http_user_agent || null,
      referrer: s.referrer || s.http_referrer || null,
      source: 'iptv-org'
    }))
  return { channels: [...picked.values()], streams: pickedStreams }
}

const parseAttrs = s => Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]))

// Parses an extended M3U playlist into { name, attrs, url, user_agent, referrer } entries.
// The playlist's own #EXTM3U attributes (e.g. its EPG url) are on entries.header.
export function parseM3u(text) {
  const entries = []
  entries.header = {}
  let cur = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXTM3U')) {
      entries.header = parseAttrs(line)
    } else if (line.startsWith('#EXTINF')) {
      // The title starts at the first comma outside quoted attribute values.
      let comma = -1, quoted = false
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') quoted = !quoted
        else if (line[i] === ',' && !quoted) { comma = i; break }
      }
      const head = comma === -1 ? line : line.slice(0, comma)
      cur = { name: comma === -1 ? '' : line.slice(comma + 1).trim(), attrs: parseAttrs(head), user_agent: null, referrer: null }
    } else if (cur && line.startsWith('#EXTVLCOPT:')) {
      const [k, ...v] = line.slice(11).split('=')
      if (k === 'http-user-agent') cur.user_agent = v.join('=')
      if (k === 'http-referrer') cur.referrer = v.join('=')
    } else if (cur && line && !line.startsWith('#')) {
      // Kodi-style headers: url|User-Agent=...&Referer=...
      const [url, opts] = line.split('|')
      for (const [k, v] of new URLSearchParams(opts || '')) {
        if (/^user-agent$/i.test(k)) cur.user_agent = v
        if (/^refer+er$/i.test(k)) cur.referrer = v
      }
      entries.push({ ...cur, url })
      cur = null
    }
  }
  return entries
}

// Links to web pages rather than streams; most TV players can't open these. Skipped only with "skipWebPages": true.
const WEB_PAGE = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be|twitch\.tv|dailymotion\.com|facebook\.com)\//i
const CATCHUP_ATTRS = ['catchup', 'catchup-source', 'catchup-days', 'timeshift']

const CATEGORIES = new Set(['animation', 'auto', 'business', 'classic', 'comedy', 'cooking', 'culture', 'documentary', 'education', 'entertainment', 'family', 'general', 'kids', 'legislative', 'lifestyle', 'movies', 'music', 'news', 'outdoor', 'relax', 'religious', 'science', 'series', 'shop', 'sports', 'travel', 'weather'])

// "india" -> "IN", built from the runtime's ICU region names.
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })
const COUNTRY_BY_NAME = new Map()
for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
  const code = String.fromCharCode(a, b)
  try { const n = regionNames.of(code); if (n && n !== code) COUNTRY_BY_NAME.set(n.toLowerCase(), code) } catch {}
}
for (const [alias, code] of [['usa', 'US'], ['uk', 'GB'], ['united states', 'US'], ['united kingdom', 'GB'], ['korea', 'KR'], ['south korea', 'KR'],
  ['russia', 'RU'], ['czech republic', 'CZ'], ['turkey', 'TR'], ['trinidad', 'TT'], ['bosnia', 'BA'], ['macedonia', 'MK'], ['vatican', 'VA']]) COUNTRY_BY_NAME.set(alias, code)
const CATEGORY_ALIASES = { documentaries: 'documentary', film: 'movies', movie: 'movies', sport: 'sports', children: 'kids', 'kids & family': 'kids', religion: 'religious', shopping: 'shop' }

// Playlists label groups like "VOD Italy", "日本 / Japan" or "Music (EN)"; reduce them to "italy", "japan", "music".
const groupKeys = g => {
  const base = g.toLowerCase().replace(/^vod\s+/, '').replace(/\s*\([^)]*\)\s*$/, '').trim()
  return [base, ...base.split('/').map(p => p.trim())]
}
const countryFromGroup = g => groupKeys(g).map(k => COUNTRY_BY_NAME.get(k)).find(Boolean)
const categoryFromGroup = g => groupKeys(g).map(k => CATEGORY_ALIASES[k] || k).find(k => CATEGORIES.has(k))

// Loads another M3U playlist (URL or local path) listed under "sources" in config.json.
// github.com/owner/repo/blob/branch/file -> raw.githubusercontent.com/owner/repo/branch/file
export const rawUrl = url => url.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\//, 'https://raw.githubusercontent.com/$1/$2/')

export async function loadM3uSource(src) {
  const text = /^https?:/.test(src.url)
    ? await fetch(rawUrl(src.url)).then(r => { if (!r.ok) throw new Error(`${src.name}: HTTP ${r.status}`); return r.text() })
    : await fs.readFile(path.resolve(ROOT, src.url), 'utf8')
  const channels = new Map()
  const streams = []
  const entries = parseM3u(text)
  for (const e of entries) {
    const name = e.attrs['tvg-name'] || e.name.replace(/\s*\((\d{3,4}[pi])\)\s*$/, '')
    if (!name || (src.skipWebPages && WEB_PAGE.test(e.url)) || (src.skipGroups || []).includes(e.attrs['group-title'])) continue
    const tvgId = e.attrs['tvg-id']
    const id = tvgId || `~${name}`
    const group = (e.attrs['group-title'] || '').toLowerCase()
    if (!channels.has(id)) {
      channels.set(id, {
        id,
        name,
        // iptv-org style ids end in a country code (e.g. ZeeNews.in).
        country: (tvgId?.match(/\.([a-z]{2})(@|$)/)?.[1]?.replace(/^uk$/, 'gb') || countryFromGroup(group) || src.country || '').toUpperCase(),
        categories: [categoryFromGroup(group)].filter(Boolean),
        languages: [],
        logo: e.attrs['tvg-logo'] || null,
        website: null,
        unlinked: !tvgId,
        source: src.name
      })
    }
    streams.push({
      channel: id,
      url: e.url,
      quality: e.name.match(/\((\d{3,4}[pi])\)/)?.[1] || null,
      user_agent: e.user_agent,
      referrer: e.referrer,
      catchup: Object.fromEntries(CATCHUP_ATTRS.filter(a => e.attrs[a]).map(a => [a, e.attrs[a]])),
      source: src.name
    })
  }
  // "epg": "<url>" sets the guide; "epg": true reuses the guide the playlist itself declares.
  const h = entries.header
  const epg = (src.epg === true ? [h['x-tvg-url'], h['url-tvg']] : [src.epg])
    .filter(v => typeof v === 'string').flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean)
  return { channels: [...channels.values()], streams, epg }
}

// Local entries win: they override channel metadata and are listed first.
// Among remotes, the first one to define a channel keeps its metadata.
export function merge(local, ...remotes) {
  const channels = new Map()
  for (const r of remotes) for (const c of r.channels) if (!channels.has(c.id)) channels.set(c.id, c)
  for (const c of local.channels) channels.set(c.id, c)
  const seen = new Set()
  const streams = []
  for (const s of [...local.streams, ...remotes.flatMap(r => r.streams)]) {
    if (!channels.has(s.channel) || seen.has(s.url)) continue
    seen.add(s.url)
    streams.push(s)
  }
  return { channels, streams }
}

const attr = v => String(v).replace(/"/g, "'")

// epgUrl may be a comma-separated list; TiviMate, OTT Navigator and Kodi accept that.
export function toM3u(entries, { epgUrl } = {}) {
  const lines = [epgUrl ? `#EXTM3U x-tvg-url="${attr(epgUrl)}"` : '#EXTM3U']
  for (const { channel: c, stream: s } of entries) {
    const group = c.group || (c.categories[0] ? c.categories[0][0].toUpperCase() + c.categories[0].slice(1) : 'Undefined')
    const title = s.quality ? `${c.name} (${s.quality})` : c.name
    const attrs = [`tvg-id="${c.unlinked ? '' : attr(c.id)}"`]
    if (c.logo) attrs.push(`tvg-logo="${attr(c.logo)}"`)
    attrs.push(`group-title="${attr(group)}"`)
    for (const [k, v] of Object.entries(s.catchup || {})) attrs.push(`${k}="${attr(v)}"`)
    lines.push(`#EXTINF:-1 ${attrs.join(' ')},${title}`)
    if (s.referrer) lines.push(`#EXTVLCOPT:http-referrer=${s.referrer}`)
    if (s.user_agent) lines.push(`#EXTVLCOPT:http-user-agent=${s.user_agent}`)
    lines.push(s.url)
  }
  return lines.join('\n') + '\n'
}

export async function checkStream(s, timeoutMs) {
  const headers = {}
  if (s.user_agent) headers['User-Agent'] = s.user_agent
  if (s.referrer) headers['Referer'] = s.referrer
  try {
    const res = await fetch(s.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
    // 401/403/451 usually mean geo-blocked from the checker's location, not dead.
    if (!res.ok) return { ok: false, blocked: [401, 403, 451].includes(res.status), reason: `HTTP ${res.status}` }
    if (/\.m3u8?(\?|$)/i.test(s.url)) {
      const body = (await res.text()).slice(0, 200)
      if (!body.trimStart().startsWith('#EXTM3U')) return { ok: false, reason: 'not an HLS playlist' }
    } else {
      res.body?.cancel()
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code || e.message) }
  }
}

export async function pool(items, size, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }))
  return out
}
