import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'

process.env.IPTV_ORG_API = path.join(import.meta.dirname, 'fixtures')
const { parseCsv, parseM3u, loadLocal, loadIptvOrg, loadM3uSource, merge, toM3u, checkStream } = await import('../scripts/lib.mjs')

test('parseCsv handles quotes, commas and CRLF', () => {
  const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n\r\n')
  assert.deepEqual(rows, [{ a: 'x, y', b: 'say "hi"' }])
})

test('iptv-org import filters by country, closed and nsfw', async () => {
  const r = await loadIptvOrg({ countries: ['in', 'US'], categories: [], excludeNsfw: true })
  assert.deepEqual(r.channels.map(c => c.id).sort(), ['NASATV.us', 'NDTV24x7.in'])
  assert.equal(r.channels.find(c => c.id === 'NDTV24x7.in').logo, 'https://example.com/ndtv.png')
  assert.equal(r.streams.length, 2)
})

test('unlinked streams are included only without filters', async () => {
  const all = await loadIptvOrg({ countries: [], categories: [], excludeNsfw: true, includeUnlinked: true })
  const orphan = all.channels.find(c => c.name === 'Orphan')
  assert.ok(orphan?.unlinked)
  assert.ok(all.streams.some(s => s.channel === orphan.id))
  assert.match(toM3u([{ channel: orphan, stream: { url: 'u' } }]), /tvg-id="" group-title="Undefined",Orphan/)
  const filtered = await loadIptvOrg({ countries: ['IN'], categories: [], excludeNsfw: true, includeUnlinked: true })
  assert.ok(!filtered.channels.some(c => c.unlinked))
})

test('local data overrides remote and duplicate URLs are dropped', async () => {
  const remote = await loadIptvOrg({ countries: [], categories: [], excludeNsfw: true })
  const { channels, streams } = merge(await loadLocal(), remote)
  assert.equal(channels.get('NASATV.us').name, 'NASA TV')
  const nasa = streams.filter(s => s.channel === 'NASATV.us')
  assert.equal(nasa.length, 1)
  assert.equal(nasa[0].source, 'local')
})

test('parseM3u reads names with commas and VLC options', () => {
  const [e] = parseM3u('#EXTM3U\n#EXTINF:-1 tvg-id="A.in" group-title="X",Name, with comma\n#EXTVLCOPT:http-user-agent=UA=1\nhttps://s/a\n')
  assert.deepEqual(e, { name: 'Name, with comma', attrs: { 'tvg-id': 'A.in', 'group-title': 'X' }, user_agent: 'UA=1', referrer: null, url: 'https://s/a' })
})

test('M3U sources map countries, categories and merge after iptv-org', async () => {
  const src = await loadM3uSource({ name: 'Test', url: 'tests/fixtures/source.m3u' })
  const byName = n => src.channels.find(c => c.name === n)
  assert.equal(byName('DD Saptagiri').country, 'IN')
  assert.equal(byName('Das Erste').country, 'DE')
  assert.ok(byName('Das Erste').unlinked)
  assert.deepEqual(byName('Some News').categories, ['news'])
  assert.equal(src.streams.find(s => s.channel === 'DDSaptagiri.in').quality, '720p')
  assert.equal(src.streams.find(s => s.channel === 'NDTV24x7.in').user_agent, 'Mozilla/5.0 (x=1)')

  const remote = await loadIptvOrg({ countries: [], categories: [], excludeNsfw: true })
  const { channels, streams } = merge(await loadLocal(), remote, src)
  assert.equal(channels.get('NDTV24x7.in').name, 'NDTV 24x7')
  assert.deepEqual(streams.filter(s => s.channel === 'NDTV24x7.in').map(s => s.source), ['iptv-org', 'Test'])
})

test('M3U sources skip web pages and keep catch-up, Kodi headers and EPG', async () => {
  const src = await loadM3uSource({ name: 'Test', url: 'tests/fixtures/source.m3u' })
  assert.ok(src.streams.some(s => s.url.includes('twitch.tv')))
  const skipping = await loadM3uSource({ name: 'Test', url: 'tests/fixtures/source.m3u', skipWebPages: true })
  assert.ok(!skipping.streams.some(s => s.url.includes('twitch.tv')))
  const rewind = src.streams.find(s => s.channel === 'Rewind.in')
  assert.equal(rewind.url, 'https://example.com/rewind.m3u8')
  assert.equal(rewind.user_agent, 'Kodi/20')
  assert.equal(rewind.referrer, 'https://r.example/')
  assert.deepEqual(rewind.catchup, { catchup: 'shift', 'catchup-days': '7' })
  assert.match(toM3u([{ channel: src.channels.find(c => c.id === 'Rewind.in'), stream: rewind }]), /catchup="shift" catchup-days="7",Rewind TV/)

  assert.deepEqual(src.epg, [])
  const withEpg = await loadM3uSource({ name: 'Test', url: 'tests/fixtures/source.m3u', epg: true })
  assert.deepEqual(withEpg.epg, ['https://epg.example/a.xml', 'https://epg.example/b.xml'])
})

test('toM3u writes EXTINF, headers and EPG url', () => {
  const m3u = toM3u([{
    channel: { id: 'A.in', name: 'A', categories: ['news'], logo: 'https://l/a.png' },
    stream: { url: 'https://s/a.m3u8', quality: '720p', user_agent: 'UA', referrer: 'https://r/' }
  }], { epgUrl: 'https://epg/guide.xml' })
  assert.equal(m3u, [
    '#EXTM3U x-tvg-url="https://epg/guide.xml"',
    '#EXTINF:-1 tvg-id="A.in" tvg-logo="https://l/a.png" group-title="News",A (720p)',
    '#EXTVLCOPT:http-referrer=https://r/',
    '#EXTVLCOPT:http-user-agent=UA',
    'https://s/a.m3u8',
    ''
  ].join('\n'))
})

test('checkStream detects live, dead and bogus playlists', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/live.m3u8') return res.end('#EXTM3U\n#EXT-X-VERSION:3\n')
    if (req.url === '/html.m3u8') return res.end('<html>blocked</html>')
    if (req.url === '/geo.m3u8') { res.statusCode = 403; return res.end() }
    if (req.url === '/slow.m3u8') return setTimeout(() => res.end('#EXTM3U'), 500)
    res.statusCode = 404; res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const check = p => checkStream({ url: base + p }, 200)
  assert.deepEqual(await check('/live.m3u8'), { ok: true })
  assert.deepEqual(await check('/gone.m3u8'), { ok: false, blocked: false, reason: 'HTTP 404' })
  assert.deepEqual(await check('/geo.m3u8'), { ok: false, blocked: true, reason: 'HTTP 403' })
  assert.deepEqual(await check('/html.m3u8'), { ok: false, reason: 'not an HLS playlist' })
  assert.deepEqual(await check('/slow.m3u8'), { ok: false, reason: 'timeout' })
  server.closeAllConnections(); server.close()
})

test('rawUrl turns github.com file links into raw links', async () => {
  const { rawUrl } = await import('../scripts/lib.mjs')
  assert.equal(rawUrl('https://github.com/Free-TV/IPTV/blob/master/playlist.m3u8'), 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8')
  assert.equal(rawUrl('https://i.mjh.nz/Plex/all.m3u8'), 'https://i.mjh.nz/Plex/all.m3u8')
})
