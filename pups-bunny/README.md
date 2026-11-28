# pups-bunny

A [Personal Upload Server](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md) (RFC-6) for Bunny.net: one standalone **Edge Script** and one **Bunny Storage** zone, nothing else. Sibling of [pups-cloudflare](../pups-cloudflare), with the same protocol, owner pages and configuration.

**Status: not yet run on Bunny.** The tests run against a fake of the Bunny Storage HTTP API. Several platform details are undocumented and must be checked on the first deployment; see [Open questions](#open-questions).

> **Experimental:** PUPS is at an experimental stage. Expect backward-incompatible changes to the protocol, the configuration and the stored data between versions.

## How it works

```
tim.example.com ──► Pull zone (custom hostname, TLS)
                     ▼
                    Standalone Edge Script (dist/index.js)
                     └── Bunny Storage HTTP API: uploaded files, .well-known/host-meta.json,
                         your inbox, and the server's own state under _pups/
```

- **No database.** The OAuth state is kept as small JSON files under `_pups/` in the storage zone: owner credentials, grants with token hashes and refresh state, authorization codes, used nonces, sessions. `_pups/` can never be written by an app or served.
- **Tokens are `<grant id>.<random>`**, stored only as SHA-256 hashes in their grant's file. A request reads one file to authenticate.
- **ETags are content hashes.** Bunny Storage has no ETags, so the ETag of a file is the SHA-256 of its content (`"<base64url>"`). The server reads the file to compute it, both when serving it and when checking `If-Match` / `If-None-Match` before a write. Uploads carry the same hash in Bunny's `Checksum` header.
- **WebAuthn challenges are signed values**, made single-use by a nonce file.
- **The stylesheet and script** of the owner pages are bundled into the script, and so is webpup, the homepage.
- **The receiver** ([pups-inbox](../lib/pups-inbox), shared with Cloudflare) puts mentions and comments into your inbox; see [Inbox](#inbox).
- **Kept feeds** ([pups-feeds](../lib/pups-feeds), shared with Cloudflare): the script writes the archives of your feeds; see [Feeds](#feeds).

### Consistency

Bunny Storage has no transactions or conditional writes. Every check-and-set (single-use codes, refresh rotation, `If-Match`) is a read followed by a write, so two requests in the same instant can both pass. For a server with one owner this was judged acceptable:

| Race | Effect |
| --- | --- |
| A code redeemed twice in parallel | Two grants. PKCE already makes a stolen code useless without the app's verifier. |
| Two refreshes with the same token in parallel | Both succeed and reuse goes undetected. RFC-6 requires apps to refresh one at a time. |
| Two conditional writes to the same file in parallel | Both succeed, the last one wins. |
| The owner revokes an app while it refreshes | The refresh can rewrite the grant file the revocation just deleted. Revoke again. |
| host-meta.json edited in parallel | The file is reread just before the write, which narrows but doesn't close the window. |
| Two apps post to the same kept feed in the same instant, on different instances | Both read the same archive; the second write drops the first post from it, and both posts can get the same index. Within one instance, posts take their turn. |
| The receiver writes the inbox while a reader dismisses an item | The same: the inbox is reread just before the write. One of the two changes can get lost; a lost mention comes back with the next webmention. |
| The same webmention checked by two instances | Both put the same item; the second write replaces the first. |
| Two instances make the first signing key for identity tokens in the same instant | Both write a key and then use the stored one, so the last written wins; a token that one signed before the other wrote doesn't verify. Within one instance, parallel first uses wait for the same key. |

Requests that don't race behave exactly like the Cloudflare version.

The **write rate limit** is counted per script instance, and the **storage quota** counter and the **log of identity tokens** (with its rate limit) are updated with a read-modify-write, so all three are approximate.

### Fresh reads

A `GET` or `HEAD` at `storage_base` with `Authorization: Bearer <token>` is a fresh read (RFC-6). Any valid token of the server is accepted, whatever its scopes, and its use is recorded as for a write. An invalid, expired or revoked one gets `401`; other schemes, such as `Basic`, are ignored. The script reads the file from the storage API, as for every read, and answers with `Cache-Control: private, no-store` instead of `no-cache`. Public responses carry `Vary: Authorization`.

On Bunny, a fresh read is fresh only because files are never cached at the edge:

- The pull zone runs a standalone script only on a cache miss, and it **ignores `Vary`** (the cache key is set under *Vary Cache*). It doesn't store responses to requests with `Authorization`, but it reportedly serves them a response that is already cached ([HTTP Toolkit, 2023](https://httptoolkit.com/blog/bunny-cdn-caching-vulnerability/)). Files are sent with `no-cache`, so nothing should be cached (open question 7). Don't cache files at the edge, e.g. with an *Override Cache Time* edge rule or `s-maxage` for media: fresh reads would get the cached copy, unless the script runs before the cache.
- The script reads from the API host of the zone's primary region, where uploads land. Replication regions only serve CDN delivery, which PUPS doesn't use. Whether that host returns a file right after it was written is undocumented (open question 4).

### Private areas

Two areas hold files that only the owner's apps can read (RFC-6 "Private areas"):

- **`/appdata/<client-host>/private/`**, the app's own private data. The app's scope `write:/appdata/<client-host>/` covers it; nothing needs to be configured.
- **`/pups/private/`**, for private files that an extension of RFC-6 defines, e.g. an inbox. Paths there are declared in `WELL_KNOWN_PATHS` with `path` only (and optionally `description`, the consent screen's wording), never `url`, `rels`, `properties`, `link_properties`, `url_properties` or `single_rels`, e.g. `{"path": "/pups/private/inbox/", "description": "your inbox"}`. Apps request them with `read:<path>` or `write:<path>`, which need step-up and appear as "Read non-public content" or "Manage non-public content" on the consent screen. None are declared by default.

A private file is served, at `storage_base` or any other URL that maps to it, only with a bearer token whose `write:` or `read:` scope covers it: no token gets `401` with `WWW-Authenticate: Bearer`, an invalid one `401`, a token without a covering scope `403`, and only then a missing file `404`. Every response for a private path carries `Cache-Control: no-store` (`private, no-store` for a `200`) and `Vary: Authorization`, and never falls back to `ORIGIN_URL`. A `read:` scope never allows writing. Private files can't be linked in `host-meta.json` or used as URL property values (`403`). They are hidden, not encrypted: whoever can open the storage zone can read them.

Because the pull zone ignores `Vary` (see [Fresh reads](#fresh-reads)), add an edge rule that keeps it from caching the private areas: see [Connect your domain](INSTALL.md#5-connect-your-domain) in INSTALL.md.

## Deploy

Step by step, for owners: [INSTALL.md](INSTALL.md). In short:

1. **Storage zone.** Create one under *Storage*. Note its name, its primary region's API host (e.g. `storage.bunnycdn.com` for Falkenstein, `ny.storage.bunnycdn.com` for New York) and its *password* under *FTP & API Access*. Don't connect it to a pull zone: the server's state would become readable. Replication regions are optional, because the script always reads from the primary region.
2. **Build** the script: `npm install && npm run build`, with [pups-ui](../lib/pups-ui) (the owner pages, shared with pups-cloudflare) in `../lib/`, as in the repository. This writes `dist/index.js`, a single file.
3. **Edge Script.** Create a *standalone* script under *Edge Scripting*, and paste or upload `dist/index.js`. The GitHub Action `BunnyWay/actions/deploy-script` can automate this. Then set, under *Env Configuration*:
   - the variables `OWNER_HOST`, `STORAGE_ZONE` and `STORAGE_HOST`;
   - the secrets `STORAGE_ACCESS_KEY` (the storage zone password) and `BOOTSTRAP_SECRET` (at least 16 characters, used once at setup).
4. **Pull zone.** The script's pull zone is created with it.
   - Add your domain as a custom hostname, activate the free certificate, and enable *Force SSL*.
   - Set cache expiration to *respect the origin's Cache-Control*: files are sent with `no-cache` (`private, no-store` for [fresh reads](#fresh-reads)), pages with `no-store`. Don't override it for files.
   - Add an edge rule that never caches the [private areas](#private-areas): action *Override Cache Time* with `0`, condition *Request URL* matching any of `*/pups/private/*` and `*/appdata/*/private/*` (this covers them at `/files/` and at the domain root).
   - For host-meta.json discovery, the domain itself, not just a subdomain, must point to the pull zone. An apex domain needs Bunny DNS or a provider with CNAME flattening.
5. Open `https://<your domain>/pups/setup`, enter the bootstrap secret, and register a passkey or choose a password.

## Configuration

The same variables as the Cloudflare version, set as Edge Script environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OWNER_HOST` | host of the request | The owner's domain (the identity, `me`). Set it. |
| `AUTH_HOST` | | Auth subdomain for OAuth and the owner pages, e.g. `id.tim.example.com`. Add it to the pull zone too. |
| `STORAGE_ZONE` | | Name of the storage zone. |
| `STORAGE_HOST` | `storage.bunnycdn.com` | API host of the storage zone's primary region. |
| `STORAGE_ACCESS_KEY` | | Storage zone password (**secret**). |
| `BOOTSTRAP_SECRET` | | One-time setup secret (**secret**). |
| `RECOVERY_SECRET` | | Set only when you lost your passkey (**secret**, at least 16 characters): open `/pups/recover` and choose a new passkey or password, which replaces all passkeys and the password. Then remove it; each value works once. While you have a passkey, the password is not accepted. |
| `PUBLIC_BASE` | `https://<OWNER_HOST>/files/` | Public base URL for reads. Never a pull zone on the storage zone itself. |
| `MAX_UPLOAD_BYTES` | `26214400` | Largest accepted file. |
| `MAX_STORAGE_BYTES` | `0` | Storage quota (approximate); `0` means unlimited. |
| `WRITES_PER_MINUTE` | `120` | Writes per grant and minute, per instance; `0` means unlimited. |
| `WELL_KNOWN_PATHS` | RFC-6 list | Declared well-known paths as JSON, including [private paths](#private-areas) in `/pups/private/`. |
| `ORIGIN_URL` | | An existing website behind this server. Unknown paths, and declared files nobody has uploaded, are fetched from it. |
| `POST_FALLBACK` | `false` | `true` declares `post_endpoint`. |
| `DOH_URL` | `https://cloudflare-dns.com/dns-query` | DNS-over-HTTPS resolver for the SSRF check; `off` disables the check. |
| `MENTIONS` | `true` | Receive mentions of your domain (RFC-11) at `/pups/mention`, see [Inbox](#inbox). |
| `COMMENTS` | `true` | Receive comments on your feeds (RFC-4) at `/pups/comments`. |
| `WEBPUP_OWNER_LINK` | `true` | `false`: webpup without the link to the owner pages at the bottom of the page. |
| `DEV_ALLOW_HTTP` | `false` | Local development only. |

## Feeds

The script keeps your feeds ([RFC-7](https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md)), as the PHP and Cloudflare versions do ([pups-feeds](../lib/pups-feeds)): feed files in `/feed.json` or `/feed/<name>.json` with `"_pups": { "pupsControlled": true }`. Apps `POST` posts to the feed file at `/files/…`; the script gives them their index (and with webpup the URL of their page), puts them into the archives `feed.000000.json`, … of 20 posts each ([RFC-13](https://github.com/bigwide-net/RFCs/blob/main/RFC-13-JSON-Feed-Archives.md)), and writes the feed file with the newest 30. A `PUT` of the feed file is applied to the stored one; apps can't write the archives. The configuration document says `"kept_feeds": true`.

RFC-7 asks for a lock around each request. Bunny Storage has none, so requests to the same feed take their turn within one script instance, but not across instances (see [Consistency](#consistency)).

**Real-time updates.** The script is a minimal [WebSub](https://www.w3.org/TR/websub/) hub for your kept feeds, on by default (RFC-7 "Real-time updates"). Feed files name it in `hubs` and in a `Link` header; archives and comment feeds don't take part. Feed readers subscribe at `/pups/websub`; the script checks the callback's host (DNS over HTTPS, as for client metadata) and verifies the subscription there after the response. After an app changed a feed, it sends every subscriber an empty `POST`, 35 per request; while subscribers are left, it calls itself at `/pups/websub/work` (with a key derived from your installation's secret), so that each batch has its own 50 subrequests. The subscriptions of a feed are one file, `_pups/websub/topics/<feed>.json`; a changed feed waits in `_pups/websub/pending/`. On the page *Feeds* you turn the hub off (the script then removes `hubs` from your feed files at once), set how many subscriptions it takes (1000 by default, at most 10,000; further readers get `403` and poll as before), and list the trusted feed readers, whose subscriptions are always accepted: by default Downread, Feedly, Inoreader, Feedbin, NewsBlur, The Old Reader and BazQux, by domain. The callback's domain is what the hub goes by: a `User-Agent` or an IP address can be faked or change, but a subscription only counts once its callback has echoed the hub's random challenge, so nobody can subscribe in the name of another domain. Each callback host gets at most 5 subscriptions per feed.

## Inbox

The script has the same small built-in receiver as the PHP and Cloudflare versions. It puts what other sites send you into your **inbox**, a private JSON Feed at `/pups/private/inbox.json` ([RFC-12](https://github.com/bigwide-net/RFCs/blob/main/RFC-12-Inbox-Feeds.md)), which your feed reader shows if you allow it `read:/pups/private/inbox.json`. The path is declared automatically while the receiver is on. `MENTIONS` and `COMMENTS` turn the two parts off.

- **Mentions** ([RFC-11](https://github.com/bigwide-net/RFCs/blob/main/RFC-11-Mentions.md)) at `/pups/mention`, when a post names `@yourdomain` or replies to one of your posts. The generated `host-meta.json` links it (rel `https://bigwide.net/ns/mention`); a stored one gets the link once, and if you remove it, it stays removed.
- **Comments** ([RFC-4](https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md)) on feeds that name `/pups/comments` in `_submissions.url`. They are checked against the feed's rules, including the formatting the policy allows ([RFC-5](https://github.com/bigwide-net/RFCs/blob/main/RFC-5-Comment-HTML.md): `allowStyle`, `allowLinks`, `allowImages` …; a missing one is off), and land in your inbox. In a kept feed with `republish: "full"` or `"summary"`, *Publish Comment* publishes one in the comment feed of the post or comment it answers (`/feed/comments/<index>.json`, RFC-7 "Publishing comments"). `/pups/comments/status/s-…` tells the sender how it went.
- **Auto-moderation**, off by default. On the page *Comments* (`/pups/comment-settings`) you can enter the API key of an OpenAI-compatible chat API (OpenRouter by default, model `openai/gpt-5-nano`; both can be changed), your own criteria, a threshold (90 % by default) and a daily limit of tokens in thousands (500 by default, at most 10,000). A model then rates each comment against general rules (spam, scams, illegal and adult content, abuse, personal data) and your criteria; comments rated at least as likely acceptable as the threshold are published at once, all others wait in your inbox with the rating. The published ones are in your inbox too, as replies with the rating and a *Reject Comment* button, which removes the comment, and the replies to it, from your site after asking (*Dismiss* only removes it from the inbox); you can turn that off. If the API fails or the day's tokens are used up, comments simply wait in your inbox. Your own comments, from a feed on your domain, are always published at once.
- **Telling people about published comments** ([RFC-11](https://github.com/bigwide-net/RFCs/blob/main/RFC-11-Mentions.md)): when a comment is published, the author of the comment it answers gets a reply mention, unless they wrote RFC-4's `notifyReplies: false` on their comment, and every other `@domain` it names a mention by name; never the comment's author or you. Edits and deletes send them again. They go out after the response, through the same queue; failed deliveries are retried for about a day.
- Webmentions are answered at once and checked after the response with `Bunny.v1.waitUntil()`: the script fetches the post (1 MB, 10 s, 3 redirects, after the same DNS check as client metadata documents) and puts it into the inbox if it really names or answers you. They wait as files in `_pups/mentions/queue/`, at most 100, 5 per site. Each request checks at most 2, to stay under the 50 subrequests; the next webmention picks up the rest.
- The inbox holds 100 items, 10 per site. Mentions make room after 30 days or when the inbox is full; comments are never dropped.
- **Dismiss**: every item has an RFC-9 action (`/pups/inbox/action`) and a link to a page that asks first (`/pups/inbox/dismiss`); likewise *Publish Comment* (`/pups/inbox/approve`) and *Reject Comment* (`/pups/inbox/reject`).

## Homepage

On the page *Homepage* (`/pups/homepage`) you can make **webpup** the homepage of your domain, choose its theme and the theme browser, or remove it again; then `/` forwards to the owner pages at `/pups/`. webpup's files are part of the script, nothing is copied to the storage zone. `/` and `/p/…` serve its `index.html`; `/webpups.js`, `/webpup.css`, `/theme.css`, `/webpup-themes/…` and `/webpup-config.json` the rest, revalidated on every request. For Markdown browsers like [bonBon](https://github.com/scripting/bonBon), which don't run webpup's script, `index.html` links the Markdown file that the page shows (`<link rel="alternate" type="text/markdown">`): at `/`, the page that `host-meta.json` marks as the home page; at `/p/md/<path>`, that file. While webpup is installed, `host-meta.json` declares its post pages with the property `https://bigwide.net/ns/post-url-template` (`https://tim.example.com/p/{feed}/post/{index}`). With `ORIGIN_URL`, your existing website keeps `/`.

## Security notes

- **SSRF.** Edge Scripts can't restrict `fetch()` to public addresses (Cloudflare's `global_fetch_strictly_public`). Before fetching a client metadata document or a post for the receiver, the script resolves its host over DNS-over-HTTPS and refuses private, loopback, link-local and other special-purpose addresses. The gap: `fetch()` resolves the name again, so DNS rebinding can still reach a private address. If Bunny's network turns out to block private addresses itself, set `DOH_URL=off`.
- **Identity tokens** ([RFC-10](https://github.com/bigwide-net/RFCs/blob/main/RFC-10-Identity-Tokens.md)): an app with the scope `identity-tokens` (its own consent group, always with step-up confirmation) trades its access token at `/oauth/token` (RFC 8693 token exchange, `audience` = one https origin) for a JWT signed with RS256, valid for 60 seconds, that says that the owner acts at that origin through the app. With `scope=read` the app gets a **read token** instead, for fetching personal feeds: the same JWT with `"scope": "read"`, valid for 24 hours, with `scope` in the answer; any other `scope` gets `invalid_scope`. The script makes an RSA key of 2048 bits on first use and keeps it in `_pups/signing-key.json`; `/pups/jwks.json` on the auth host publishes its public half (`jwks_uri`, cacheable for 10 minutes). Each grant may get 60 tokens a minute; every token is logged for 30 days in `_pups/identity/<grant>.json` (at most the newest 10,000 per grant), and the apps page shows for each app where it acted as you, with a button that replaces the key if it may have leaked. The upload API never accepts identity tokens.
- **The storage zone password** gives full access to all files and to the state, including the password hash and the signing key. It lives only in the script's secrets.
- **Files are buffered.** Serving a file reads all of it to compute its ETag, and range requests are cut from the buffer. With uploads capped at 25 MB, this stays well below the 128 MB memory limit, but large files written to the zone by other means would be slow to serve.

## Limits

- **50 subrequests per request.** Every storage access is one. Most requests need 3 to 10. The apps page needs about 10 plus one per app, and one more per app with `identity-tokens`, so it works for about 40 apps (20 that all have it). Checking a webmention takes about a dozen, which is why a request checks at most two. Posting to a kept feed takes about a dozen too; a `PUT` of a feed file that changes many old posts needs one more per archive it touches.
- **Work after the response.** Whether `waitUntil()` work has its own limits is not documented ([Open questions](#open-questions)). Webmentions that weren't checked stay in the queue for the next one. WebSub pings that a run didn't send wait for the next change of the feed, if the script's call of itself fails.
- **WebSub.** The callback's host is checked for private addresses when the subscription is verified, not before every ping: that would take two more subrequests per subscriber. Two instances that change a feed's subscriptions in the same instant can lose one of the changes.
- **One owner per script and storage zone**, as in RFC-6.

## Open questions

These are undocumented by Bunny. Check them on the first deployment:

1. Do `PUT`, `DELETE` and `OPTIONS` (CORS preflight) reach the script through the pull zone? Do bodies up to 25 MB?
2. Does `req.url` carry `https:`, or only `X-Forwarded-Proto`? The script accepts both; if it sees neither, it redirects in a loop.
3. Does WebCrypto support PBKDF2 with 100,000 iterations, within the CPU limit? And the ECDSA, RSA and Ed25519 verification that passkeys use?
4. Does a read from the storage API right after a write return the new file? Rotation, revocation and the feed fetch of RFC-4 depend on it.
5. Does Bunny Storage accept keys starting with a dot (`.well-known/about.md`)? Does a `DELETE` of a directory delete everything in it?
6. Do `Set-Cookie` and `303` responses pass through unchanged (auth subdomain mode)?
7. Does the pull zone leave `no-cache` and `no-store` responses (404s of files included) uncached? Does it pass requests with `Authorization` to the script (fresh reads, private files)? Does the edge rule for the private areas keep them out of the cache?
8. Can a script reach private addresses (`10.0.0.1`, `169.254.169.254`)?
9. Does work passed to `Bunny.v1.waitUntil()` run to its end after the response, and do the CPU and subrequest limits of the request apply to it?
10. Does a request of the script to its own domain (`/pups/websub/work`) reach the script again, as a request with its own limits?

## Development

The owner pages (HTML, `owner.css`, `owner.js`), the sanitizer and webpup come from [pups-ui](../lib/pups-ui), the receiver from [pups-inbox](../lib/pups-inbox) and kept feeds from [pups-feeds](../lib/pups-feeds): local dependencies (`file:../lib/pups-ui`, …) in the same repository.

```
npm install
npm test           # vitest, against fakes of Bunny Storage, DNS and client documents
npm run typecheck
npm run build      # dist/index.js
```

The code is a port of pups-cloudflare. What differs:

| File | Change |
| --- | --- |
| `src/storage.ts` | New: Bunny Storage HTTP client with content-hash ETags (replaces R2). |
| `src/state.ts` | New: state as JSON files in storage (replaces the Durable Object `store.ts`). |
| `src/ssrf.ts` | New: DNS check before client metadata fetches and the receiver's fetches. |
| `src/main.ts` | New: the Edge Script entry point; passes `Bunny.v1.waitUntil` on. |
| `src/receiver.ts` | The receiver's storage: the queue and status pages as files, the inbox reread before each write. |
| `src/feeds.ts` | Kept feeds: the lock is per instance only. |
| `src/websub.ts` | New: the WebSub hub, with the subscriptions of a feed in one file and pings that continue in a call of the script to itself. |
| `files.ts`, `hostmeta.ts` | Preconditions checked by reading and hashing the current file; byte ranges cut from the buffer. |
| `auth.ts` | Signed WebAuthn challenges. |
| `index.ts` | Bundled assets, `ORIGIN_URL` proxy, `X-Forwarded-Proto`. |

Everything else (paths, scopes, file types, OAuth, owner pages, sanitizing) is unchanged. A shared core package, so that fixes don't have to be made twice, is the next step; see [CONCEPT.md](CONCEPT.md).
