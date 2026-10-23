// Validates data/*.csv. Exits non-zero on errors so CI blocks bad pull requests.
import { loadLocal } from './lib.mjs'

const { channels, streams } = await loadLocal()
const errors = []
const ids = new Set()

channels.forEach((c, i) => {
  const at = `channels.csv line ${i + 2}`
  if (!/^[A-Za-z0-9]+(\.[a-z]{2})?$/.test(c.id)) errors.push(`${at}: id "${c.id}" should look like NameCountry.xx (e.g. NASATV.us)`)
  if (ids.has(c.id)) errors.push(`${at}: duplicate id "${c.id}"`)
  ids.add(c.id)
  if (!c.name) errors.push(`${at}: name is required`)
  if (!/^[A-Z]{2}$/.test(c.country)) errors.push(`${at}: country must be a 2-letter ISO code`)
  for (const u of [c.logo, c.website]) if (u && !/^https?:\/\//.test(u)) errors.push(`${at}: "${u}" is not a URL`)
})

const urls = new Set()
streams.forEach((s, i) => {
  const at = `streams.csv line ${i + 2}`
  if (!ids.has(s.channel)) errors.push(`${at}: unknown channel "${s.channel}" (add it to channels.csv)`)
  if (!/^(https?|rtmp|rtsp):\/\//.test(s.url)) errors.push(`${at}: invalid url "${s.url}"`)
  if (urls.has(s.url)) errors.push(`${at}: duplicate url`)
  urls.add(s.url)
  if (s.quality && !/^\d{3,4}[pi]$/.test(s.quality)) errors.push(`${at}: quality should look like 720p`)
})

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log(`OK: ${channels.length} channels, ${streams.length} streams`)
