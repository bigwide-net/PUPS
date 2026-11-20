# pups-bunny

A [Personal Upload Server](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md) (RFC-6) for Bunny.net: one standalone **Edge Script** and one **Bunny Storage** zone, nothing else. Sibling of [pups-cloudflare](../pups-cloudflare), with the same protocol, owner pages and configuration.

**Status: not yet run on Bunny.** The tests run against a fake of the Bunny Storage HTTP API. Several platform details are undocumented and must be checked on the first deployment; see [Open questions](#open-questions).

## How it works

```
tim.example.com ──► Pull zone (custom hostname, TLS)
                     ▼
                    Standalone Edge Script (dist/index.js)
                     └── Bunny Storage HTTP API: uploaded files, .well-known/host-meta.json,
                         and the server's own state under _pups/
```

- **No database.** The OAuth state is kept as small JSON files under `_pups/` in the storage zone: owner credentials, grants with token hashes and refresh state, authorization codes, used nonces, sessions. `_pups/` can never be written by an app or served.
- **Tokens are `<grant id>.<random>`**, stored only as SHA-256 hashes in their grant's file. A request reads one file to authenticate.
- **ETags are content hashes.** Bunny Storage has no ETags, so the ETag of a file is the SHA-256 of its content (`"<base64url>"`). The server reads the file to compute it, both when serving it and when checking `If-Match` / `If-None-Match` before a write. Uploads carry the same hash in Bunny's `Checksum` header.
- **WebAuthn challenges are signed values**, made single-use by a nonce file.
- **The stylesheet and script** of the owner pages are bundled into the script.

### Consistency

Bunny Storage has no transactions or conditional writes. Every check-and-set (single-use codes, refresh rotation, `If-Match`) is a read followed by a write, so two requests in the same instant can both pass. For a server with one owner this was judged acceptable:

| Race | Effect |
| --- | --- |
| A code redeemed twice in parallel | Two grants. PKCE already makes a stolen code useless without the app's verifier. |
| Two refreshes with the same token in parallel | Both succeed and reuse goes undetected. RFC-6 requires apps to refresh one at a time. |
| Two conditional writes to the same file in parallel | Both succeed, the last one wins. |
| The owner revokes an app while it refreshes | The refresh can rewrite the grant file the revocation just deleted. Revoke again. |
| host-meta.json edited in parallel | The file is reread just before the write, which narrows but doesn't close the window. |

Requests that don't race behave exactly like the Cloudflare version.

The **write rate limit** is counted per script instance, and the **storage quota** counter is updated with a read-modify-write, so both are approximate.

### Fresh reads

A `GET` or `HEAD` at `storage_base` with `Authorization: Bearer <token>` is a fresh read (RFC-6). Any valid token of the server is accepted, whatever its scopes, and its use is recorded as for a write. An invalid, expired or revoked one gets `401`; other schemes, such as `Basic`, are ignored. The script reads the file from the storage API, as for every read, and answers with `Cache-Control: private, no-store` instead of `no-cache`. Public responses carry `Vary: Authorization`.

On Bunny, a fresh read is fresh only because files are never cached at the edge:

- The pull zone runs a standalone script only on a cache miss, and it **ignores `Vary`** (the cache key is set under *Vary Cache*). It doesn't store responses to requests with `Authorization`, but it reportedly serves them a response that is already cached ([HTTP Toolkit, 2023](https://httptoolkit.com/blog/bunny-cdn-caching-vulnerability/)). Files are sent with `no-cache`, so nothing should be cached (open question 7). Don't cache files at the edge, e.g. with an *Override Cache Time* edge rule or `s-maxage` for media: fresh reads would get the cached copy, unless the script runs before the cache.
- The script reads from the API host of the zone's primary region, where uploads land. Replication regions only serve CDN delivery, which PUPS doesn't use. Whether that host returns a file right after it was written is undocumented (open question 4).

### Private areas

Two areas hold files that only the owner's apps can read (RFC-6 "Private areas"):

- **`/appdata/<client-host>/private/`**, the app's own private data. The app's scope `write:/appdata/<client-host>/` covers it; nothing needs to be configured.
- **`/pups/private/`**, for private files that an extension of RFC-6 defines, e.g. an inbox. Paths there are declared in `WELL_KNOWN_PATHS` with `path` only (and optionally `description`, the consent screen's wording), never `url`, `rels`, `properties`, `link_properties`, `url_properties` or `single_rels`, e.g. `{"path": "/pups/private/inbox/", "description": "your inbox"}`. Apps request them with `read:<path>` or `write:<path>`, which need step-up and appear as "Read your private data" or "Manage your private data" on the consent screen. None are declared by default.

A private file is served, at `storage_base` or any other URL that maps to it, only with a bearer token whose `write:` or `read:` scope covers it: no token gets `401` with `WWW-Authenticate: Bearer`, an invalid one `401`, a token without a covering scope `403`, and only then a missing file `404`. Every response for a private path carries `Cache-Control: no-store` (`private, no-store` for a `200`) and `Vary: Authorization`, and never falls back to `ORIGIN_URL`. A `read:` scope never allows writing. Private files can't be linked in `host-meta.json` or used as URL property values (`403`). They are hidden, not encrypted: whoever can open the storage zone can read them.

Because the pull zone ignores `Vary` (see [Fresh reads](#fresh-reads)), add an edge rule that keeps it from caching the private areas: see [Connect your domain](INSTALL.md#5-connect-your-domain) in INSTALL.md.

## Deploy

Step by step, for owners: [INSTALL.md](INSTALL.md). In short:

1. **Storage zone.** Create one under *Storage*. Note its name, its primary region's API host (e.g. `storage.bunnycdn.com` for Falkenstein, `ny.storage.bunnycdn.com` for New York) and its *password* under *FTP & API Access*. Don't connect it to a pull zone: the server's state would become readable. Replication regions are optional, because the script always reads from the primary region.
2. **Build** the script: `npm install && npm run build`, with [pups-ui](../pups-ui) (the owner pages, shared with pups-cloudflare) next to this directory, as in the repository. This writes `dist/index.js`, a single file.
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
| `PUBLIC_BASE` | `https://<OWNER_HOST>/files/` | Public base URL for reads. Never a pull zone on the storage zone itself. |
| `MAX_UPLOAD_BYTES` | `26214400` | Largest accepted file. |
| `MAX_STORAGE_BYTES` | `0` | Storage quota (approximate); `0` means unlimited. |
| `WRITES_PER_MINUTE` | `120` | Writes per grant and minute, per instance; `0` means unlimited. |
| `WELL_KNOWN_PATHS` | RFC-6 list | Declared well-known paths as JSON, including [private paths](#private-areas) in `/pups/private/`. |
| `ORIGIN_URL` | | An existing website behind this server. Unknown paths, and declared files nobody has uploaded, are fetched from it. |
| `POST_FALLBACK` | `false` | `true` declares `post_endpoint`. |
| `DOH_URL` | `https://cloudflare-dns.com/dns-query` | DNS-over-HTTPS resolver for the SSRF check; `off` disables the check. |
| `DEV_ALLOW_HTTP` | `false` | Local development only. |

## Security notes

- **SSRF.** Edge Scripts can't restrict `fetch()` to public addresses (Cloudflare's `global_fetch_strictly_public`). Before fetching a client metadata document, the script resolves its host over DNS-over-HTTPS and refuses private, loopback, link-local and other special-purpose addresses. The gap: `fetch()` resolves the name again, so DNS rebinding can still reach a private address. If Bunny's network turns out to block private addresses itself, set `DOH_URL=off`.
- **The storage zone password** gives full access to all files and to the state, including the password hash and the signing key. It lives only in the script's secrets.
- **Files are buffered.** Serving a file reads all of it to compute its ETag, and range requests are cut from the buffer. With uploads capped at 25 MB, this stays well below the 128 MB memory limit, but large files written to the zone by other means would be slow to serve.

## Limits

- **50 subrequests per request.** Every storage access is one. Most requests need 3 to 10. The apps page needs about 10 plus one per app, so it works for about 40 apps.
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

## Development

The owner pages (HTML, `owner.css`, `owner.js`) and the sanitizer come from [pups-ui](../pups-ui), a local dependency (`file:../pups-ui`) in the same repository.

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
| `src/ssrf.ts` | New: DNS check before client metadata fetches. |
| `src/main.ts` | New: the Edge Script entry point. |
| `files.ts`, `hostmeta.ts` | Preconditions checked by reading and hashing the current file; byte ranges cut from the buffer. |
| `auth.ts` | Signed WebAuthn challenges. |
| `index.ts` | Bundled assets, `ORIGIN_URL` proxy, `X-Forwarded-Proto`. |

Everything else (paths, scopes, file types, OAuth, owner pages, sanitizing) is unchanged. A shared core package, so that fixes don't have to be made twice, is the next step; see [CONCEPT.md](CONCEPT.md).
