# xmd

Turn X (Twitter) posts into clean Markdown, via the public FxTwitter API. No X login, no API keys. The CLI has one runtime dependency, `@cloudflare/puppeteer` (used by the Worker's browser engine), so a global install pulls about 33 MB on disk (measured with `bun add -g`, bun 1.4.2).

## Hosted endpoint

Live at [https://xmd.imfrank.dev](https://xmd.imfrank.dev). `GET /` is a landing page. Usage: `https://xmd.imfrank.dev/?url=<link>` (scheme optional, e.g. `?url=example.com`); health check: `https://xmd.imfrank.dev/health`. Share image: `/og.png`. Chrome extension installer: `/extension.sh`.

## HTTP API

- `GET /?url=<any http(s) URL>` — web page or X post
- `GET /md?url=<post url or id>&mode=<mode>`
- `GET /md/{mode}?url=...`
- `GET /health`

URL-encode the `url` query value, or pass it with curl `-G --data-urlencode`.

```sh
curl -G 'https://xmd.imfrank.dev/md' \
  --data-urlencode 'url=https://x.com/jack/status/2110421175528775685' \
  --data-urlencode 'mode=post'

curl -G 'https://xmd.imfrank.dev/md/ancestors' \
  --data-urlencode 'url=2110642522355638381'

curl -G 'https://xmd.imfrank.dev/md/thread' \
  --data-urlencode 'url=1585341984679469056'

curl -G 'https://xmd.imfrank.dev/md/replies' \
  --data-urlencode 'url=https://x.com/jack/status/2110642522355638381'

curl 'https://xmd.imfrank.dev/health'

curl -G 'https://xmd.imfrank.dev/' --data-urlencode 'url=https://example.com'
```

### Modes

- **post** (default) renders one post.
- **ancestors** walks parents and renders root first, up to 32 parent hops. A missing parent produces a short note.
- **thread** finds the root and renders only connected self-replies by that root's author, sorted by timestamp. Other people's replies are excluded. A foreign-author input is identified in the output. No summarization.
- **replies** renders the linked post first, then connected descendant replies by any author in chronological order. Ancestors, siblings, and replies with missing intermediate parents are excluded. Bodies contain numbered author headings, text, media, and one-level quotes; permalinks and metrics are collected under `## References` at the end. It makes one conversation request (plus a status fallback if needed), never paginates, and notes when more replies may exist or none were returned.

### Status codes

| Code | Meaning |
|------|---------|
| 200 | Markdown (or `ok` for `/health`) |
| 400 | Bad URL, mode, or blocked target |
| 404 | Unknown path or unavailable post |
| 405 | Method not allowed (only GET) |
| 415 | Unsupported content type (any-link) |
| 429 | Rate limit exceeded |
| 502 | Upstream / network error |
| 503 | Browser rendering daily quota exhausted (`Retry-After: 3600`) or busy (`Retry-After: 60`) |
| 504 | Render exceeded the 45 s deadline |

### Caching

The hosted Worker caches successful responses for 5 minutes per mode + post id via the Cache API, per Cloudflare location. Different URL spellings of the same post share one entry. Header `x-xmd-cache: HIT` or `MISS`. Cached HIT responses keep the original `x-xmd-engine` value. Only HTTP 200s are cached.

The local Node server uses an in-memory cache: 5 minutes, 200 entries. Concurrent renders of the same mode/id share one request.

### Rate limit

Two layers: a per-isolate in-memory fixed window (30 uncached requests / 60 s per IP, deterministic within one isolate) plus the Workers Rate Limiting binding (same threshold per Cloudflare location, approximate). Both are on the free plan. Over the limit: `429` with `Retry-After: 60`. Cache hits are not counted. Any-link cache misses use the same two layers.

### Any link

`GET /?url=<any url>` fetches a public http(s) page and returns Markdown (`text/markdown; charset=utf-8`). If the URL is an X/Twitter post, it is handled exactly like `/md?url=...&mode=` (optional `mode`, default `post`). `GET /` with no `url` returns a short usage list.

On the hosted Worker, HTML is converted by Cloudflare Workers AI Markdown Conversion (`env.AI.toMarkdown`, free for HTML). JS-only or empty pages are rendered with Cloudflare Browser Rendering (free plan: 10 browser-minutes per day, 3 concurrent). Daily quota exhausted: `503` with `Retry-After: 3600` and `x-xmd-browser-error: quota`. Too many new or concurrent browsers: `503` with `Retry-After: 60` and `x-xmd-browser-error: busy`. The built-in HTML-to-Markdown converter is the last-resort fallback, and is what the CLI and local Node server use.

Every `/?url=` and `/md` response includes `x-xmd-engine`:

- `x` — X/Twitter post
- `ai` — Workers AI Markdown Conversion
- `browser` — Browser Rendering (then AI or the built-in converter)
- `fallback` — built-in converter, including `text/plain` and `text/markdown` passthrough

SSRF protections: only http/https; no userinfo; ports 80/443 only; loopback, private, link-local, metadata, and special-use addresses are refused (including decimal/hex/octal IPv4 and IPv4-mapped IPv6); hostnames such as `localhost`, `*.internal`, `*.ts.net`, and `*.workers.dev` are refused; DNS-over-HTTPS is checked so a name that resolves to a blocked address is refused. At most 5 redirects, each hop re-validated. Body cap 2 MB. Allowed types: HTML, XHTML, plain text, Markdown; anything else is `415`.

```sh
curl -G 'https://xmd.imfrank.dev/' --data-urlencode 'url=https://example.com'
# same as: https://xmd.imfrank.dev/?url=https%3A%2F%2Fexample.com
```

## CLI

bun is the package manager. The `xmd`/`x-md` commands run on Bun (the bin uses a `bun` shebang), so only bun is needed for the CLI. Node >= 26 is needed only for the local server (`node src/server.js`) and the test suite.

```sh
bun add -g github:franklinjavier/xmd
# or: git clone https://github.com/franklinjavier/xmd && cd xmd && bun install && bun link

xmd https://x.com/jack/status/2110421175528775685
xmd --mode ancestors 2110642522355638381
xmd 1585341984679469056 --mode=thread
xmd --mode replies https://x.com/jack/status/2110642522355638381
xmd https://example.com
```

Usage: `xmd <x-post-url|id|any-url> [--mode post|thread|ancestors|replies]`. `x-md` is kept as an alias.

Exit codes: 2 usage/URL/blocked target, 3 unavailable post, 4 upstream/network, 5 unsupported content type.

## Chrome extension

The `extension/` folder is a Manifest V3 Chrome extension. Clicking the toolbar icon copies an `https://xmd.imfrank.dev/?url=...` link for the current tab (the link, not Markdown).

Permissions:

- `activeTab` — read the current tab URL only when you click the icon
- `clipboardWrite` — put the link on the clipboard

No `scripting` or host permissions: the popup runs after the click and already has the tab URL. Not on the Chrome Web Store.

Install:

```sh
curl -fsSL https://xmd.imfrank.dev/extension.sh | sh
```

That downloads only the extension to `~/xmd-extension` (no git or bun needed). Then open `chrome://extensions` → enable Developer mode → Load unpacked → `~/xmd-extension`. To update, run the same command and click reload on the extension card.

Folder alternative: clone the repo and load unpacked the `extension/` folder.

The link points at `xmd.imfrank.dev`. To self-host, change `XMD_BASE` at the top of `extension/popup.js`.

## Local server

```sh
XMD_HOST=127.0.0.1 XMD_PORT=8792 node src/server.js
```

The host must be an explicit IP (wildcards refused) so you bind it to a private interface such as a VPN address on purpose.

## Self-host on Cloudflare

```sh
bun install
bunx wrangler deploy
```

The Worker needs the `ai` and `browser` bindings and `nodejs_compat`, all declared in `wrangler.jsonc`. `@cloudflare/puppeteer` is the only runtime dependency (used by the Worker browser engine; a global install pulls it). It serves `/favicon.ico`, `/favicon.png`, `/apple-touch-icon.png`, `/icon-512.png`, `/og.png`, and `/extension.sh`. The free plan is enough. `wrangler.jsonc` also declares a Rate Limiting binding named `RATE_LIMITER` (`namespace_id` must be unique in your account). The in-isolate memory limiter always applies; without the binding only that layer is used.

## Config

`XMD_API_BASE` overrides `https://api.fxtwitter.com`. Every upstream request sends `User-Agent: xmd/0.3 (+https://github.com/franklinjavier/xmd)` and has a 15-second timeout. Redirects are refused, JSON bodies are capped at 2 MB, and post IDs must contain 1–25 digits.

## Limits

Public API availability and visibility determine completeness; deleted or protected posts cannot be recovered. Conversation cursors are not paginated. Quotes render one level, media render as links, and missing fields are tolerated.

Credits: [FxTwitter](https://github.com/FixTweet/FxTwitter).

## Testing

```sh
bun run test
XMD_SKIP_LIVE=1 bun run test   # skip the live FxTwitter check
```

## License

MIT. Copyright (c) 2026 Franklin Javier.
