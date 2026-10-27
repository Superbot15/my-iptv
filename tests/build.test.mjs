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

test('Internet Archive import picks one MP4 per video and builds VOD entries', async () => {
  const { loadArchive, pickVideos } = await import('../scripts/archive.mjs')
  assert.deepEqual(pickVideos([
    { name: 'film.avi', source: 'original', format: 'AVI' },
    { name: 'film_512kb.mp4', source: 'derivative', format: '512Kb MPEG4', original: 'film.avi' },
    { name: 'film.mp4', source: 'derivative', format: 'h.264', original: 'film.avi' },
    { name: 'film.ogv', source: 'derivative', format: 'Ogg Video', original: 'film.avi' }
  ]).map(f => f.name), ['film.mp4'])

  const meta = {
    noir1: { files: [{ name: 'Detour.mp4', source: 'original', format: 'MPEG4' }] },
    show1: { files: [
      { name: 'ep10.mp4', source: 'original', format: 'h.264', title: 'Episode 10' },
      { name: 'ep2.mp4', source: 'original', format: 'h.264', title: 'Episode 2' }] },
    empty: { files: [{ name: 'x.pdf', source: 'original' }] }
  }
  const docs = { Film_Noir: [{ identifier: 'noir1', title: 'Detour', year: '1945' }, { identifier: 'empty', title: 'Nothing' }],
    classic_tv: [{ identifier: 'show1', title: 'Dragnet' }] }
  const calls = []
  const get = async url => {
    calls.push(url)
    if (url.includes('/metadata/')) return meta[url.split('/').pop()]
    const col = Object.keys(docs).find(c => url.includes(`collection%3A(${c})`))
    if (!col) throw new Error('HTTP 404')
    return { response: { docs: docs[col] } }
  }
  const opts = { limit: 10, collections: [
    { id: 'Film_Noir', name: 'Film Noir', type: 'movie' },
    { id: 'classic_tv', name: 'Classic TV', type: 'tv' },
    { id: 'missing', name: 'Missing', type: 'movie' }] }
  const r = await loadArchive(opts, { get })

  assert.deepEqual(r.channels.map(c => [c.name, c.group]), [
    ['Detour (1945)', 'Movies: Film Noir'],
    ['Dragnet - Episode 2', 'TV: Dragnet'],
    ['Dragnet - Episode 10', 'TV: Dragnet']])
  assert.equal(r.streams[0].url, 'https://archive.org/download/noir1/Detour.mp4')
  assert.ok(r.streams.every(s => s.skipCheck))
  assert.equal(r.report.find(x => x.name === 'Archive: Missing').error, 'HTTP 404')
  assert.match(toM3u([{ channel: r.channels[0], stream: r.streams[0] }]), /tvg-logo="https:\/\/archive.org\/services\/img\/noir1" group-title="Movies: Film Noir",Detour \(1945\)/)

  // Cached items aren't fetched again.
  const os = await import('node:os'), fsp = await import('node:fs/promises')
  const cachePath = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'iptv-')), 'archive.json')
  await loadArchive(opts, { get, cachePath })
  calls.length = 0
  await loadArchive(opts, { get, cachePath })
  assert.ok(!calls.some(u => u.includes('/metadata/')))
})

test('Internet Archive limit 0 pages through every item with the scrape API', async () => {
  const { loadArchive } = await import('../scripts/archive.mjs')
  const urls = []
  const get = async url => {
    urls.push(url)
    if (url.includes('/metadata/')) return { files: [{ name: 'v.mp4', source: 'original' }] }
    assert.ok(url.includes('/services/search/v1/scrape'))
    return url.includes('cursor=abc')
      ? { items: [{ identifier: 'b', title: 'B' }] }
      : { items: [{ identifier: 'a', title: 'A' }], cursor: 'abc' }
  }
  const r = await loadArchive({ limit: 0, collections: [{ id: 'feature_films', name: 'Feature Films', type: 'movie' }] }, { get })
  assert.deepEqual(r.channels.map(c => c.name), ['A', 'B'])
  assert.ok(!urls.some(u => u.includes('advancedsearch')))

  const late = await loadArchive({ limit: 0, maxMinutes: -1, collections: [{ id: 'f', name: 'F', type: 'movie' }] }, { get })
  assert.equal(late.channels.length, 0)
  assert.equal(late.deferred, 2)
})

