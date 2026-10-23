# Adding a new playlist

This guide covers adding an M3U playlist you find on GitHub (or anywhere else) to your playlist. Everything can be done in the GitHub website, including from your phone. It takes about 5 minutes plus build time.

**The short version:** find the playlist file → preview it → add one line to `config.json` → wait for the build → check the Sources table.

---

## Step 1: Find the playlist file in the repo

1. Open the repo on GitHub.
2. Look for a file ending in **`.m3u`** or **`.m3u8`**. Common places:
   - the root folder (`playlist.m3u8`, `index.m3u`, `channels.m3u`)
   - a `playlists/`, `lists/` or `streams/` folder
   - the README, which often links to "the playlist URL"
3. If the repo has several playlists (one per country, for example), pick the combined one if there is one. If not, add each file you want as its own source.
4. Click the file to open it.

**Tip:** if the README gives a link like `https://something.github.io/repo/index.m3u`, you can use that link directly. Skip to Step 3.

## Step 2: Check it's a playlist of free streams

Open the file and skim the channel names and `group-title` values.

**Good signs:**
- Public broadcasters, news channels, local channels, FAST services (Pluto, Samsung TV Plus, Plex, Roku, Tubi)
- The repo explains where each stream comes from, or links to the broadcaster's site

**Bad signs (skip these):**
- Mostly premium channels: Star Sports, Sony Ten, Sky Sports, HBO, beIN, Willow, Netflix "channels"
- URLs with long tokens or usernames and passwords in them, such as `.../get.php?username=...&password=...`
- A repo that's been taken down before, or one asking for donations to "keep the server running"

Besides the legal risk, these break within days and can get your GitHub repo taken down, which would take your whole playlist offline.

## Step 3: Copy the link

On the file's page, click **Raw** (top right of the file view) and copy the address bar URL. It looks like:

```
https://raw.githubusercontent.com/owner/repo/main/playlist.m3u8
```

You can also copy the normal page URL (`https://github.com/owner/repo/blob/main/playlist.m3u8`); the build converts it automatically.

## Step 4: Preview it (optional, recommended)

This shows what the playlist would add before you commit to it.

1. In **your** repo, open the **Actions** tab.
2. In the left list, click **preview source**.
3. Click **Run workflow** (right side), paste the URL, give it a short name, click the green **Run workflow** button.
4. Wait 1–3 minutes, then click the run and scroll to the summary.

You'll see:

| Row | Meaning |
|---|---|
| Entries | how big the playlist is |
| New channels | channels you don't already have. **If this is 0, the playlist is a copy of what you have; no need to add it.** |
| Stream links not already in your playlist | new backup links, even for channels you have |
| Sample check | of 40 random streams, how many responded (GitHub checks from the US, so geo-blocked ones may still work for you) |
| Top groups / Sample names | what's actually in it (check against Step 2) |

At the bottom is the exact line to paste in the next step.

## Step 5: Add it to `config.json`

1. In your repo, open **`config.json`** and click the **pencil** icon (Edit).
2. Find `"sources": [`. Add your entry **after the last `}` in the list**, with a comma before it:

   ```json
   "sources": [
     { "name": "Free-TV", "url": "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8", "epg": true },
     ...
     { "name": "Roku", "url": "https://i.mjh.nz/Roku/all.m3u8", "epg": "https://i.mjh.nz/Roku/all.xml.gz" },
     { "name": "My New Source", "url": "https://raw.githubusercontent.com/owner/repo/main/playlist.m3u8" }
   ]
   ```

   Comma rules: every entry except the last ends with `},`. The last ends with `}` and then `]`.
3. Optional extras inside the `{ }`:

   | Add | When |
   |---|---|
   | `"epg": true` | the playlist's first line has `x-tvg-url=` (its own TV guide) and you want it |
   | `"epg": "https://.../guide.xml.gz"` | the repo provides a separate guide file |
   | `"country": "IN"` | the playlist is all one country but doesn't say so |
   | `"skipGroups": ["Radio", "VOD Italy"]` | leave out some groups |
   | `"skipWebPages": true` | leave out YouTube/Twitch links your app can't play |

4. Scroll down, click **Commit changes**, then **Commit changes** again.

## Step 6: Wait for the build

Committing starts the **update** action automatically.

1. Open the **Actions** tab. You'll see an **update** run with a yellow dot.
2. It takes 15–40 minutes (it checks every stream).
3. Green check means it's published. Red X: click it to see which step failed (see Troubleshooting).

## Step 7: Check the result

1. Open `https://superbot15.github.io/my-iptv/`.
2. In the **Sources** table, your new source should show its channel and stream count. **"failed"** means the URL couldn't be downloaded; the rest of the playlist still published.
3. On your TV/iPhone app, refresh the playlist (TiviMate: Settings → Playlists → your playlist → Update; most apps also refresh on restart).

## Adding an Internet Archive collection

1. Browse https://archive.org/details/movies and open a collection (for example "Classic TV").
2. Its id is the last part of the URL: `archive.org/details/classic_tv` → `classic_tv`.
3. In `config.json` → `archive` → `collections`, add:
   ```json
   { "id": "classic_tv", "name": "Classic TV", "type": "tv" }
   ```
   Use `"type": "movie"` for one entry per film, `"tv"` for one entry per episode grouped by show. Add `"limit": 0` inside the `{ }` to import every item in that collection.
4. Commit. The Sources table shows it as **Archive: <name>** with the number of titles found; **0** usually means the id is misspelled (ids are case-sensitive).

## Removing or pausing a source

In `config.json`, either delete its `{ ... }` entry (mind the commas), or add `"enabled": false` to keep it listed but not import it.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| **validate** step fails with `config.json ... duplicate`/`must start with https://` | The message names the problem entry. Fix it in config.json. |
| **validate** step fails with `Unexpected token` / JSON error | A comma or quote is wrong in config.json. Usually a missing comma between `}` and `{`, or an extra comma before `]`. Paste the file into https://jsonlint.com to find it. |
| Sources table says **failed: HTTP 404** | The file moved or was deleted. Open the repo again and copy the new Raw link. |
| Source loads but adds 0 channels | It's a copy of something you already have (common — many repos copy iptv-org). Remove it. |
| Channels show up under **Undefined** | The playlist has no `group-title` your build recognizes. Add `"country": "XX"` to the source. |
| Lots of channels don't play | Check `offline.m3u` on your index page; those failed the check. If a source is mostly dead, remove it. |
| Build takes over an hour | Each source adds checking time. The limit is 2 hours; if you hit it, raise `"concurrency"` in `config.json` → `check` (e.g. 100). |

## Doing it on a computer instead (optional)

```sh
git pull
node scripts/preview-source.mjs "https://raw.githubusercontent.com/owner/repo/main/playlist.m3u8" "Name"
# edit config.json
npm run validate
git commit -am "Add Name source" && git push
```
