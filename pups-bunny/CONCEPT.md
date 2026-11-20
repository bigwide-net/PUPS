# pups-bunny: Concept for a Bunny.net Version of PUPS

> **Decision, Nov 16, 2026:** implemented **without Bunny Database**. All state lives as JSON files in the storage zone, ETags are content hashes, and the short race windows this causes are accepted, because PUPS has a single owner. The database-based design below remains as the strict alternative. The implementation is described in [README.md](README.md).

Nov 16, 2026 · Draft · Implements [RFC-6: Personal Upload Server](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md), `spec_version` 0.1 · Sibling of [pups-cloudflare](../pups-cloudflare)

## Summary

A Bunny.net version of PUPS is possible with **one standalone Edge Script**, **Bunny Database** for state and **Bunny Storage** for files. Apps couldn't tell it apart from the Cloudflare version.

The standalone-vs-middleware question turns out not to be about price: both modes are billed per script execution, and both execute only on cache misses unless "run before cache" is on. It is about correctness. RFC-6 needs things that only code can do on every response: the ETags that `If-Match` relies on, the sandbox headers, the `Service-Worker` refusal and the path rules. A standalone script does all of them in one place, like the Worker. A middleware setup has to spread them over hooks, edge rules and the storage origin, and some of them (exact ETags, `Service-Worker: script` on cache hits) can't be done there without running the script before the cache on every request, which is the expensive mode.

**Recommendation: standalone script.** It is as cheap as middleware, simpler and closer to the Cloudflare code.

The real work is elsewhere. Bunny has no Durable Object and Bunny Storage has no conditional writes, so two things that R2 and Durable Objects give for free must be built:

1. **Atomic OAuth state** (single-use codes, refresh rotation with reuse detection) moves to Bunny Database, a libSQL (SQLite) database with serializable write transactions on one primary. It is in public preview.
2. **ETags and `If-Match` / `If-None-Match: *`** are emulated: the database keeps an index of every file with its SHA-256 and a short write lock, because the Storage HTTP API has no ETags and overwrites unconditionally.