test('black-and-white filter uses the colour tag first, then the year', async () => {
  const { blackAndWhite, loadArchive } = await import('../scripts/archive.mjs')
  assert.equal(blackAndWhite({ color: 'B&W', year: '1975' }, 1955), 'tag')
  assert.equal(blackAndWhite({ color: 'black and white' }, 1955), 'tag')
  assert.equal(blackAndWhite({ color: ['Color'], year: '1939' }, 1955), null)
  assert.equal(blackAndWhite({ color: 'colour', year: '1950' }, 1955), null)
  assert.equal(blackAndWhite({ year: '1948-05-01' }, 1955), 'year')
  assert.equal(blackAndWhite({ year: '1962' }, 1955), null)
  assert.equal(blackAndWhite({}, 1955), null)
  assert.equal(blackAndWhite({ year: '1948' }, undefined), null)

  const docs = [
    { identifier: 'old', title: 'Old', year: '1940' },
    { identifier: 'oldColor', title: 'Old Color', year: '1940', color: 'Color' },
    { identifier: 'tagged', title: 'Tagged', year: '1970', color: 'b&w' },
    { identifier: 'tv60', title: 'Sixties Show', year: '1962' },
    { identifier: 'tv70', title: 'Seventies Show', year: '1972' }
  ]
  const lookedUp = []
  const get = async url => {
    if (url.includes('/metadata/')) { lookedUp.push(url.split('/').pop()); return { files: [{ name: 'v.mp4', source: 'original' }] } }
    return { items: docs }
  }
  const opts = { limit: 0, excludeBlackAndWhite: { moviesBefore: 1955, tvBefore: 1966 }, collections: [
    { id: 'm', name: 'Films', type: 'movie' }, { id: 't', name: 'Shows', type: 'tv' }] }
  const r = await loadArchive(opts, { get })
  assert.deepEqual(r.channels.filter(c => c.vod === 'movie').map(c => c.name), ['Old Color (1940)', 'Sixties Show (1962)', 'Seventies Show (1972)'])
  assert.deepEqual(r.channels.filter(c => c.vod === 'tv').map(c => c.name), ['Old Color (1940)', 'Seventies Show (1972)'])
  assert.deepEqual(r.report.map(x => [x.removedBlackAndWhite, x.removedByTag, x.removedByYear]), [[2, 1, 1], [3, 1, 2]])
  assert.ok(!lookedUp.includes('old') && !lookedUp.includes('tagged'))
})

test('minYear leaves out older and undated archive titles', async () => {
  const { loadArchive } = await import('../scripts/archive.mjs')
  const docs = [
    { identifier: 'a', title: 'Old', year: '1994' },
    { identifier: 'b', title: 'New', year: '1995-06-01' },
    { identifier: 'c', title: 'Undated' }
  ]
  const get = async url => url.includes('/metadata/') ? { files: [{ name: 'v.mp4', source: 'original' }] } : { items: docs }
  const r = await loadArchive({ limit: 0, minYear: 1995, collections: [{ id: 'x', name: 'X', type: 'movie' }] }, { get })
  assert.deepEqual(r.channels.map(c => c.name), ['New (1995)'])
  assert.equal(r.report[0].removedOld, 2)
  const keep = await loadArchive({ limit: 0, minYear: 1995, keepUndated: true, collections: [{ id: 'x', name: 'X', type: 'movie' }] }, { get })
  assert.deepEqual(keep.channels.map(c => c.name), ['New (1995)', 'Undated'])
})
