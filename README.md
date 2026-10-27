# My IPTV

A personal IPTV playlist, modeled on [iptv-org/iptv](https://github.com/iptv-org/iptv). It combines:

- **Your own database**: `data/channels.csv` and `data/streams.csv`, edited by hand.
- **iptv-org's public database**: channels from the countries and categories you choose in `config.json`, pulled from [iptv-org/database](https://github.com/iptv-org/database) through its [API](https://github.com/iptv-org/api).

Every day a GitHub Action rebuilds the playlist, drops streams that are offline, and publishes it to GitHub Pages. Your TV loads one URL:

```
https://<your-github-username>.github.io/my-iptv/index.m3u
```

> Only add streams that broadcasters make freely and publicly available. Like iptv-org, this repo stores links only and hosts no video.

---

## 1. Put it on GitHub (one-time)

1. Create an empty repo named `my-iptv` at https://github.com/new.
2. Push this folder:
   ```sh
   git remote add origin https://github.com/<you>/my-iptv.git
   git push -u origin main
   ```
3. On GitHub, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
4. Open the **Actions** tab, select **update**, then **Run workflow**. After about 2 minutes your playlist is at the URL above. `https://<you>.github.io/my-iptv/` shows every per-country and per-category playlist.

## 2. Watch it on your TV

| TV / device | App | How to add the playlist |
|---|---|---|
| **Android TV / Google TV / Fire TV / Nvidia Shield** | **TiviMate** (best), IPTV Smarters, OTT Navigator | Add playlist → *M3U playlist* → enter the URL |
| Android TV (free and simple) | **VLC** | Browse → Streams → New stream → paste the URL |
| **Samsung (Tizen)** / **LG (webOS)** | IPTV Smarters Pro, Smart IPTV, SS IPTV, Flix IPTV (availability varies by region) | Most of these apps ask you to enter the URL on their website, keyed to your TV's MAC address |
| **Apple TV** | iPlayTV, VLC, IPTVX | Add M3U URL |
| **Kodi** (any device) | *PVR IPTV Simple Client* add-on | Settings → General → Location: *Remote path* → M3U URL |
| Any TV with HDMI | Plug in a Fire TV Stick / Chromecast with Google TV | Use TiviMate as above |

Tips:
- To avoid typing a long URL with the remote, shorten it (for example with bit.ly), or use a phone app such as *Send Files to TV*.
- Set the app to refresh the playlist every 24 hours so it picks up the daily rebuild.
- Each channel's `group-title` is its category, so apps group channels into News, Movies, Kids, and so on.

## 3. Choose your channels

Edit **`config.json`**:

```jsonc
{
  "title": "My IPTV",
  "epgUrl": "",                  // optional XMLTV guide URL (see "TV guide" below)
  "import": {
    "enabled": true,             // false = use only your own CSV files
    "countries": [],             // ISO codes, e.g. ["IN", "US"]; [] = every country
    "categories": [],            // e.g. ["news", "kids", "movies"]; [] = all
    "excludeNsfw": false,        // true = leave out adult channels
    "includeClosed": true,       // also list channels iptv-org marks as shut down
    "includeUnlinked": true      // also add iptv-org streams with no channel entry (only when unfiltered)
  },
  "sources": [ ... ],            // other M3U playlists to merge in, see below
  "check": {
    "timeoutMs": 10000, "concurrency": 60,
    "dropDead": false,           // true = remove streams that fail the check from index.m3u
    "keepBlocked": true          // treat 401/403 as passing: GitHub checks from the US, so geo-blocked != dead
  }
}
```

Valid category ids are the ones iptv-org uses: `animation, auto, business, classic, comedy, cooking, culture, documentary, education, entertainment, family, general, kids, legislative, lifestyle, movies, music, news, outdoor, relax, religious, science, series, shop, sports, travel, weather`.

### Live TV filter

`"filter"` in `config.json` limits live channels (from every source) to chosen countries and languages:

```json
"filter": {
  "countries": ["US", "GB", "CA", "AU", "NZ", "IE", "IN"],
  "languages": ["eng", "hin", "tam", "tel", "mal", "kan", "ben", "mar", "guj", "pan", "..."]
}
```

A channel is left out only when its recorded country, or every recorded language, is outside these lists; channels with no country or language recorded stay. Languages are ISO 639 codes (English plus the 22 official languages of India here) and come from iptv-org's database, so channels from other playlists get them when they use iptv-org ids. The same language list filters the Internet Archive movies. Delete `"filter"` to include every country and language.

## 4. Add your own channels

`data/channels.csv`. Separate multiple values with `;`.

```csv
id,name,country,categories,languages,logo,website
NASATV.us,NASA TV,US,science;documentary,eng,https://.../logo.png,https://www.nasa.gov/nasatv/
```

`data/streams.csv`. A channel can have several streams; `user_agent` and `referrer` are only needed when a server demands them.

```csv
channel,url,quality,user_agent,referrer
NASATV.us,https://ntv1.akamaized.net/hls/live/2014075/NASA-NTV1-HLS/master.m3u8,720p,,
```

Rules:
- Use the same `id` as iptv-org when the channel exists there (search https://iptv-org.github.io). Your row then overrides their name and logo, and your stream is listed first.
- `npm run validate` checks your files. CI runs it on every pull request.

## 5. Pull in channels from other repos

Any public M3U playlist can be merged in. The build downloads every source each day, removes duplicate links, and maps each channel to iptv-org's channel ID where it can (so logos, categories and the TV guide line up). If a source can't be downloaded, the build carries on without it and shows it as failed on the index page.

**Full step-by-step guide: [docs/ADDING_SOURCES.md](docs/ADDING_SOURCES.md).** You can also preview any playlist first: **Actions → preview source → Run workflow**.

**The short version:**

1. Find the playlist file in the repo (usually `something.m3u` or `.m3u8`) and open it.
2. Click **Raw** and copy that URL (`https://raw.githubusercontent.com/...`).
3. Add an entry to `sources` in `config.json` (on GitHub: open the file, click the pencil, commit):
   ```json
   { "name": "Some Repo", "url": "https://raw.githubusercontent.com/owner/repo/main/playlist.m3u" }
   ```
4. The update action runs on every commit. A few minutes later, check the **Sources** table on your index page to see how many channels it added.

Per-source options:

| Option | Effect |
|---|---|
| `"epg": "<url>"` | add this XMLTV guide to the playlist header |
| `"epg": true` | use the guide URLs the source playlist itself declares |
| `"country": "IN"` | country for entries that don't say |
| `"skipGroups": ["VOD Italy"]` | leave out these `group-title` groups |
| `"skipWebPages": true` | leave out YouTube/Twitch/etc. page links (most TV apps can't open them) |
| `"enabled": false` | keep the entry but don't import it |

Where to find more: the **Providers → IPTV** discussions linked from [awesome-iptv](https://github.com/iptv-org/awesome-iptv), and GitHub search for `extension:m3u` or `topic:iptv-playlist`. Stick to playlists of free, official streams; playlists of paid channels are usually unlicensed, and their links tend to die within days anyway.

## On-demand movies and TV shows (Internet Archive)

The build also imports public-domain films and classic TV from the [Internet Archive](https://archive.org): plain video files, so you can pick a title and pause, rewind and skip in any player, IPTV Smarters included. They're in `index.m3u` under groups like **Movies: Film Noir** and **TV: Dragnet**, and on their own in `movies.m3u` and `tv.m3u`.

In `config.json` under `archive`:

| Setting | Effect |
|---|---|
| `"limit": 0` | `0` = every item in each collection (the default here); a number = that many most-watched titles per collection (Feature Films alone is tens of thousands; large playlists load slowly in some apps) |
| `"collections"` | which collections to import. Add any collection from archive.org/details/movies: its id is the last part of its URL, and `"type"` is `"movie"` (one entry per film) or `"tv"` (one entry per episode, grouped by show) |
| `"excludeBlackAndWhite"` | leaves out black-and-white titles: anything the archive tags as B&W, and untagged films before `moviesBefore` (1955) and shows before `tvBefore` (1966). Titles tagged colour are kept whatever their year. Delete the setting to include everything |
| `"dropSeries": true` | leaves out TV shows filed as movies: items holding several videos, and titles that repeat once episode/part numbers are removed (all copies; this also catches sequels and multi-part films) |
| `"minYear": 2008` | leaves out titles released before that year (2008 here; a year written in the title wins over the archive's year, which is often the upload date), and titles with no year (add `"keepUndated": true` to keep those). Delete it to include older titles |
| `"enabled": false` | turn it off |

To see which titles a change would remove before applying it, put the change on a branch named `preview/<anything>` and push it: the **preview archive** action lists them and publishes nothing.

File lists are cached between builds, so only new titles are looked up each day. Each build spends at most `"maxMinutes"` (default 90) looking up titles; with `"limit": 0` the first full import is spread over a few daily builds, and the Sources table grows as it goes. Archive files skip the stream check.

## Rewind and recording

Most free live streams keep only a few seconds of buffer, so there's nothing to rewind. Options:

- **Sources with catch-up:** if a source playlist has `catchup`, `catchup-source` or `catchup-days` tags, the build keeps them, and TiviMate, OTT Navigator and Kodi then show a rewind/archive option on those channels.
- **Pause and rewind on the device:** Kodi with *PVR IPTV Simple Client*: in the add-on settings, set the stream to open with *inputstream.ffmpegdirect* in *timeshift* mode. Kodi then buffers to disk while you watch, so you can pause and rewind.
- **Recording:** TiviMate Premium can record to a USB drive. [Jellyfin](https://jellyfin.org) (free) or Channels DVR can use this playlist as a tuner and record on a schedule.
- **iPhone:** a few streams have a rewind window built in. VLC and Safari show a seek bar on those; on the rest, live is live.

## 6. Run it locally (optional)

Requires Node 20 or newer. There are no dependencies to install.

```sh
npm run validate       # check the CSV files
npm test               # unit tests
npm run build          # writes public/ (fast, no stream checks)
npm run build:check    # also tests every stream and removes dead ones
npm run build -- --no-import   # only your own CSV channels
```

To test on your TV before publishing, serve the folder on your Wi-Fi with `npx serve public`, then open `http://<your-computer-ip>:3000/index.m3u` in VLC on the TV.

## TV guide (EPG)

Every channel's `tvg-id` is its iptv-org id, which matches the guides that [iptv-org/epg](https://github.com/iptv-org/epg) generates. To get a guide, either:
- Fork iptv-org/epg and run its grab action for your country's sites, then set `epgUrl` to the resulting `guide.xml` URL, or
- Paste a third-party XMLTV URL into your TV app's EPG setting.

## Output

| File | Contents |
|---|---|
| `index.m3u` | every stream from every source |
| `online.m3u` | only streams that passed the latest check |
| `offline.m3u` | streams that failed the latest check (some may still play from your location) |
| `report.json` | per-source counts and check results |
| `countries/<code>.m3u` | e.g. `countries/in.m3u` |
| `categories/<id>.m3u` | e.g. `categories/news.m3u` |
| `channels.json` | machine-readable list |
| `index.html` | page with links to all of the above |

## Project layout

```
config.json            what to import and how to check streams
data/channels.csv      your channel database
data/streams.csv       your stream links
scripts/lib.mjs        CSV parsing, iptv-org import, merge, M3U writer, stream checker
scripts/build.mjs      generates public/
scripts/validate.mjs   database linter
.github/workflows/     daily build + Pages deploy; PR checks
tests/                 node:test tests with iptv-org-shaped fixtures
```

## Credits

Channel and stream data from [iptv-org](https://github.com/iptv-org), released into the public domain. For more players and resources, see [awesome-iptv](https://github.com/iptv-org/awesome-iptv).
