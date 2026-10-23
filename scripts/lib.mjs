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
    if (c.closed) continue
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

// Local entries win: they override channel metadata and are listed first.
export function merge(local, remote) {
  const channels = new Map(remote.channels.map(c => [c.id, c]))
  for (const c of local.channels) channels.set(c.id, c)
  const seen = new Set()
  const streams = []
  for (const s of [...local.streams, ...remote.streams]) {
    if (!channels.has(s.channel) || seen.has(s.url)) continue
    seen.add(s.url)
    streams.push(s)
  }
  return { channels, streams }
}

const attr = v => String(v).replace(/"/g, "'")

export function toM3u(entries, { epgUrl } = {}) {
  const lines = [epgUrl ? `#EXTM3U x-tvg-url="${attr(epgUrl)}"` : '#EXTM3U']
  for (const { channel: c, stream: s } of entries) {
    const group = c.categories[0] ? c.categories[0][0].toUpperCase() + c.categories[0].slice(1) : 'Undefined'
    const title = s.quality ? `${c.name} (${s.quality})` : c.name
    const attrs = [`tvg-id="${attr(c.id)}"`]
    if (c.logo) attrs.push(`tvg-logo="${attr(c.logo)}"`)
    attrs.push(`group-title="${attr(group)}"`)
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
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
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
