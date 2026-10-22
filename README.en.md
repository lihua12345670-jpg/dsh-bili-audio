# dsh-bili-audio

A DSH plugin that treats Bilibili videos as podcasts: a floating player bar in the bottom-right corner of the DSH web UI. Paste a BV id or a link, press play. Queue, seek, volume, speed and prev/next are included; copy follows the UI language (Chinese/English).

> Ported from a self-made Python desktop-pet implementation (`bili_audio.py` / `bili_player.py`). v0.1 covers resolve + playback + queue only — no subtitles, login or downloads.

## Why a host-side proxy is required

Bilibili's audio CDNs (`*.bilivideo.com`, `*.mcdn.bilivideo.cn`, …) validate the `Referer` header. A browser pointed directly at an `.m4s` URL gets **403** because the page origin is localhost.

So all audio bytes flow through the host route `/bili-audio/api/stream`:

```
browser <audio>
   │  GET /bili-audio/api/stream?u=<encodeURIComponent(audioUrl)>   (+ Range)
   ▼
DSH host (Node)
   │  GET <audioUrl>
   │  User-Agent: desktop Chrome
   │  Referer: https://www.bilibili.com/
   ▼
Bilibili audio CDN  →  200 / 206 + audio bytes
```

The proxy forwards the browser's `Range` header and mirrors back `Content-Range`, `Accept-Ranges` and `Content-Length`, so seeking works via 206 partial responses.

## Install

Local directory (development):

```bash
dsh plugin --profile desktop add link:E:\工作区\dsh-bili-audio
```

From npm (once published):

```bash
dsh plugin --profile desktop add dsh-bili-audio
```

After installation a round "♪" button appears in the bottom-right corner; click it to open the player bar. The plugin also shows up under Settings → Plugins.

## Usage

1. Click the "♪" button to expand the bar.
2. Paste a Bilibili link (`https://www.bilibili.com/video/BV...`, `b23.tv` short link) or just a BV / av id.
3. Press **Resolve & play**.
4. Paste several space/newline-separated links to queue them; **Queue only** appends without interrupting the current track.
5. Click any queue row to switch, × to remove, and use **Sort by title** / **Clear** at the top of the queue.

When playback fails the client tries the backup CDN URLs, then re-resolves once (Bilibili audio URLs carry a `deadline`), and finally shows the concrete reason (CDN 403, no audio stream, …) on the queue row.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/bili-audio/api/health` | `{ok:true, version}` |
| GET | `/bili-audio/api/resolve?url=<BV/av/link>` | `{ok:true, title, bvid, cid, duration, page, pages, audioUrl, backups[], mimeType, codecs}` |
| GET | `/bili-audio/api/stream?u=<urlencoded audioUrl>` | Audio byte proxy; supports `Range` and 206 |

Errors always look like:

```json
{ "error": { "code": "no_audio_stream", "message": "…" } }
```

Common codes: `missing_url`, `invalid_url`, `host_not_allowed`, `no_video_id`, `video_not_found`, `no_audio_stream`, `playurl_failed`, `cdn_forbidden`, `cdn_gone`, `upstream_timeout`, `upstream_unreachable`, `short_link_foreign`.

## Security boundaries

The plugin exposes a route that makes requests on the browser's behalf, so the allow-lists are hard-coded:

- `resolve` accepts only `bilibili.com` / `b23.tv` / `bilibili.tv` page links (including subdomains);
- `stream` proxies only `*.bilivideo.com`, `*.akamaized.net`, `*.mcdn.bilivideo.cn`, `*.bilibili.com`;
- after following CDN redirects the final host is validated again, so a CDN cannot redirect the proxy elsewhere;
- URLs with embedded credentials, non-`http(s)` schemes and IP literals (`127.0.0.1`, `[::1]`) are rejected;
- only the browser's `Range` header is forwarded — no `Cookie` / `Authorization`;
- every outbound request has a 15 s timeout, and the upstream is aborted as soon as the client disconnects.

It is not a general-purpose proxy: any URL outside those allow-lists gets a 400.

## Known limitations (v0.1)

- **No subtitles**: the original Python version fetched CC/AI subtitles with a login cookie; v0.1 has no login and no subtitle fetching.
- **No favorites/history**: the queue lives in memory and is lost on reload; only expanded state / volume / speed are persisted.
- **Online only**: resolve and playback depend on Bilibili APIs and CDNs; no offline cache.
- Paid, region-locked or login-only videos may expose no audio stream; the UI then reports "no playable audio stream".
- Only video-page links / BV / av ids are supported; bangumi `ep`/`ss` links are not (yet).
- Autoplay after resolve may be blocked by the browser's autoplay policy; pressing play once is enough.

## Development

```bash
node --test tests/*.test.mjs   # unit tests (no network)
node scripts/smoke.mjs         # live smoke test: resolve a public video and proxy its first 200 KB
```

Layout:

```
lib/index.js        host half: resolve / stream / health routes + allow-lists
lib/client.js       client half: shell.overlay floating bar (hand-written bundle, no build step)
cordis.patch.yml    mount declaration
tests/*.test.mjs    node --test suites
scripts/smoke.mjs   live network smoke test
```

## License

MIT. Ported from the user's own desktop-pet project. Audio copyright belongs to Bilibili and the respective uploaders; this plugin only plays audio locally — it does not download, re-host or redistribute content.
