# PUPS for Cloudflare Workers

Reference implementation of the **Personal Upload Server** ([RFC-6](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md), `spec_version` 0.1) as a single Cloudflare Worker. It lets apps upload files to your own domain: an app only needs your domain name, asks for permission with OAuth 2.1 + PKCE, and gets a token that can write the paths you approved. Everything uploaded is public, except the private areas.

- **Worker** (TypeScript): discovery, OAuth authorization server, upload API, owner pages.
- **R2** bucket `FILES`: uploaded files, `/.well-known/host-meta.json` and your inbox.
- **Durable Object** `PupsStore` (SQLite): owner credentials, grants, hashed tokens, codes, sessions, rate limits, the locks of kept feeds, the homepage setting, webmentions waiting to be checked and comment status pages.
- **Static assets** from the shared package [pups-ui](../lib/pups-ui) (`node_modules/pups-ui/public/`): the stylesheet and script of the owner pages.

**The owner pages come from [pups-ui](../lib/pups-ui)**, a package shared with the Bunny implementation: their HTML, `owner.css`, `owner.js`, the sanitizer, and webpup, the homepage. **The receiver comes from [pups-inbox](../lib/pups-inbox)** and **kept feeds from [pups-feeds](../lib/pups-feeds)**, also shared with Bunny. All three are local dependencies in this repository (`file:../lib/pups-ui`, …). The Deploy to Cloudflare button copies only this folder, so it can't build the Worker until they are published.

## Deploy

### With the Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bigwide-net/PUPS/tree/main/pups-cloudflare)

The button copies this repository to your GitHub account, provisions the Worker, the R2 bucket and the Durable Object, and asks for `BOOTSTRAP_SECRET`. Set `OWNER_HOST` to your domain in the variables it shows.

### With Wrangler

```sh
npm install
npx wrangler r2 bucket create pups-files      # any name; if you choose another one, put it into bucket_name
                                             # of the FILES binding in wrangler.jsonc (don't add a binding)
npx wrangler secret put BOOTSTRAP_SECRET     # a long random value, e.g. `openssl rand -base64 32`
# set OWNER_HOST (and optionally AUTH_HOST) in wrangler.jsonc
npx wrangler deploy
```

To keep your settings out of a clone you pull updates into, copy `wrangler.jsonc` to `wrangler.local.jsonc` (ignored by git), put your settings there, and deploy with `npx wrangler deploy -c wrangler.local.jsonc`. When an update changes `wrangler.jsonc`, carry the change over to your copy.

Then:

1. **Attach your domain** to the Worker as a custom domain (Workers → your Worker → Settings → Domains & Routes). Your DNS has to be on Cloudflare. If your domain already serves a website, attach the Worker to routes instead (`tim.example.com/.well-known/*`, `/files/*`, `/oauth/*`, `/pups/*`, `/personal-storage.json`, and `/feed.json` and `/feed/*` unless you leave them out, see [Well-known paths](#well-known-paths)), or set `ORIGIN_FALLBACK` to `true` so unknown paths go through to your origin.
2. **Open `https://<your domain>/pups/setup`**, enter the bootstrap secret, and register a passkey (preferred) or a password. Setup works once; after that the page returns 404.
3. **Check discovery**: `https://<your domain>/.well-known/host-meta.json` should link to `https://<your domain>/personal-storage.json`.
4. **Manage apps** at `/pups/apps` and change your password at `/pups/password`.

## Owner pages

| Page | What it does |
| --- | --- |
| `/pups/` | The start page: links to the other pages, and what your homepage is. `/` forwards here while your domain has no homepage. |
| `/pups/setup` | First-run setup with the bootstrap secret: register a passkey and/or a password. Gone after setup. |
| `/pups/apps` | The apps that can write to your domain, with their permissions and last use. **Remove** ends an app's access at once; **Remove and delete its files** also deletes its `/appdata/<app>/` folder. Also lists the links and properties in `host-meta.json`, each removable, and how many mentions are in your inbox. |
| `/pups/homepage` | Install webpup as the homepage of your domain, choose its theme and the theme browser, or remove it (see [Homepage](#homepage)). |
| `/pups/comment-settings` | *Comments*, with comments on: how many comments wait in your inbox, and the settings of auto-moderation. |
| `/pups/password` | Change the password, or set one as a fallback if you log in with a passkey. In auth subdomain mode this logs out every other session. |
| `/pups/login` | Auth subdomain mode only. |
| `/oauth/authorize` | The consent screen apps send you to. |

The pages are plain semantic HTML: `header` with `nav`, `main`, `section`s, `form`s with `fieldset`/`legend`/`label`, `table`s with `th scope`, and `p role="alert" | "status" | "note"` for messages. They have no classes and no inline styles, so all styling goes into **`owner.css`** in pups-ui (`public/pups/assets/owner.css`), together with the HTML of the pages (`src/`). A comment at the top of that file describes the structure; its rules are only a readable baseline. The Content-Security-Policy allows stylesheets and scripts from the server's own origin only.

Every change (removing an app, a link or a property, changing the password) needs a fresh confirmation in the same request, in both modes. The confirmation fieldset has a password field. If you have a passkey, `owner.js` (in pups-ui) asks for it when you submit the form with an empty password field. Without JavaScript, the forms work with the password.

### Auth subdomain mode (recommended if your domain runs web applications)

Set `AUTH_HOST` to e.g. `id.tim.example.com` and attach that host to the same Worker as a second custom domain. The OAuth endpoints and owner pages then live on that host, isolated by the browser's same-origin policy from any script on your main domain. Only the issuer and the endpoint URLs change; your identity (`me`) stays `https://tim.example.com/`. In this mode the owner gets a 30-day `__Host-` session cookie. In same-domain mode the server never sets a cookie, so you confirm every owner action with your passkey or password.

## Configuration

All settings are `vars` in `wrangler.jsonc`, plus one secret.

| Name | Default | Meaning |
| --- | --- | --- |
| `BOOTSTRAP_SECRET` (secret) | — | Single-use secret that protects `/pups/setup`. At least 16 characters. |
| `OWNER_HOST` | request host | Your domain, e.g. `tim.example.com`. It is your identity (`me`). Set it in production. |
| `AUTH_HOST` | — | Optional auth subdomain, e.g. `id.tim.example.com`. Requires `OWNER_HOST`. |
| `PUBLIC_BASE` | `https://<OWNER_HOST>/files/` | Base URL for public reads, e.g. a CDN. It should stay on your own host, see RFC-6 "Public URLs". It must be served by this Worker, or by a CDN that pulls through it, never directly by a public R2 bucket (see [Private areas](#private-areas)); an `r2.dev` URL is rejected. |
| `MAX_UPLOAD_BYTES` | `26214400` | Largest accepted file. |
| `MAX_STORAGE_BYTES` | `0` (unlimited) | Overall quota; writes above it get `507`. |
| `WRITES_PER_MINUTE` | `120` | Write rate limit per grant (`429` above it). `0` disables it. |
| `WELL_KNOWN_PATHS` | the RFC-6 list | JSON array of declared well-known paths, see below. |
| `POST_FALLBACK` | `false` | Declares `post_endpoint`. Workers accept PUT and DELETE, so this only helps you test clients' POST fallback. |
| `ORIGIN_FALLBACK` | `false` | Forward unknown paths to the origin (Worker on routes in front of an existing site). |
| `MENTIONS` | `true` | Receive mentions of your domain (RFC-11) at `/pups/mention`, see [Inbox](#inbox). |
| `COMMENTS` | `true` | Receive comments on your feeds (RFC-4) at `/pups/comments`. |
| `WEBPUP_OWNER_LINK` | `true` | `false`: webpup without the link to the owner pages at the bottom of the page. |
| `DEV_ALLOW_HTTP` | `false` | Local development only: accept plain HTTP (`wrangler dev`). |

### Well-known paths

By default the server declares every path of RFC-6's list of well-known paths, all at the domain root:

| Path | Contents | Consent screen |
| --- | --- | --- |
| `/.well-known/following.opml` | People you follow (FollowSpec) | the list of people you follow |
| `/.well-known/about.md` | Your profile (AboutSpec); may set the properties `https://bigwide.net/ns/name`, `…/title`, `…/summary`, `…/theme-color` and `…/language` | your profile |
| `/.well-known/contact.vcf` | Your contact details (ContactSpec) | your contact details |
| `/feed.json` | Your main feed (JSON Feed); may register feeds with the rel `https://bigwide.net/ns/feed` | your feed |
| `/feed/` | The files of your main feed (media, older pages) and your other feeds; may register feeds with the rel `https://bigwide.net/ns/feed` | the files of your feed, and your other feeds |
| `/pups/images/` | Your site's profile images; may set the properties `https://bigwide.net/ns/avatar` and `…/banner`, to the URL of an image in `/pups/images/` | your site's profile images |
| `/pups/pages/` | Your site's pages and footer (Markdown); may register pages with the rel `https://bigwide.net/ns/webpup-pages` and the link property `…/webpup-hidden`, and set the property `…/webpup-footer` to the URL of a file in `/pups/pages/` | your site's pages |

Like all uploads, these files are stored in R2 under `/files/` (e.g. `/files/pups/images/avatar.png`) and are also served at their URL at the domain root (`/pups/images/avatar.png`, `/pups/pages/now.md`). No route of the server is under `/pups/images/` or `/pups/pages/`, and they are the only directories under `/pups/` that can be declared, besides paths inside `/pups/private/` (see [Private areas](#private-areas)).

If your website already serves one of these paths (WordPress serves its RSS feed at `/feed/`), leave it out: set `WELL_KNOWN_PATHS` to the entries you want. With `ORIGIN_FALLBACK`, a declared file that no app has uploaded yet is fetched from your origin. Even then, the first app that writes the path replaces what your website served there. Example:

```json
[
  { "path": "/.well-known/about.md", "url": "https://tim.example.com/.well-known/about.md",
    "properties": ["https://bigwide.net/ns/name"], "description": "your profile" },
  { "path": "/feed.json", "url": "https://tim.example.com/feed.json", "rels": ["https://bigwide.net/ns/feed"], "description": "your feed" }
]
```

`path`, `url`, `rels`, `properties` and `link_properties` (properties apps may set on their links) are published in the configuration document. `description` (how the details on the consent screen name the path), `single_rels` (rels that allow only one link) and `url_properties` (properties whose value must be the URL of one of the app's files) stay on the server, as RFC-6 describes under "Server-side rules from the list". The rules are checked on startup: under `/.well-known/` only single files can be declared, and never `host-meta(.json)`, `webfinger`, `oauth-authorization-server`, `acme-challenge/` and similar files.

### Private areas

Two areas hold files that only the owner's apps can read (RFC-6 "Private areas"):

- `/appdata/<client-host>/private/`: an app's own private data, read and written with the app's scope `write:/appdata/<client-host>/`.
- `/pups/private/`: private files that an extension of RFC-6 defines, e.g. an inbox in `/pups/private/inbox/`. The default list declares none. To offer one, add it to `WELL_KNOWN_PATHS` with `path` (and optionally `description`) only: `url`, `rels`, `properties`, `link_properties` and `url_properties` are rejected, because private files are never linked. Apps request it with `write:<path>` (read and write) or `read:<path>` (read only); both are in the consent group "non-public content" and need step-up.

  ```json
  { "path": "/pups/private/inbox/", "description": "your inbox" }
  ```

Private files are read at `/files/<path>` with a bearer token whose scope covers them. Without a token the answer is `401` (`WWW-Authenticate: Bearer`), with an invalid one `401`, with a token that doesn't cover the path `403`, and only then `404` for a missing file. Every response for a private path carries `Cache-Control: no-store` (`private, no-store` with the file) and `Vary: Authorization`. The same rules apply at every other URL that maps to a file (`PUBLIC_BASE` on your domain, well-known URLs), and `ORIGIN_FALLBACK` never forwards a private path to your origin. Private files can't be linked or used as property values in `host-meta.json`.

**Storage.** Private files are in the same R2 bucket as all other files, under `appdata/<host>/private/` and `pups/private/`. That is safe only as long as nothing serves the bucket without the Worker: **don't enable public access** (`r2.dev` or a custom domain on the bucket), and don't point `PUBLIC_BASE` at one. A CDN in front of `PUBLIC_BASE` must pull from the Worker, and should bypass its cache for both private areas if it doesn't honour `no-store` or `Vary`. "Private" means hidden from the public, not encrypted: whoever has access to your Cloudflare account can read the files.

## Feeds

The Worker keeps your feeds ([RFC-7](https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md)), as the PHP and Bunny versions do ([pups-feeds](../lib/pups-feeds)): every feed file in `/feed.json` or `/feed/<name>.json` that carries `"_pups": { "pupsControlled": true }`. Apps send posts one at a time, with `POST` of a JSON Feed item to the feed file at `/files/…`, and the Worker does the rest: it gives each post its index and, with webpup, the URL of its page, puts it into the archives `feed.000000.json`, `feed.000001.json`, … in the feed directory, 20 posts each ([RFC-13](https://github.com/bigwide-net/RFCs/blob/main/RFC-13-JSON-Feed-Archives.md)), and writes the feed file with the newest 30. Edits and deletes work the same way. Apps may also `PUT` the feed file, e.g. to change its title: the Worker compares its items with the ones it had, and adds, changes or deletes posts accordingly. Apps can't write the archives (`403`). The configuration document says `"kept_feeds": true`.

Every write of a feed file or its archives runs under a lock in the Durable Object, so posts from several apps at the same time never get lost or share an index. The archives are written first and the feed file last. A feed made by hand or with another tool stays an ordinary file until it gets the `_pups` marker; then its posts go into archives on the next write.

## Inbox

The Worker has a small built-in receiver, the same as the PHP and Bunny implementations ([pups-inbox](../lib/pups-inbox)). It puts what other sites send you into your **inbox**, a private JSON Feed at `/pups/private/inbox.json` ([RFC-12](https://github.com/bigwide-net/RFCs/blob/main/RFC-12-Inbox-Feeds.md)). Your feed reader shows it if it supports inboxes and you allow it to read `read:/pups/private/inbox.json`. The path is declared automatically while the receiver is on. Nothing has to be set up; `MENTIONS` and `COMMENTS` turn the two parts off.

- **Mentions** ([RFC-11](https://github.com/bigwide-net/RFCs/blob/main/RFC-11-Mentions.md)): other sites send a webmention to `/pups/mention` when a post names `@yourdomain` or replies to one of your posts. The generated `host-meta.json` links it (rel `https://bigwide.net/ns/mention`); a stored `host-meta.json` gets the link once, and if you remove it, it stays removed. The configuration document says `mention_endpoint`.
- **Comments** ([RFC-4](https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md)) on your feeds, if a feed names `/pups/comments` in `_submissions.url` (`comment_endpoint` in the configuration document). They are checked against the feed's rules and land in your inbox. In a kept feed with `republish: "full"` or `"summary"`, *Publish Comment* publishes one in the comment feed of the post or comment it answers (`/feed/comments/<index>.json`, RFC-7 "Publishing comments"). `/pups/comments/status/s-…` tells the sender how it went.
- **Auto-moderation**, off by default. On the page *Comments* (`/pups/comment-settings`) you can enter the API key of an OpenAI-compatible chat API (OpenRouter by default, model `openai/gpt-5-nano`; both can be changed), your own criteria, a threshold (90 % by default) and a daily limit of tokens in thousands (500 by default, at most 10,000). A model then rates each comment against general rules (spam, scams, illegal and adult content, abuse, personal data) and your criteria; comments rated at least as likely acceptable as the threshold are published at once, all others wait in your inbox with the rating. If the API fails or the day's tokens are used up, comments simply wait in your inbox. Your own comments, from a feed on your domain, are always published at once.
- Webmentions are answered at once (`202`, or `201` for comments) and checked after the response, with `waitUntil()`: the Worker fetches the post (1 MB, 10 s, 3 redirects; `global_fetch_strictly_public` keeps it on public addresses), and puts it into the inbox if it really names you or replies to you. At most 100 webmentions wait, 5 per site (`429` beyond). Each request checks at most 4, which keeps it under the 50 subrequests a request may make on the free plan; the next webmention picks up the rest.
- **Limits.** The inbox holds 100 items, 10 per site. Mentions make room for new ones after 30 days or when the inbox is full; comments are never dropped, a comment that doesn't fit is refused.
- **Dismiss.** Every item has an RFC-9 action that removes it (`/pups/inbox/action`, with a key only your inbox contains), and a link to a page that asks first (`/pups/inbox/dismiss`) for readers without actions.

## Homepage

On the page *Homepage* (`/pups/homepage`) you can make **webpup** the homepage of your domain: a single-page website that shows your profile, posts and pages from the files your apps write. Choose one of its themes, and whether visitors can try all themes (the theme browser). **Remove webpup** turns it off again, and `/` forwards to the owner pages.

- webpup's files come with the Worker (from pups-ui); nothing is copied to R2. `/` and webpup's pretty URLs (`/p/about`, `/p/feed/photos`, …) serve its `index.html`; `/webpups.js`, `/webpup.css`, `/theme.css`, `/webpup-themes/…` and `/webpup-config.json` (with `settings-url` and `owner-link`) the rest. They are revalidated on every request (`no-cache` with an ETag).
- **Post pages.** Every post has a page of its own, e.g. `/p/feed/post/47`. While webpup is installed, `host-meta.json` declares these URLs with the site property `https://bigwide.net/ns/post-url-template` (`https://tim.example.com/p/{feed}/post/{index}`), so apps link new posts to their page (RFC-7). Removing webpup removes the property, unless you changed it.
- With `ORIGIN_FALLBACK`, your existing website keeps `/`, and the page *Homepage* says so. On a route setup, add `/` and `/p/*` and webpup's files to the Worker's routes if you want webpup.

## Endpoints

| Host | Path | Purpose | CORS |
| --- | --- | --- | --- |
| owner | `/.well-known/host-meta.json` | Discovery (stored file, or a generated one with the PUPS link) | yes |
| owner | `/personal-storage.json` | Configuration document | yes |
| owner | `/files/<path>` | Upload API (`PUT`, `DELETE`), public reads (`GET`, `HEAD`, ranges, conditional requests), fresh reads (the same with a token) and private reads; `POST` of an item to a feed file (see [Feeds](#feeds)) | yes |
| owner | `/.well-known/about.md`, `/feed.json`, `/feed/…`, `/pups/images/…`, `/pups/pages/…` etc. | Declared well-known files at their own URL | yes |
| owner | `/pups/host-meta` | `host_meta_endpoint`: apps add, change, order and remove links and set properties | yes |
| owner | `/pups/post` | `post_endpoint` (only with `POST_FALLBACK`) | yes |
| owner | `/pups/mention`, `/pups/comments`, `/pups/comments/status/s-…` | The receiver: webmentions, comments and their status (see [Inbox](#inbox)) | yes |
| owner | `/pups/inbox/action` | Dismissing inbox items (RFC-9 action) | yes |
| owner | `/pups/inbox/dismiss` | The page that asks before dismissing an item | no |
| owner | `/`, `/p/…`, `/index.html`, `/webpups.js`, `/webpup.css`, `/theme.css`, `/webpup-config.json`, `/webpup-themes/…` | webpup while it is installed; otherwise `/` forwards to `/pups/` | no |
| auth | `/.well-known/oauth-authorization-server` | RFC 8414 metadata | yes |
| auth | `/oauth/authorize` | Authorization and consent | no |
| auth | `/oauth/token`, `/oauth/revoke` | Token and revocation endpoints | yes |
| auth | `/pups/`, `/pups/setup`, `/pups/login`, `/pups/logout`, `/pups/apps`, `/pups/homepage`, `/pups/password` | Owner pages | no |
| auth | `/pups/assets/themes/<id>.jpg` | Theme thumbnails for the page *Homepage* | no |
| any | `/pups/assets/owner.css`, `/pups/assets/owner.js` | Static assets of the owner pages (from pups-ui) | no |

In same-domain mode, "owner" and "auth" are the same host.

## How it maps to RFC-6

- **OAuth is implemented by hand** (`src/oauth.ts`, `src/store.ts`) instead of with `@cloudflare/workers-oauth-provider`, because RFC-6 requires behaviour that library doesn't offer or does differently: revoking every token when a code is redeemed twice, strict refresh-token reuse detection (the library keeps the previous refresh token valid), `me` in every token response, and its own CIMD rules for `client_uri`/`logo_uri`, loopback redirects and scope validation. The PHP drop-in has to implement the same logic by hand anyway.
- **Refresh grace period**: the refresh token replaced last stays usable for 2 minutes (`REFRESH_GRACE` in `src/store.ts`; RFC-6 allows 60 seconds to 5 minutes) as long as neither the new refresh token nor the new access token has been used. A retry in that window gets a fresh pair, and the unused pair is revoked without revoking the grant. Any other reuse of a replaced token revokes the grant. Each grant records its current refresh token, the one it replaced, when, the access token issued with the current one, and whether anything issued by that refresh has been used. The window counts from the first refresh with the replaced token, so repeated retries don't extend it.
- **One SQLite Durable Object instead of KV.** KV is eventually consistent, so it can't make codes single-use or detect a reused refresh token. Each Durable Object method runs synchronously against SQLite, so redemption and rotation are atomic.
- **CIMD fetch (SSRF)**: the `global_fetch_strictly_public` compatibility flag makes the runtime refuse non-public addresses after DNS resolution. On top of that the server rejects IP literals, `localhost` and its own hosts, redirects, responses over 64 KB and fetches slower than 5 seconds. Documents are cached for at most 24 hours, and only if `Cache-Control: max-age` allows it.
- **ETags**: R2 evaluates `If-Match` and `If-None-Match: *` atomically with the write. An unconditional `PUT` of an existing file is made conditional on the ETag the server just read, so the storage quota stays exact. Under a concurrent write it can therefore get `412`.
- **Dot segments in upload URLs** (`/files/a/../b`) are resolved by the URL parser before the Worker sees them, so the request is handled as one for the resolved path, as RFC-6 "Paths" allows. In the POST fallback's `path` parameter they get `400`.
- **Serving**: every file is served with the type of its extension, `nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: no-cache` and CORS. Requests with `Service-Worker: script` get `403`.
- **Fresh reads**: a `GET` or `HEAD` at `/files/` with `Authorization: Bearer` accepts any valid access token, `identify`-only included (no scope check for public files; private files need a covering `write:` or `read:` scope, see [Private areas](#private-areas)), and is authenticated like a write, so it counts as use of the token for the refresh grace period. An invalid, expired or revoked token gets `401`, never a public read. The response has `Cache-Control: private, no-store`; reads at `/files/` without a token carry `Vary: Authorization`. Every read comes from R2, which is strongly consistent: the Worker uses no Cache API, `cacheTtl` or static assets for files, and Cloudflare's zone cache runs behind the Worker, so a read reflects every completed write.
- **Passkeys** use `@simplewebauthn/server`. The relying party ID is the owner's domain, so one passkey keeps working when you add an auth subdomain under it. The browser code is the single script `/pups/assets/owner.js`; owner pages allow no inline scripts.
- **Loopback redirect URIs** (`http://127.0.0.1/…`, `http://[::1]/…`) are accepted for any app, with any port. The consent screen then notes that the app runs on this computer.
- **Same-domain mode** never sets a cookie: the consent form, the apps page and every action carry a passkey assertion or the password. The authorization request travels through the consent form as an HMAC-signed field that can be approved only once.
- **Revocation** cleans up `host-meta.json` once an app has no active grant left: its `/appdata/` links are removed, and its well-known links lose the ownership marker and become yours.

## Untrusted input

Client metadata documents, scopes, paths, form fields, headers and `host-meta.json` all come from outside. The rules follow Downread's sanitizer (`shared/src/utils/sanitize.ts`):

- **Encoding.** Every value written into an HTML page is HTML-encoded, in element content and in double-quoted attributes. Pages contain no inline script; JSON for the page script is embedded with `<` escaped.
- **Sanitizing self-declared text.** `client_name` is shown with control characters, invisible characters (zero-width spaces, direction marks, bidi embeddings, overrides and isolates, word joiners, BOM) and the specials block removed, whitespace collapsed, at most 100 characters, and inside `<bdi>`, so it can't reorder the text around it. Zero-width joiners stay, for emoji and scripts that need them.
- **Values shown exactly** (paths, scopes, client IDs, rels, error messages) are not altered. Instead, invisible characters are shown as `\u{202e}`, so a spoofing attempt stays visible.
- **Rejected outright:** invisible characters in paths, scopes, rels and `host-meta.json` values (stricter than RFC-6, which names only control characters: they could disguise a file name); `client_id` and redirect URI hosts that aren't plain DNS names (the URL parser accepts `;` and `'` in host names); `logo_uri`, `client_uri` and redirect URIs with whitespace or invisible characters. Stored URLs are in canonical form (`new URL().href`).
- **Headers.** Only plain origins enter the consent page's `Content-Security-Policy`.
- **Size limits.** Every string read in has one, and values over it are rejected (`400`), never cut:

  | Input | Limit |
  | --- | --- |
  | URLs: `client_id`, `redirect_uri`, `return_to`, hrefs, `logo_uri`, `client_uri` | 2048 characters |
  | `scope` | 2048 characters, 20 scopes |
  | `state` | 1024 characters |
  | Codes, access and refresh tokens | 256 characters (`code_verifier`: 128) |
  | Passwords | 1024 characters |
  | Signed form fields, passkey responses | 16384 characters |
  | Headers read (`Authorization`, `If-Match`, `If-None-Match`, `Content-Type`, `Cookie`) | 4096 characters |
  | Paths | 512 bytes decoded, 1536 characters encoded |
  | Any other form field or query parameter | 256 characters; at most 1000 per form |
  | Form bodies | 64 KB |
  | Client metadata documents | 64 KB; `client_name` 1000 characters (100 shown); 20 redirect URIs |
  | `host_meta_endpoint` bodies | 16 KB; `rel` and `property` 512, `value` 2048, `type` 255 characters |
  | `host-meta.json` read for changes | 1 MB |
  | Uploads | `max_upload_bytes` |

  Oversized values on owner pages get an HTML error page; API endpoints answer with JSON.


## Known limitations

- **Passkeys can only be registered at setup.** You can change or set the password later, but not add or remove a passkey.
- **The Cloudflare Access login option** from the implementation brief is not implemented.
- **`DELETE` with `If-Match`** is a check followed by a delete, because R2 deletes take no conditions. A concurrent change between the two is not detected.
- **No CDN purge.** Files are served with `Cache-Control: no-cache`; if you put a CDN in front of `PUBLIC_BASE`, purge it yourself.

## Development

```sh
npm test            # unit and end-to-end tests inside the Workers runtime (vitest + @cloudflare/vitest-plugin)
npm run typecheck
npx wrangler dev    # with DEV_ALLOW_HTTP=true and BOOTSTRAP_SECRET in .dev.vars
```

The end-to-end tests (`test/flow.test.ts`, `test/owner.test.ts`, `test/subdomain.test.ts`) run the full flow against the Worker, with a mocked network for client metadata documents: discovery, consent, loopback redirects, PKCE, code reuse, refresh-token rotation, the grace period and reuse detection, revocation, scope enforcement, ETag preconditions, path and type rules, serving headers, the POST fallback, `host-meta.json` editing, the apps and password pages, and auth subdomain mode. `test/receiver.test.ts` covers the receiver and the homepage on the Worker, `test/feeds.test.ts` kept feeds, including concurrent posts; the detailed tests are in pups-inbox and pups-feeds. They cover most of the RFC-6 conformance list, but they are not the standalone conformance runner the RFC describes, which takes a base URL.
