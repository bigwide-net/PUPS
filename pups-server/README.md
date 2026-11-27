# PUPS test server

A small **Personal Upload Server** ([RFC-6](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md), `spec_version` 0.1) in TypeScript and Express, for testing apps and clients locally. It stores uploads as plain files and all other data in one JSON file. There is no database.

It speaks the same protocol as the real implementations (Cloudflare Worker, PHP drop-in): discovery, OAuth 2.1 with PKCE and Client ID Metadata Documents, the upload API with ETags, `host-meta.json` editing, identity tokens ([RFC-10](https://github.com/bigwide-net/RFCs/blob/main/RFC-10-Identity-Tokens.md), the issuing side), and an apps page where the owner sees which apps have access and can revoke them. It is built to be simple, not to face the internet: see [Differences from the RFC](#differences-from-the-rfc).

## Quick start (macOS)

```sh
cd pups-server
npm install                                              # links ../lib/pups-ui, see Code
npm run setup-local                                      # TLS certificate and .env, see below
echo '127.0.0.1 alice.pups.test' | sudo tee -a /etc/hosts
npm start
```

Then open <https://alice.pups.test/>. The password is in `.env` (`PUPS_PASSWORD`).

`npm run setup-local` does three things:

1. Runs `mkcert -install`. It installs a local certificate authority that your browsers and system trust. This may ask for your password. You need [mkcert](https://github.com/FiloSottile/mkcert) (`brew install mkcert`); for Firefox, also `brew install nss`.
2. Creates a certificate for `alice.pups.test` in `certs/`.
3. Creates `.env` from `.env.example`, with a random owner password and the path of mkcert's CA (`PUPS_EXTRA_CA`).

To use a different host name, run `npm run setup-local -- bob.pups.test` and add that name to `/etc/hosts` instead.

## Local setup in detail

RFC-6 clients only need the user's domain, and they discover it the same way every time: `https://<domain>/.well-known/host-meta.json`. That means **HTTPS on port 443**, with no port in the URL, and a certificate the client trusts. A local test server has to provide exactly that.

### Host name

Pick a name under `.test`, a TLD reserved for testing, and point it at your computer in `/etc/hosts`:

```
127.0.0.1 alice.pups.test
```

On macOS, edit it with `sudo nano /etc/hosts`, or append the line with `echo '127.0.0.1 alice.pups.test' | sudo tee -a /etc/hosts`. Changes apply immediately. If a browser still doesn't resolve the name, run `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`. On Linux, edit `/etc/hosts` the same way. On Windows, edit `C:\Windows\System32\drivers\etc\hosts` as administrator.

`.localhost` names don't need an entry in `/etc/hosts`, but you can't use them: client metadata rules reject `localhost`, and some clients treat it specially.

### Certificate

Any certificate your client trusts will do. mkcert is the easiest: `mkcert -install` once, then `mkcert alice.pups.test`. Set `PUPS_TLS_CERT` and `PUPS_TLS_KEY` to the two files it creates.

Node.js doesn't use the system trust store. A Node-based client (tests, scripts, a server-side app) must be told about mkcert's CA:

```sh
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" node your-client.js
```

### Port 443

The server listens on all interfaces, but it accepts only connections from your own computer. Other machines are dropped, unless you set `PUPS_ALLOW_REMOTE=true`.

- **macOS** (10.14 and later) lets normal users open port 443 on all interfaces. No `sudo` needed.
- **Linux** needs one of: `sudo sysctl net.ipv4.ip_unprivileged_port_start=443`, `sudo setcap cap_net_bind_service=+ep $(readlink -f $(which node))`, or a different `PUPS_PORT` with a port forward from 443.
- **Windows**: no restriction.

If something else already uses port 443 (a local web server, Docker), stop it, or give PUPS another host name with its own IP address (`127.0.0.2 alice.pups.test`; on macOS, first run `sudo ifconfig lo0 alias 127.0.0.2`).

### Testing with a local app

The server fetches every app's client metadata document from the app's `client_id` URL. Two settings in `.env` make this work with apps on your own computer:

- `PUPS_ALLOW_PRIVATE_CLIENTS=true` allows client metadata documents on private addresses, e.g. a test app at `https://app.pups.test` that also points to `127.0.0.1` in `/etc/hosts`. A real server never allows this (SSRF protection).
- `PUPS_EXTRA_CA` is mkcert's `rootCA.pem`, so that the server trusts your local app's certificate.

A `client_id` still has to be an HTTPS URL on a domain name, never `localhost` or an IP address. Redirect URIs may be loopback addresses (`http://127.0.0.1/callback`, any port), as in RFC-6.

### Plain HTTP

Without `PUPS_TLS_CERT` and `PUPS_TLS_KEY`, the server speaks plain HTTP, e.g. with `PUPS_ORIGIN=http://localhost:8080`. That is enough for `curl` and for tests of the upload API. RFC-6 clients won't accept it, because discovery always uses HTTPS. The same setup works behind a reverse proxy that handles TLS (Caddy, nginx): set `PUPS_ORIGIN` to the public `https://` origin and `PUPS_PORT` to the port the proxy forwards to.

## Using it

| URL | What |
| --- | --- |
| `/` | Start page with links. |
| `/pups/apps` | **Connected apps**: every grant with the app's domain, its self-declared name, the permissions, when it was approved and last used, and where it acted as you with identity tokens in the last 30 days. Select apps to revoke them, optionally deleting their `/appdata/<app>/` folders. Once there is a signing key, it shows the key with a button that replaces it. Viewing, revoking and replacing the key each need the password. |
| `/.well-known/host-meta.json` | Discovery. If no stored file exists, it is generated with the PUPS link. |
| `/personal-storage.json` | The configuration document. |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata. |
| `/oauth/authorize` | Authorization and consent screen. |
| `/oauth/token`, `/oauth/revoke` | Token and revocation endpoints. The token endpoint also exchanges an access token with the `identity-tokens` scope for an identity token (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, RFC-10), valid for 60 seconds, or with `scope=read` a read token for fetching personal feeds, valid for 24 hours: at most 60 per grant and minute, each logged for 30 days. |
| `/pups/jwks.json` | `jwks_uri`: the public key that checks identity tokens, with CORS and `Cache-Control: public, max-age=600`. The key is made on first use and kept in `state.json`. |
| `/<path>` | Upload API (`PUT`, `DELETE`) and public reads (`GET`, `HEAD`) at the domain root, e.g. `/appdata/app.example/feed.json` and `/.well-known/about.md`. A read with `Authorization: Bearer` and any valid token, whatever its scopes, is a fresh read: `Cache-Control: private, no-store` instead of `no-cache`, and `401` for an invalid token. Private files (below) need a token whose scope covers them. |
| `/pups/host-meta` | `host_meta_endpoint`: apps add links and set properties. |
| `/pups/post` | `post_endpoint`, only with `PUPS_POST_FALLBACK=true`. |

**Uploads live at the root of the domain.** `storage_base` and `public_base` are `https://alice.pups.test/`, so an app's file `/appdata/app.example/logo.svg` is at `https://alice.pups.test/appdata/app.example/logo.svg`. The server's own routes (`/`, `/oauth/…`, `/pups/…`, `/personal-storage.json`, `/.well-known/host-meta.json`, `/.well-known/oauth-authorization-server`) take precedence. Uploads can never shadow them: scopes allow writes only in `/appdata/<app>/` and the declared well-known paths, and well-known paths may not overlap these routes. The exceptions are `/pups/images/` and `/pups/pages/`, the declared directories for the site's profile images and pages, and declared paths inside `/pups/private/`: no route of the server is in them. (The Cloudflare implementation uses `/files/` instead. Both are valid: apps take the base URLs from the configuration document.)

**Private areas.** Files in an app's `/appdata/<app>/private/` and in declared paths inside `/pups/private/` are never served publicly. A read needs `Authorization: Bearer` with a token whose scope covers the path: `write:/appdata/<app>/` for the app's own private folder, and `write:` or `read:` for a declared path in `/pups/private/` (`read:` scopes exist only for these and can't write). The server checks the token before it looks for the file: no token → `401` with `WWW-Authenticate: Bearer`, an invalid one → `401`, a token without a covering scope → `403`, and only then a missing file → `404`. Every response for a private path, errors included, carries `Cache-Control: no-store` (`private, no-store` for the file itself) and `Vary: Authorization`. Private files can't be linked or used as URL properties in `host-meta.json` (`403`), and the log records no public URL for them. They are not encrypted: whoever can read the data directory can read them.

The consent screen shows the app's domain and logo, asks whether you meant to log in with the app, shows a "new app" notice and a notice for loopback redirects, and groups the permissions into identity, app data, feeds, profile, non-public content ("Read non-public content" if the request only reads it) and acting as you on other sites (`identity-tokens`), each with a checkbox and collapsed details. Approving always needs the password, because the server never sets a cookie (see below).

### Data

Everything is in `PUPS_DATA_DIR` (default `./data`):

```
data/
  state.json                      grants, hashed tokens and codes, approved apps, form secret, identity token key and log
  files/                          uploads; https://<host>/x is files/x
    appdata/app.example/…         each app's own folder
    .well-known/about.md          declared well-known files
    feed.json, feed/…             the owner's feeds
    pups/images/…                 the site's profile images
    pups/pages/…                  the site's pages and footer (Markdown)
    .well-known/host-meta.json    host-meta.json, if an app or you created it
```

You may edit files by hand, including `host-meta.json`; PUPS reads them fresh on every request. To start over, stop the server and delete `data/`. `state.json` contains no usable tokens, only SHA-256 hashes, but it does hold the private key that signs identity tokens: keep it private. The button on the apps page replaces it. Restarts keep all grants and tokens.

### Log

The server is a prototype, so it logs everything it does to stdout, one line per entry:

- every request: method, URL, status, duration, sizes, user agent, and why it failed;
- every password check, with the action (`approve app`, `view apps page`, `remove app`, `remove link`, `remove property`, `replace signing key`), success or failure, and blocked attempts;
- client metadata fetches, with the document;
- authorization requests, approvals (requested and granted scope), denials and rejections;
- code exchanges, refreshes (including grace-period retries and reuse that revoked a grant) and revocations;
- issued and refused identity tokens, with the app, grant and audience;
- every created, replaced and deleted file, with the app, path, size, type, preconditions and ETags;
- `host-meta.json` requests and writes, and grants, links and properties removed on the apps page.

```
2026-11-14T09:12:03.120Z login.ok action="approve app" clientId=https://downread.com/oauth/client.json
2026-11-14T09:12:03.122Z authorize.approved clientId=https://downread.com/oauth/client.json requested=write:/appdata/downread.com/ granted=write:/appdata/downread.com/ code=Qm1x8kPa redirectUri=http://127.0.0.1:53682/callback
2026-11-14T09:12:05.410Z file.created client=https://downread.com/oauth/client.json grant=… path=/appdata/downread.com/logos/greenheader3.svg bytes=1843 contentType=image/svg+xml ifNoneMatch=* etag="SfSf…" url=https://alice.pups.test/appdata/downread.com/logos/greenheader3.svg
```

Passwords and tokens are never logged. Codes and tokens appear as a fingerprint: the first 8 characters of their SHA-256 hash, which is also how their key in `state.json` begins.

## Untrusted input

Client metadata documents, scopes, paths, form fields, headers and `host-meta.json` all come from outside. The rules follow Downread's sanitizer (`shared/src/utils/sanitize.ts`):

- **Encoding.** Every value written into an HTML page is HTML-encoded, in element content and in double-quoted attributes. Pages contain no inline script.
- **Sanitizing self-declared text.** `client_name` is shown with control characters, invisible characters (zero-width spaces, direction marks, bidi embeddings, overrides and isolates, word joiners, BOM) and the specials block removed, whitespace collapsed, at most 100 characters, and inside `<bdi>`, so it can't reorder the text around it. Zero-width joiners stay, for emoji and scripts that need them.
- **Values shown exactly** (paths, scopes, client IDs, rels, error messages) are not altered. Instead, invisible characters are shown as `\u{202e}`, so a spoofing attempt stays visible.
- **Rejected outright:** invisible characters in paths, scopes, rels and `host-meta.json` values (stricter than RFC-6, which names only control characters: they could disguise a file name); `client_id` and redirect URI hosts that aren't plain DNS names (the URL parser accepts `;` and `'` in host names); `logo_uri`, `client_uri` and redirect URIs with whitespace or invisible characters. Stored URLs are in canonical form (`new URL().href`).
- **Headers.** Only plain origins enter the consent page's `Content-Security-Policy`.
- **Size limits.** Every string read in has one, and values over it are rejected (`400`), never cut:

  | Input | Limit |
  | --- | --- |
  | URLs: `client_id`, `redirect_uri`, hrefs, `logo_uri`, `client_uri` | 2048 characters |
  | `scope` | 2048 characters, 20 scopes |
  | `state` | 1024 characters |
  | Codes, access and refresh tokens | 256 characters (`code_verifier`: 128) |
  | Passwords | 1024 characters |
  | Signed form fields | 16384 characters |
  | Headers read (`Authorization`, `If-Match`, `If-None-Match`, `Content-Type`) | 1024 characters |
  | Paths | 512 bytes decoded, 1536 characters encoded |
  | Any other form field or query parameter | 256 characters; at most 1000 repeated values |
  | Form bodies | 64 KB |
  | Client metadata documents | 64 KB; `client_name` 1000 characters (100 shown); 20 redirect URIs |
  | `host_meta_endpoint` bodies | 16 KB; `rel` and `property` 512, `value` 2048, `type` 255 characters |
  | `host-meta.json` read for changes | 1 MB |
  | Uploads | `max_upload_bytes` |

  Oversized values on owner pages get an HTML error page; API endpoints answer with JSON.
- **Log.** Values are JSON-quoted with control and invisible characters escaped, so nothing from a request or a fetched document can inject log lines or terminal escape sequences. Values over 4096 characters are cut in the log.
- **Source files** must not contain literal control or invisible characters ("Trojan Source"); `test/source.test.ts` checks that.


## Configuration

All settings come from environment variables, or from `.env`. See `.env.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUPS_ORIGIN` | `https://alice.pups.test` | The owner's domain as an origin. It is the identity `me`; all URLs derive from it. |
| `PUPS_PASSWORD` | (required) | The owner password, at least 8 characters. |
| `PUPS_TLS_CERT`, `PUPS_TLS_KEY` | (none) | TLS certificate and key in PEM. Without them, plain HTTP. |
| `PUPS_PORT` | port of `PUPS_ORIGIN` (443 with TLS) | Port to listen on. |
| `PUPS_ALLOW_REMOTE` | `false` | Accept connections from other machines. |
| `PUPS_DATA_DIR` | `data` | Where `state.json` and `files/` live. |
| `PUPS_ALLOW_PRIVATE_CLIENTS` | `false` | Development: fetch client metadata documents from private addresses. |
| `PUPS_EXTRA_CA` | (none) | Development: extra CA certificate (PEM) for fetching client metadata documents. |
| `PUPS_PUBLIC_BASE` | `<origin>/` | `public_base`, if reads go through another host (a CDN). |
| `PUPS_MAX_UPLOAD_BYTES` | `26214400` | Largest accepted file. |
| `PUPS_POST_FALLBACK` | `false` | Declare `post_endpoint`, to test clients' POST fallback. |
| `PUPS_WELL_KNOWN_PATHS` | RFC-6's list | Declared well-known paths, as JSON (below). |

### Well-known paths

By default the server declares the list of well-known paths of RFC-6, at the domain root:

| Path | Link relations | Properties |
| --- | --- | --- |
| `/.well-known/following.opml` | | |
| `/.well-known/about.md` | | `https://bigwide.net/ns/name`, `…/title`, `…/summary`, `…/theme-color`, `…/language` |
| `/.well-known/contact.vcf` | | |
| `/feed.json` | `https://bigwide.net/ns/feed` | |
| `/feed/` | `https://bigwide.net/ns/feed` | |
| `/pups/images/` (the site's profile images) | | `https://bigwide.net/ns/avatar`, `…/banner`; URL-valued: the URL of an image in `/pups/images/` |
| `/pups/pages/` (the site's pages) | `https://bigwide.net/ns/webpup-pages`, with the link property `…/webpup-hidden` | `https://bigwide.net/ns/webpup-footer`; URL-valued: the URL of a file in `/pups/pages/` |

If the owner's website already serves `/feed.json` or `/feed/` (WordPress, for example, serves its RSS feed at `/feed/`), leave them out: set `PUPS_WELL_KNOWN_PATHS`, which replaces the whole list, e.g.:

```json
[
  { "path": "/.well-known/about.md", "url": "https://alice.pups.test/.well-known/about.md",
    "properties": ["https://bigwide.net/ns/name"] },
  { "path": "/pups/images/", "url": "https://alice.pups.test/pups/images/",
    "properties": ["https://bigwide.net/ns/avatar"], "url_properties": ["https://bigwide.net/ns/avatar"] }
]
```

**Private paths.** The list contains no paths in `/pups/private/`; they are defined by the specs that use them, e.g. an inbox that several apps read. Declare them with `path` only, a file or a directory strictly inside `/pups/private/`, e.g. `{ "path": "/pups/private/inbox/" }`. They are never linked and have no public URL, so the server refuses to start if such an entry has `url`, `rels`, `properties`, `link_properties`, `single_rels` or `url_properties`. Apps request them with `read:/pups/private/inbox/` or `write:/pups/private/inbox/`, in the consent screen's group "non-public content".

`path`, `url`, `rels`, `properties` and `link_properties` (properties apps may set on their links) are published in the configuration document. `single_rels` (rels that allow only one link) and `url_properties` (properties whose value must be the URL of one of the app's files) stay on the server. On startup the server rejects what RFC-6 forbids: directories under `/.well-known/`, `host-meta`, `webfinger`, `acme-challenge/` and similar files, anything under `/appdata/`, and paths that overlap the server's endpoints (`/oauth/`, `/pups/` except `/pups/images/`, `/pups/pages/` and paths inside `/pups/private/`, `/personal-storage.json`).

## Differences from the RFC

The server implements the protocol as an app sees it. As a test server, it simplifies the owner side:

- **Same-domain mode only, password only.** There are no passkeys, no auth subdomain and no sessions, not even the page session RFC-6 allows (owner.js asks for one, and gets none). The server never sets a cookie. Every owner action (approving an app, viewing the apps page, removing an app, a link or a property, replacing the signing key) needs the password in the same request, which also covers step-up confirmation. Failed attempts are rate-limited: after 5 in 15 minutes, one per minute.
- **No setup page.** The password comes from `PUPS_PASSWORD` instead of a first-run setup with a bootstrap secret.
- **No storage quota and no write rate limit.** The server doesn't record which grant wrote which file. Revocation can delete an app's whole `/appdata/<app>/` folder instead.
- **No consent shortcut.** The consent screen is always shown, even if an existing grant already covers the request.
- **One process.** State lives in memory and is written to `state.json` after every change. Requests are handled one at a time, which makes code redemption, refresh-token rotation and ETag checks atomic. Don't run two servers on the same data directory.

Everything else follows RFC-6 and behaves like the Cloudflare implementation, including the refresh-token grace period.

## Code

Layout:

| File | Contents |
| --- | --- |
| `server.ts` | Entry point: reads the configuration, starts the server. |
| `controller.ts` | `createApp()` (the Express app) and `startServer()` (HTTP/HTTPS, loopback filter). |
| `handler/discovery.ts` | `host-meta.json`, configuration document, RFC 8414 metadata, start page. |
| `handler/oauth.ts` | Authorization endpoint with consent screen, token (including the RFC-10 token exchange) and revocation endpoints, JWK Set. |
| `handler/files.ts` | Upload API, POST fallback, public and fresh reads with the sandbox headers. |
| `handler/hostmeta.ts` | `host_meta_endpoint` and the cleanup after revocation. |
| `handler/admin.ts` | The apps page: grants, and the links and properties of `host-meta.json`. |
| `lib/config.ts` | Configuration and well-known path rules. |
| `lib/state.ts` | The JSON state: codes, grants, tokens, refresh rotation with reuse detection and grace period. |
| `lib/storage.ts` | Files on disk: atomic writes, content-hash ETags, no symlinks out of the root. |
| `lib/cimd.ts` | Client metadata documents: fetch with SSRF protection, validation, cache. |
| `lib/paths.ts`, `lib/filetypes.ts` | Path, scope and file type rules. |
| `lib/owner.ts` | Password check. |
| `lib/html.ts` | Sends the owner pages from pups-ui and serves `/pups/assets/`. |

The owner pages (consent screen, apps page, error pages), their stylesheet and script, and the sanitizer for untrusted values come from [pups-ui](../lib/pups-ui), which the Cloudflare and Bunny servers use too. It is a local package in this repository (`"pups-ui": "file:../lib/pups-ui"`).
| `lib/log.ts` | Request and event log. |

```sh
npm test            # end-to-end tests of the whole protocol (jest + supertest) and unit tests
npm run typecheck
```

The tests in `test/flow.test.ts` run every flow against the Express app, with a fake network for client metadata documents: discovery, consent, PKCE, code reuse, refresh rotation, the grace period and reuse detection, revocation, scope enforcement, ETag preconditions, path and type rules, serving headers, the POST fallback, `host-meta.json` editing, the apps page, and persistence across restarts.
