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
    "excludeNsfw": true,
    "includeUnlinked": true      // also add iptv-org streams with no channel entry (only when unfiltered)
  },
  "check": {
    "timeoutMs": 10000, "concurrency": 60,
    "dropDead": true,            // remove streams that fail the check
    "keepBlocked": true          // keep 401/403 streams: GitHub checks from the US, so geo-blocked != dead
  }
}
```

Valid category ids are the ones iptv-org uses: `animation, auto, business, classic, comedy, cooking, culture, documentary, education, entertainment, family, general, kids, legislative, lifestyle, movies, music, news, outdoor, relax, religious, science, series, shop, sports, travel, weather`.

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

## 5. Run it locally (optional)

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
| `index.m3u` | every working stream |
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
