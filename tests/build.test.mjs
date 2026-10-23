import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'

process.env.IPTV_ORG_API = path.join(import.meta.dirname, 'fixtures')
const { parseCsv, loadLocal, loadIptvOrg, merge, toM3u, checkStream } = await import('../scripts/lib.mjs')

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

test('local data overrides remote and duplicate URLs are dropped', async () => {
  const remote = await loadIptvOrg({ countries: [], categories: [], excludeNsfw: true })
  const { channels, streams } = merge(await loadLocal(), remote)
  assert.equal(channels.get('NASATV.us').name, 'NASA TV')
  const nasa = streams.filter(s => s.channel === 'NASATV.us')
  assert.equal(nasa.length, 1)
  assert.equal(nasa[0].source, 'local')
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
    if (req.url === '/slow.m3u8') return setTimeout(() => res.end('#EXTM3U'), 500)
    res.statusCode = 404; res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const check = p => checkStream({ url: base + p }, 200)
  assert.deepEqual(await check('/live.m3u8'), { ok: true })
  assert.deepEqual(await check('/gone.m3u8'), { ok: false, reason: 'HTTP 404' })
  assert.deepEqual(await check('/html.m3u8'), { ok: false, reason: 'not an HLS playlist' })
  assert.deepEqual(await check('/slow.m3u8'), { ok: false, reason: 'timeout' })
  server.closeAllConnections(); server.close()
})