Several platform facts that RFC-6 depends on are undocumented and must be tested before building (see [Spike](#spike-test-before-building)), above all: request bodies up to 25 MB, PUT/DELETE/OPTIONS through a pull zone, WebCrypto coverage, and whether outbound `fetch` can reach private addresses (SSRF).

Cost is not an argument for Bunny: a personal server sits at Bunny's monthly minimums, about **$2.20/month**, while the Cloudflare version usually fits Cloudflare's free tier. Bunny's case is independence from Cloudflare, EU data residency and its CDN.

## Building blocks

| Cloudflare version | Bunny version | Notes |
| --- | --- | --- |
| Worker | Standalone Edge Script (Deno-based) | Origin of a pull zone; `BunnySDK.net.http.serve(handler)` |
| Durable Object (SQLite) | Bunny Database (libSQL) | Public preview, free during preview; 1 GB per database |
| R2 bucket | Bunny Storage zone, HTTP API | No ETags, no conditional writes, no HEAD documented |
| R2 conditional put | File index + lock in Bunny Database | See [File writes](#file-writes-emulated-etags) |
| Custom domain | Pull zone custom hostname | Free TLS; max 10 hostnames per pull zone |
| `global_fetch_strictly_public` | Nothing documented | SSRF protection must be built or verified |
| Static assets (from pups-ui) | Inlined in the script bundle | Two small files: `owner.css`, `owner.js` |
| Secrets (`wrangler secret`) | Edge Script secrets (write-only) | `Deno.env.get()` / `process.env` |

Facts about Bunny in this document come from bunny.net/docs as of November 16, 2026, in particular the pages on scripting (overview, standalone, middleware, limits, pricing, runtime, secrets), storage (HTTP API, limits, replication, pricing, S3), and database (replication, durability and consistency, SQL API, limits).

## Standalone or middleware

### How the modes work

- **Standalone**: the script *is* the origin of its pull zone. Every request that isn't answered from the CDN cache reaches the handler, which routes by path. With "Run script before cache", it runs on every request instead.
- **Middleware**: the pull zone has a normal origin (here: the storage zone), and the script hooks into the request path:
  - `onOriginRequest` and `onOriginResponse` run on cache misses only. `onOriginRequest` can short-circuit with its own response; `onOriginResponse` can change headers before the response is cached.
  - `onClientRequest` and `onClientResponse` run on every request, including cache hits, but only in "run before cache" mode.

### Cost

Both modes cost **$0.20 per million script executions plus $0.02 per 1,000 s of CPU**, with a $0.22 monthly minimum. Neither mode is billed for requests that are answered from the cache without running the script. So:

- Standalone (default mode) and middleware (default mode) cost the same per cache miss. In middleware, a miss on a file still runs the script once (to set the headers in `onOriginResponse`).
- Middleware in "run before cache" mode bills every request, including cache hits. That is the only mode where middleware could do per-request checks on cached files, and it is the most expensive.
- The difference is negligible for a personal server anyway: 1 million executions at 10 ms CPU cost $0.40.

So a standalone script is never more expensive, and the hope that one mode is much cheaper doesn't hold.

### Correctness

| RFC-6 requirement | Standalone | Middleware (storage origin) |
| --- | --- | --- |
| ETag on `GET` at `storage_base`, matching `If-Match` | Script answers with the ETag from the file index | Storage origin's ETag undocumented; CDN may turn it weak. Needs `storage_base` to be a script route anyway |
| Content-Type from the extension table | Script sets it | Storage's Content-Type undocumented → fix in `onOriginResponse` |
| `CSP: sandbox`, `nosniff`, CORS on every file | Script sets them | `onOriginResponse` or edge rules (cached with the response) |
| `Service-Worker: script` → 403, also on cache hits | Script checks it on misses; for hits, one edge rule | Edge rule, or "before cache" mode |
| Path rules on reads, no serving of `.well-known/host-meta.json` source etc. | In code | Edge rules or nothing |
| Fresh reads right after a write (RFC-4) | Script reads from the primary region | CDN reads from the nearest storage replica; replication lag undocumented |
| OAuth endpoints, owner pages, upload API | In the script | `onOriginRequest` short-circuit, so it works too |
| Range requests for media | Script must proxy them (storage API Range undocumented) | Native CDN feature |

Middleware's one real advantage is that the CDN serves file bytes straight from storage, with native Range support and replica proximity. Its disadvantages are the stale replica reads and a configuration split over code, edge rules and dashboard settings that the owner must reproduce exactly. For media-heavy sites (podcasts) the middleware variant may become interesting later; see [Variant: middleware](#variant-middleware).

**Decision: standalone.** Same price, all RFC-6 rules in code, one deployment artifact, and the structure of the Cloudflare version.

## Concept

### Architecture

```
tim.example.com ──► Bunny pull zone (custom hostname, TLS)
                     │  cache: only what the script marks cacheable
                     ▼
                    Standalone Edge Script (router, same modules as the Worker)
                     ├── Bunny Database (libSQL over HTTPS): owner, grants, tokens, codes,
                     │     sessions, rate limits, file index + write locks, host-meta lock
                     └── Bunny Storage HTTP API (primary region host): file bytes,
                           .well-known/host-meta.json
```

Auth subdomain mode works the same way: `id.tim.example.com` is a second hostname on the same pull zone, and the script routes by `Host`.

### Code structure: a shared core

Most of pups-cloudflare is platform-neutral: paths, scopes, file types, CIMD validation, OAuth logic, host-meta rules, owner pages, sanitizing. The Bunny version should not be a fork. Proposal:

- **`pups-core`**: the platform-neutral modules, with two interfaces:
  - `Store`: the methods of today's `PupsStore` (`redeemCode`, `refresh`, `authenticate`, `createCode`, …). They already return promises, because the Worker calls the Durable Object over RPC, so a database-backed implementation fits the same shape.
  - `Files`: `get`, `head`, `put` (with `If-Match` / `If-None-Match`), `delete`, `deletePrefix`, `list`.
- **pups-cloudflare**: Durable Object `Store`, R2 `Files`.
- **pups-bunny**: libSQL `Store`, Bunny Storage + index `Files`.
- **The PHP drop-in** later ports the same core logic, with SQLite and the filesystem.

Small platform differences to abstract: `crypto.subtle.timingSafeEqual` is a Workers extension (replace with a constant-time loop), and static assets get inlined into the bundle.

### State in Bunny Database

The schema of the Durable Object moves over almost unchanged. The difference is the execution model: the Durable Object ran each method synchronously against local SQLite, while libSQL is reached over HTTPS, and every statement may be a network round trip to the primary.

- **Atomic operations** (`redeemCode`, `refresh`, `revokeToken`, `createOwner`, `useNonce`, `takeChallenge`) run as **write transactions** on the primary. They are serializable. Two styles:
  - Interactive `client.transaction("write")`: a direct port of today's code, but it holds the write lock across round trips (5 s timeout).
  - Batches of conditional statements (`UPDATE … WHERE used_at IS NULL`, `INSERT … SELECT … WHERE NOT EXISTS`, `RETURNING`), executed with `client.batch(stmts, "write")` as one implicit transaction. Fewer round trips, but the logic must be rewritten as SQL.
  Start with interactive transactions; a personal server has no contention.
- **Reads that decide security questions** (token lookup, grant lookup) must not come from a lagging replica. A connection always sees its own writes; across script instances, reads may be stale. The simple rule: authentication reads go to the primary (inside a read transaction or as part of the write that follows), never to a plain replica read.
- **Durability caveat**: Bunny documents that commits can be lost on a primary failover, up to about 10 seconds of writes. A lost "code used" or "token replaced" mark could let a stolen code or refresh token work once more. The window is small and the attacker must already hold the token, but it is weaker than the Durable Object. Document it.
- **Cost**: free during the preview; afterwards $0.30 per million rows written and $0.30 per billion rows read. A personal server writes a few thousand rows a month.

### File writes: emulated ETags

The Storage HTTP API offers `PUT` (overwrites), `GET`, `DELETE` (recursive for directories) and a JSON directory listing. It returns no ETag, accepts no conditional headers, and documents no HEAD. A `Checksum` header (SHA-256, hex) protects integrity. So the database keeps an index:

```sql
files (path TEXT PRIMARY KEY, etag TEXT NOT NULL, size INTEGER NOT NULL,
       grant_id TEXT, client_id TEXT, updated_at INTEGER NOT NULL,
       lock_token TEXT, lock_until INTEGER)
```

The ETag is `"<base64url SHA-256 of the content>"`. A write runs in three steps:

1. **Lock** (one write transaction): read the row; check `If-Match` / `If-None-Match` against `etag` (missing row = missing file); refuse with `409`/`503` if another live lock exists; set `lock_token` and `lock_until = now + 60 s`; reserve the quota.
2. **Upload** the body to storage with `Checksum`. On failure, release the lock and the quota.
3. **Commit** (one write transaction): set `etag`, `size`, `grant_id`, clear the lock, but only if `lock_token` still matches.

`DELETE` works the same way, and deleting an app's files is a single recursive `DELETE` of its directory plus one `DELETE FROM files WHERE path LIKE …`.

Consequences:

- `GET`/`HEAD` at `storage_base` answer with the ETag from the index, so read-modify-write works exactly as RFC-6 describes.
- A script crash between steps 2 and 3 leaves new content with an old ETag until the lock expires. Recovery: when a write finds an expired lock, it rereads the file, hashes it and repairs the row before checking the precondition.
- **Changes outside PUPS** (owner uploads via the Bunny dashboard, FTP) bypass the index, so the ETag would be stale. The owner pages could offer "rescan files"; the README must say that files are managed through PUPS.
- `host-meta.json` is written through the same lock, which replaces the R2 `etagMatches` retry loop.

### Serving files

- The script serves `GET`/`HEAD` for `/files/*` and the declared well-known URLs (`/.well-known/about.md`, `/feed.json`, `/feed/…`, `/pups/images/…`, `/pups/pages/…`) like the Worker: path validation, Content-Type from the extension table, `nosniff`, `CSP: sandbox`, CORS, ETag from the index, `Cache-Control: no-cache`.
- Bytes come from the storage API host of the zone's primary region, so a read right after a write sees the new file. (Read-after-write on that host is not documented: [spike](#spike-test-before-building) item.)
- **Fresh reads** (RFC-6): `GET`/`HEAD` at `storage_base` with a Bearer token of any scope get `Cache-Control: private, no-store`; public responses carry `Vary: Authorization`. Bunny ignores `Vary` and serves already cached responses to requests with `Authorization`, so fresh reads stay fresh only while files are not cached at the edge (or the script runs before the cache).
- **CDN caching**: text files (feeds, profiles, OPML) are not cached at the edge, because RFC-4 servers fetch the author feed seconds after the upload. Media (`.mp3`, `.mp4`, images) could be cached briefly (`s-maxage` of a few minutes), but then fresh reads need the script to run before the cache (previous bullet); the implementation caches nothing. Purging on write would need the account-wide API key in the script, which is too powerful a secret; don't.
- **Range** requests for media are forwarded to the storage API if it supports them; otherwise the script answers ranges from a buffered body (128 MB memory, so only for files well below that).
- **`Service-Worker: script`**: the script refuses it on misses; one pull zone edge rule ("block request when header `Service-Worker` equals `script`") covers cache hits.

### Dynamic responses and the cache

The pull zone must never serve one person's response to another. Every OAuth, owner and API response carries `Cache-Control: no-store`, and as a second line of defence, an edge rule disables caching for `/oauth/*`, `/pups/*`, `/personal-storage.json` and `/.well-known/host-meta.json`, except `/pups/images/*` and `/pups/pages/*`. These directories hold uploaded files (the site's avatar and banner, and its pages and footer, RFC-6), not dynamic responses: they are served and cached like every other file (see [Serving files](#serving-files)). Bunny edge rules express the exception with two triggers that must both match: *Request URL* matches any of `*/oauth/*`, `*/pups/*`, `*/personal-storage.json`, `*/.well-known/host-meta.json`, and *Request URL* matches none of `*/pups/images/*`, `*/pups/pages/*`.

### Secrets and configuration

- **Secrets**: `BOOTSTRAP_SECRET`, `STORAGE_ACCESS_KEY` (storage zone password: full read-write access to the zone), `BUNNY_DATABASE_URL`, `BUNNY_DATABASE_AUTH_TOKEN` (full-access token; regenerating it invalidates the tokens of *all* databases in the account).
- **Variables**: the same as the Worker (`OWNER_HOST`, `AUTH_HOST`, `WELL_KNOWN_PATHS`, …), plus `STORAGE_ZONE` and `STORAGE_HOST` (primary region host, e.g. `storage.bunnycdn.com`).
- The HMAC signing key stays in the database, generated on first use.

### Deployment

1. Create a storage zone. A single region avoids replica staleness for CDN-direct reads; since the script reads from the primary anyway, adding replication regions only buys durability.
2. Create the database and add its credentials as script secrets ("Add Secrets to Edge Script").
3. Create the standalone script, set variables and secrets, deploy the bundle (one file built with esbuild: GitHub Action `BunnyWay/actions/deploy-script` or `bunny scripts deploy dist/index.js`).
4. Add the custom hostname(s), activate TLS, add the two edge rules (Service-Worker block, no cache for dynamic paths except `/pups/images/*` and `/pups/pages/*`).
5. Open `/pups/setup`.

A one-click setup like "Deploy to Cloudflare" doesn't exist; a script using the Bunny API could automate steps 1–4.

## Issues

### Must be tested before building (undocumented)

1. **Request body size.** Uploads up to 25 MB must reach the script; the limit for scripts is not documented, nor whether request bodies stream. If the limit is lower, `max_upload_bytes` has to follow it.
2. **Methods.** That `PUT`, `DELETE` and `OPTIONS` (CORS preflight) pass through the pull zone to the script is not documented. If not, PUPS can declare `post_endpoint` (the RFC's POST fallback, already implemented), but preflights must work for browser apps.
3. **WebCrypto.** Not documented. Needed: SHA-256, HMAC, PBKDF2 (or a pure-JS password hash), random values, and for passkeys ECDSA P-256 / RSA / Ed25519 verification via `@simplewebauthn/server`. Deno has all of these upstream; Bunny calls its runtime "a subset".
4. **SSRF.** There is no equivalent of `global_fetch_strictly_public`, and it is not documented whether a script can reach private or link-local addresses (e.g. `169.254.169.254`). Fetching client metadata documents needs a public-only guarantee *after* DNS resolution. Options: verify that Bunny blocks private ranges at the network level, or resolve via DNS-over-HTTPS and refuse private results (which leaves a DNS-rebinding gap, because `fetch` resolves again).
5. **Storage behaviour**: read-after-write on the primary host; whether paths like `.well-known/about.md` (leading dot) are accepted; Range on `GET`; maximum `PUT` size.
6. **Database from the script**: latency of a write transaction from distant PoPs; whether each libSQL call counts against the 50 subrequests per request; `RETURNING` support.
7. **Cookies and redirects**: whether `Set-Cookie` passes through (needed for the auth subdomain session) and whether `3xx` from the script reaches the browser unchanged.
8. **Incoming URLs**: whether dot segments arrive resolved (RFC-6 allows both since the last revision).

### Design risks

- **Bunny Database is a public preview**: no SLA, limits (1 GB, 50 databases) and pricing may change, and the documented failover loss window weakens single-use guarantees slightly.
- **ETag emulation** adds a lock protocol that R2 gave for free, with crash recovery and the out-of-band-edit problem.
- **Two consistency domains**: database and storage can disagree after a crash; the lock lease and repair-on-write keep the window small but not zero.
- **50 subrequests per request**: authorization (CIMD fetch + several queries), a conditional upload (lock, upload, commit, maybe repair) and host-meta edits fit, but each statement must be counted. Batch statements where possible.
- **Write latency**: every write goes to one database primary (Frankfurt or Toronto) and one storage primary. Owners far away see slower consent and uploads. Reads of files stay fast if cacheable.

### Platform risks

- **Runtime future**: Bunny's runtime page says Deno is winding down active development and that Bunny is "evaluating our long-term options". Keep the code on web-standard APIs to stay portable.
- **Powerful secrets**: the storage zone password gives full access to all files; the database token can only be regenerated account-wide. There are no per-script bindings.
- **No one-click deploy**: higher setup effort for owners than the Cloudflare button.

## Cost

For a personal server (thousands to tens of thousands of requests a month):

| Item | Price | Personal server |
| --- | --- | --- |
| Edge Scripting | $0.20 / M executions + $0.02 / 1000 s CPU; $0.22 minimum | $0.22 (minimum) |
| CDN | $0.01 / GB (EU, NA), $1 monthly minimum | $1.00 (minimum) |
| Storage | $0.01 / GB single region, no API fees, $1 monthly minimum | $1.00 (minimum) |
| Database | Free in preview; then $0.30 / M rows written, $0.30 / B rows read, $0.10 / GB | ~$0 |
| **Total** | | **≈ $2.22 / month** |

Standalone and middleware cost the same at this scale. At larger scale, bandwidth dominates ($10 per TB in EU/NA), and middleware could save script executions only where files are cacheable, which feeds aren't.

## Variant: middleware

If a deployment serves heavy media and wants the CDN to read files straight from storage, a middleware setup is possible:

- The pull zone origin is the storage zone; `public_base` is the owner's domain itself (files at `https://tim.example.com/appdata/…`, `/feed.json`, `/.well-known/about.md` map directly to storage keys).
- `storage_base` (writes, and reads with ETags) is a script path, e.g. `https://tim.example.com/pups/files/`; RFC-6 allows `storage_base` and `public_base` to differ.
- `onOriginRequest` answers the API, OAuth and owner routes; `onOriginResponse` sets Content-Type and the safety headers on files.
- Edge rules block `Service-Worker: script` and disable caching for dynamic paths.
- Accepted drawbacks: CDN misses read from the nearest storage replica, so a feed may be stale right after a write (bad for RFC-4); the safety of uploaded files depends on hooks and edge rules being configured exactly; files written outside PUPS get whatever headers storage sends until a miss passes `onOriginResponse`.

Not recommended as the default.

## Spike: test before building

A throwaway standalone script (half a day) that answers the unknowns:

1. `PUT` and `DELETE` with 1 MB, 10 MB and 25 MB bodies through the pull zone; `OPTIONS` preflight; streaming vs buffered body.
2. `crypto.subtle`: SHA-256, HMAC, PBKDF2 with 100,000 iterations (time it), ECDSA P-256 and Ed25519 verify; import `@simplewebauthn/server` via `npm:` and run a verification.
3. `fetch` to `127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `[::1]` and a hostname resolving to a private address.
4. Storage: `PUT` then immediate `GET` on the primary host; key `.well-known/about.md`; `Range` on `GET`; a 25 MB `PUT`.
5. Database: a write transaction from two distant PoPs (time it); count subrequests used.
6. `Set-Cookie` and `303` from the script; a request with `/a/../b` in the path.
7. Pull zone caching of script responses with `no-store`, `no-cache` and `s-maxage`; whether a request with `Authorization` gets a cached response.

If 1, 3 or 4 fail, the port needs a different design (lower upload limit, an SSRF proxy, or another file store), so the spike decides whether pups-bunny is worth building.
