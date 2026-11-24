# PUPS for PHP

A **Personal Upload Server** ([RFC-6](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md), `spec_version` 0.1) for ordinary shared web hosting. It lets apps upload files to your own domain: an app only needs your domain name, asks for permission with OAuth 2.1 + PKCE, and gets a token that can write the paths you approved. Everything uploaded is public, except in the [private areas](#private-areas).

It needs **PHP 8.1 or later with the openssl extension** and a web server that reads `.htaccess` files (Apache or LiteSpeed, which is what cheap hosting plans run). There is no database, no Composer and no build step: you upload a folder. All data is in JSON files and plain files.

It implements the same protocol as the [Cloudflare Worker](../pups-cloudflare) and the [Node test server](../pups-server):

- discovery (`host-meta.json`, the configuration document, RFC 8414 metadata);
- OAuth 2.1 with PKCE and Client ID Metadata Documents;
- the upload API with ETags, quota and rate limit, and the POST fallback for hosts that block `PUT` and `DELETE`;
- `host-meta.json` editing;
- owner pages:
  - setup with a one-time secret;
  - passkeys and password;
  - apps, with the links and properties of `host-meta.json`;
  - a server page with environment checks and the log;
- a homepage for your domain: [webpup](../webpup), installed from the owner pages with a theme of your choice.

## Install on shared hosting

These steps work on any host with PHP and `.htaccess`, such as Namecheap, Hostinger, IONOS, Strato, all-inkl or DreamHost. The names of the menu items differ from host to host.

1. **Pick the domain.** PUPS works best on a domain or subdomain of its own, e.g. `me.example.com`. Your apps will know you by it. In cPanel this is *Domains* or *Subdomains*; in hPanel, *Domains → Subdomains*. Give it its own folder (document root), e.g. `me.example.com/`.
   - You can also install PUPS in a folder of an existing website, e.g. `example.com/pups/`. See [Installing in a folder](#installing-in-a-folder).
   - Don't install PUPS on a domain that also runs other web applications, such as WordPress, a wiki or a forum. They share the origin of the owner pages, so a security hole in any of them puts your login at risk. With that login someone could sign in as you wherever you use your domain. Static files are fine.
2. **Turn on HTTPS** for that domain. Most hosts issue a free certificate automatically, e.g. through *SSL/TLS Status*, *AutoSSL* or *Let's Encrypt*.
3. **Choose PHP 8.1 or later** for it, e.g. in *Select PHP Version*, *MultiPHP Manager* or *PHP Configuration*.
4. **Upload the contents of the folder `pups/`** into the domain's folder, with the hosting file manager or FTP. To get it, download this repository (on GitHub: *Code → Download ZIP*) and unpack it. `pups/` holds everything the server needs and nothing else: `.htaccess`, `index.php`, `controller.php`, `config.example.php` and the folders `assets/`, `handler/`, `lib/` and `webpup/`. Include `.htaccess`: some FTP clients hide files that start with a dot. From a clone, `scripts/make-zip.sh` packs these files into `pups-php.zip`; most hosting file managers can unpack a zip on the server.
5. **Create `config.php`.** Copy `config.example.php` to `config.php` and set two values:
   - `origin`: your domain as `https://me.example.com`;
   - `setup_secret`: a long random value. Generate one with `openssl rand -base64 32` or a password manager.
6. **Open `https://me.example.com/pups/setup`.**
   - The page runs its checks: PHP version, HTTPS, the data folder, whether the `Authorization` header and the `PUT` and `DELETE` methods reach PHP, and whether discovery works. Fix what it reports as a problem.
   - Then enter the setup secret, and register a passkey or choose a password, or both. Setup works once; after that the page is gone.
7. **Check discovery.** `https://me.example.com/.well-known/host-meta.json` must link to `https://me.example.com/personal-storage.json`. The setup page checks this too.

That's it. In an app that supports PUPS, enter `me.example.com`.

Your owner pages start at `https://me.example.com/pups/`. While your domain has no homepage, `https://me.example.com/` forwards there. To give it one, install webpup on the page *Homepage* (`/pups/homepage`), see [Homepage](#homepage).

**Optional:** move the data folder out of the web root. PUPS keeps everything in `data/` next to `index.php`, protected by `.htaccess`. If your host lets you create folders outside the web root (usually next to `public_html`), that is safer: set `'data_dir' => __DIR__ . '/../pups-data'` in `config.php`. PUPS creates the folder. The checks on the setup page tell you whether your host allows it, and give you the exact line.

**Updating:** upload the contents of the new `pups/` folder over the old files. Your `config.php` and `data/` aren't part of the download, so they stay. So does an installed webpup: if the new PUPS comes with another version of it, the page *Homepage* says so, and **Save** installs it.

### When something doesn't work

| Symptom | Cause and fix |
| --- | --- |
| The host's 404 page for `/pups/setup` | `.htaccess` is not used: it wasn't uploaded, or the host doesn't allow it (`AllowOverride`), or `mod_rewrite` is off. With nginx, see [nginx](#nginx). |
| "PUPS is not configured correctly" | `config.php` is missing or has an error; the message says which. |
| "PUPS needs PHP 8.1 or later" | Choose a newer PHP version for the domain. |
| Check "Authorization header" fails | The web server drops the header before PHP sees it. The `.htaccess` rule that passes it on needs `mod_rewrite`. Ask the host to enable `CGIPassAuth On` for your folder. |
| Check "PUT and DELETE" warns | A firewall at the host blocks them. Nothing to do: PUPS tells apps to send writes through POST instead (`post_endpoint`). Uploads are then limited by PHP's `post_max_size`; the check says how large. |
| Check "Self-test" warns | The server can't connect to its own domain, so some checks were skipped. Everything else may still work. |
| Check "Discovery" fails, in a folder installation | `/.well-known/` requests don't reach PUPS; see [Installing in a folder](#installing-in-a-folder). |

### Installing in a folder

PUPS can live in a folder of an existing website, e.g. `https://example.com/pups/`. Upload the folder `pups/` itself into the website's document root, instead of its contents:

- the endpoints are under `/pups/`;
- `storage_base` is `https://example.com/pups/`, so an app's files are at `https://example.com/pups/appdata/<app>/…`;
- the owner pages are at `/pups/pups/`, e.g. `/pups/pups/apps`, and `/pups/` forwards there;
- webpup can't be your homepage: it needs PUPS at the domain root.

Two things must still be at the domain root: `/.well-known/host-meta.json`, and the well-known files such as `/.well-known/about.md`. At the end of setup, PUPS writes a file `.well-known/.htaccess` into the domain's document root that sends these requests to PUPS. Static files that exist there take precedence. So do the folders that hosting providers use to prove domain control for HTTPS certificates (`acme-challenge`, `pki-validation`). If PHP can't write that file, the setup and server pages show its content, for you to upload yourself. The base path is detected from the URL of `index.php`; set `base_path` in `config.php` if that goes wrong.

### nginx

nginx ignores `.htaccess`. Send every request to `index.php`, except the domain validation folders:

```nginx
location ^~ /.well-known/acme-challenge/ { try_files $uri =404; }
location / {
    include fastcgi_params;
    fastcgi_param SCRIPT_FILENAME $document_root/index.php;
    fastcgi_param SCRIPT_NAME /index.php;
    fastcgi_pass unix:/run/php/php-fpm.sock;   # your PHP-FPM socket
}
```

nginx passes the `Authorization` header to PHP-FPM, and `PUT` and `DELETE` too. PHP serves webpup's files then, too. Don't let nginx serve uploads from `data_dir` itself: fresh reads (`GET` with `Authorization`) must reach PHP. Keep `data_dir` outside the web root, since `data/.htaccess` doesn't protect anything here (requests never reach the files directly with this configuration, but a mistake in it would expose them).

## Local setup (macOS)

For testing apps and clients on your own computer. RFC-6 clients only need the user's domain, and they discover it the same way every time: `https://<domain>/.well-known/host-meta.json`. That means **HTTPS on port 443** with a certificate the client trusts. PHP's built-in server speaks plain HTTP only, so [Caddy](https://caddyserver.com) handles TLS in front of it.

```sh
brew install php mkcert caddy
cd pups-php
scripts/setup-local.sh                                    # certificate, pups/config.php, Caddyfile.local
echo '127.0.0.1 alice-php.pups.test' | sudo tee -a /etc/hosts
scripts/serve-local.sh
```

Then open <https://alice-php.pups.test/pups/setup> and enter the setup secret that `setup-local.sh` printed (it's also in `pups/config.php`).

`scripts/setup-local.sh [host name]` does four things:

1. Runs `mkcert -install`. This installs a local certificate authority that your browsers and system trust. It may ask for your password. For Firefox, also `brew install nss`.
2. Creates a certificate for the host name in `certs/`.
3. Creates `pups/config.php` with the origin, a random setup secret and two development settings:
   - `allow_private_clients`: test apps on your computer may be clients, e.g. `https://app.pups.test`, which also resolves to 127.0.0.1;
   - `extra_ca`: mkcert's CA, so that PUPS trusts those apps' certificates.
4. Writes `Caddyfile.local`.

`scripts/serve-local.sh` runs PHP's built-in server on `127.0.0.1:8080`, with 4 workers so that the setup checks can call the server while it answers, and Caddy on port 443. macOS lets normal users open port 443 on all interfaces; on Linux, see the Node server's README. The log goes to the terminal and to `pups/data/pups.log`.

The default host name is `alice-php.pups.test`, so that it doesn't collide with the Node test server's `alice.pups.test`. Only one program can listen on port 443, so stop the Node server first, or give one of them a second loopback address (`127.0.0.2 alice-php.pups.test` in `/etc/hosts`, plus `sudo ifconfig lo0 alias 127.0.0.2` and `bind 127.0.0.2` in the site block of `Caddyfile.local`).

**Plain HTTP:** for quick `curl` tests without TLS, create a `pups/config.php` with `'origin' => 'http://localhost:8080', 'allow_http' => true` and run `PHP_CLI_SERVER_WORKERS=4 php -S 127.0.0.1:8080 -t pups pups/index.php`. RFC-6 clients won't accept it.

## Using it

| URL | What |
| --- | --- |
| `/` | Your homepage: webpup, or an `index.html` of your own in the domain's folder. Without one, it forwards to `/pups/`. |
| `/pups/` | Start page of the owner pages. |
| `/pups/homepage` | **Homepage.** Install webpup, choose its theme and whether visitors see the theme browser, or remove it. |
| `/pups/setup` | First-run setup with the setup secret: checks, then a passkey and/or a password. Gone after setup. |
| `/pups/apps` | **Your apps.** Every grant: the app's domain, its self-declared name, the permissions, when it was approved and last used. **Remove** ends an app's access at once; **Remove and delete its files** also deletes its `/appdata/<app>/` folder. Also lists the links and properties in `host-meta.json`, each removable. With mentions on, it shows how many are in your inbox. |
| `/pups/comment-settings` | **Comments**, with comments on. How many comments wait in your inbox, and the settings of auto-moderation. |
| `/pups/sign-in` | Add and remove passkeys; change or set the password. |
| `/pups/server` | Environment checks, and the last 300 lines of the log. |
| `/.well-known/host-meta.json` | Discovery. If no stored file exists, it is generated with the PUPS link. |
| `/personal-storage.json` | The configuration document. |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata. |
| `/oauth/authorize` | Authorization and consent screen. |
| `/oauth/token`, `/oauth/revoke` | Token and revocation endpoints. |
| `/<path>` | Upload API (`PUT`, `DELETE`) and public reads (`GET`, `HEAD`, ranges, conditional requests) at the domain root, e.g. `/appdata/app.example/feed.json` and `/.well-known/about.md`. With an app's token, `GET` and `HEAD` are fresh reads. `POST` to a feed file adds, changes or deletes an item (see [Feeds](#feeds)). |
| `/pups/host-meta` | `host_meta_endpoint`: apps add, change, remove and order links and set properties. |
| `/pups/post` | `post_endpoint`, if `PUT`/`DELETE` are blocked or `post_fallback` is set. |
| `/pups/probe` | Used by the checks: echoes the method and whether the `Authorization` header arrived. |
| `/p/…`, `/index.html`, `/webpup-config.json`, … | webpup's pages and files, while it is installed. |

**Uploads live at the root of the domain**, as with the Node server: an app's file `/appdata/app.example/logo.svg` is at `https://me.example.com/appdata/app.example/logo.svg`. The server's own routes take precedence: `/`, `/oauth/…`, `/pups/…`, `/personal-storage.json`, webpup's URLs while it is installed (`/p/…` and its files), `/.well-known/host-meta.json` and `/.well-known/oauth-authorization-server`. Uploads can never shadow them: scopes allow writes only in `/appdata/<app>/` and the declared well-known paths, and well-known paths may not overlap these routes. The exceptions are `/pups/images/` and `/pups/pages/`, the declared directories for your site's profile images and pages, and the private paths you declare inside `/pups/private/`: no route of PUPS is in them.

**Every owner action needs a fresh confirmation**, with a passkey or the password: viewing the apps, approving an app, removing one, changing the password. The owner pages share the origin of your domain (same-domain mode), so PUPS never sets a cookie: a script on your website would have no session to abuse. With a passkey, `assets/owner.js` asks for it when you submit a form with an empty password field. Without JavaScript, the forms work with the password. Failed attempts are rate-limited: after 5 in 15 minutes, you wait 1, 2, 4, … minutes.

### Data

Everything is in `data_dir` (default `data/` next to `index.php`):

```
data/
  state.json                      your credentials, grants, hashed tokens and codes, rate limits, signing key
  clients.json                    cached client metadata documents
  detected.json                   what the checks found (POST fallback needed or not)
  pups.log                        the log (rotated to pups.log.1 at 5 MB)
  files/                          uploads; https://<domain>/x is files/x
    appdata/app.example/…         each app's own folder
    .well-known/about.md          declared well-known files
    feed.json, feed/…             your feeds
    pups/images/…                 your site's profile images
    pups/pages/…                  your site's pages and footer (Markdown)
    .well-known/host-meta.json    host-meta.json, if an app or you created it
  .htaccess, files/.htaccess      deny all web access, switch off script handlers
```

You may edit files by hand, including `host-meta.json`; PUPS reads them fresh on every request. `state.json` contains no usable tokens, only SHA-256 hashes, and your password only as an Argon2id or bcrypt hash. To start over, delete `data/`. Then setup runs again, with the same setup secret.

**Concurrency.** PHP handles requests in parallel. Every change of `state.json` holds an exclusive lock (`flock` on `data/state.lock`) and writes a temp file that is then renamed. That makes code redemption, refresh-token rotation and rate limits atomic. Uploads are written to a temp file first; the precondition check (`If-Match`, `If-None-Match`), the quota check and the rename happen under a second lock. The same goes for every change of `host-meta.json`.

### Log

PUPS logs everything it does to `data/pups.log` (and to the terminal with PHP's built-in server), one line per entry:

- every request: method, URL, status, duration, sizes, user agent, and why it failed;
- every confirmation of the owner, with the action (`approve app`, `view apps page`, `remove app`, …), the method (passkey or password), success or failure, and blocked attempts;
- setup steps, password changes, added and removed passkeys;
- client metadata fetches, with the document;
- authorization requests, approvals (requested and granted scope), denials and rejections;
- code exchanges, refreshes (including grace-period retries and reuse that revoked a grant) and revocations;
- every created, replaced and deleted file, with the app, path, size, type, preconditions and ETags;
- `host-meta.json` requests and writes, apps removed by the owner, rate-limited writes, server errors.

```
2026-11-16T09:12:03.120Z login.ok action="approve app" method=passkey clientId=https://downread.com/oauth/client.json
2026-11-16T09:12:03.122Z authorize.approved clientId=https://downread.com/oauth/client.json requested=write:/appdata/downread.com/ granted=write:/appdata/downread.com/ code=Qm1x8kPa redirectUri=http://127.0.0.1:53682/callback
2026-11-16T09:12:05.410Z file.created client=https://downread.com/oauth/client.json grant=… path=/appdata/downread.com/logos/greenheader3.svg bytes=1843 contentType=image/svg+xml ifNoneMatch=* etag="SfSf…" url=https://me.example.com/appdata/downread.com/logos/greenheader3.svg
```

Passwords and tokens are never logged. Codes and tokens appear as a fingerprint: the first 8 characters of their SHA-256 hash, which is also how their key in `state.json` begins. The server page shows the end of the log, so you can read it without FTP.

## Untrusted input

Client metadata documents, scopes, paths, form fields, headers and `host-meta.json` all come from outside. The rules are those of the Node server and the Cloudflare Worker, following Downread's sanitizer:

- **Encoding.** Every value written into an HTML page is HTML-encoded, in element content and in double-quoted attributes (`htmlspecialchars` with `ENT_QUOTES | ENT_SUBSTITUTE`, so invalid UTF-8 can't break out either). Pages contain no inline script; JSON for `owner.js` is embedded with `<`, `>` and `&` escaped.
- **Sanitizing self-declared text.** `client_name` is shown cleaned up:
  - removed: control characters, invisible characters (zero-width spaces, direction marks, bidi embeddings, overrides and isolates, word joiners, BOM) and the specials block;
  - whitespace collapsed, at most 100 characters;
  - inside `<bdi>`, so it can't reorder the text around it.

  Zero-width joiners stay, for emoji and scripts that need them.
- **Values shown exactly** (paths, scopes, client IDs, rels, error messages, the log) are not altered. Instead, invisible characters and invalid UTF-8 are shown as `\u{202e}`, so a spoofing attempt stays visible.
- **Rejected outright:**
  - invisible characters and invalid UTF-8 in paths, scopes, rels and `host-meta.json` values;
  - `client_id` and redirect URI hosts that aren't plain lowercase DNS names;
  - `client_id`s that aren't in canonical form;
  - `logo_uri`, `client_uri` and redirect URIs with whitespace, quotes, angle brackets or invisible characters.

  hrefs are stored in canonical form (lowercase scheme and host, no default port, percent-encoded).
- **Headers.** Only plain origins enter the consent page's `Content-Security-Policy`. PHP's `header()` refuses line breaks.
- **Forms are parsed by PUPS itself**, not by PHP's `$_POST`: repeated fields (`scope=a&scope=b`) are kept, and `[` in a name has no special meaning.
- **Size limits.** Every string read in has one. Values over it are rejected with `400`, never cut:

  | Input | Limit |
  | --- | --- |
  | URLs: `client_id`, `redirect_uri`, hrefs, `logo_uri`, `client_uri` | 2048 characters |
  | `scope` | 2048 characters, 20 scopes |
  | `state` | 1024 characters |
  | Codes, access and refresh tokens | 256 characters (`code_verifier`: 128) |
  | Passwords | 1024 characters |
  | Signed form fields, passkey responses | 16384 characters |
  | Headers read (`Authorization`, `If-Match`, `If-None-Match`, `If-Range`, `Range`, `Content-Type`) | 1024 characters |
  | Paths | 512 bytes decoded, 1536 characters encoded |
  | Any other form field or query parameter | 256 characters; at most 1000 repeated values |
  | Form bodies | 64 KB |
  | Client metadata documents | 64 KB; `client_name` 1000 characters (100 shown); 20 redirect URIs |
  | `host_meta_endpoint` bodies | 16 KB; `rel` and `property` 512, `value` 2048, `type` 255 characters |
  | `host-meta.json` read for changes | 1 MB |
  | Uploads | `max_upload_bytes` (and `post_max_size` with the POST fallback) |

  Oversized values on owner pages get an HTML error page; API endpoints answer with JSON.
- **Log.** Values are JSON-quoted with control and invisible characters escaped, so nothing from a request or a fetched document can inject log lines or terminal escape sequences. Values over 4096 bytes are cut.
- **Source files** must not contain literal control or invisible characters ("Trojan Source"); a test checks that.

## Homepage

[webpup](../webpup) is a homepage for your domain: your profile, posts and pages, from the files your apps write through PUPS (feeds, `about.md`, `contact.vcf`, `host-meta.json`). It is a single page that renders them in the visitor's browser, so it changes whenever your apps change these files. pups-php comes with a copy in `webpup/`.

On the page *Homepage* (`/pups/homepage`, also linked from the start page and the end of the setup), you choose:

- **a theme**: webpup's default look or one of its ten themes, each with a preview. A `theme.css` you wrote yourself is kept, as the choice *Your own theme.css*;
- **the theme browser**: a row of all themes at the bottom of the page, where you and your visitors can try them. Off by default.

**Install webpup** copies webpup to the domain's folder (next to `index.php`): `index.html`, `webpups.js`, `webpup.css`, `theme.css` (the theme), `webpup-config.json`, and `webpup-themes/` while the theme browser is on. **Save** writes them again, with your new choices; your other settings in `webpup-config.json`, such as `embeds`, stay. **Remove webpup** deletes these files, and `/` forwards to the owner pages again.

- `/` and webpup's pretty URLs (`/p/about`, `/p/feed/photos`, …) serve its `index.html`. `.htaccess` lets the web server deliver its script, styles and themes directly; everything else goes through `index.php`.
- **Post pages.** Every post has a page of its own, e.g. `/p/feed/post/47` for the post with index 47 of your main feed. PUPS declares these URLs in `host-meta.json`, with the site property `https://bigwide.net/ns/post-url-template` set to `https://me.example.com/p/{feed}/post/{index}`, and removes it again with webpup. PUPS then links new posts of your feeds to their page ([RFC-7, Post URLs](https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md#post-urls)). Apps can't change the property.
- `webpup-config.json` is served with two links that PUPS adds: `settings-url`, where the theme browser tells you to change the theme, and `owner-link`, the **Owner** link to `/pups/` at the very bottom of the page. Set `'webpup_owner_link' => false` in `config.php` to leave that link out.
- An `index.html` of your own takes precedence: PUPS serves it at `/`, never replaces it, and the page *Homepage* asks you to remove or rename it before installing webpup.
- webpup is installed only at the domain root, not in a [folder installation](#installing-in-a-folder): it loads its files and your feeds from there.

## Configuration

`config.php` returns an array. Only `origin` and `setup_secret` are required; see `config.example.php`.

| Key | Default | Meaning |
| --- | --- | --- |
| `origin` | (required) | Your domain as an origin, e.g. `https://me.example.com`. It is your identity (`me`); all URLs derive from it. |
| `setup_secret` | (required for setup) | At least 16 characters. Entered once on `/pups/setup`. |
| `data_dir` | `data/` next to `index.php` | Where `state.json`, the log and the uploads live. Outside the web root is better. |
| `base_path` | detected | `''` at the domain root, `'/pups'` in a folder. |
| `max_upload_bytes` | `26214400` | Largest accepted file. |
| `max_storage_bytes` | `0` (none) | Overall quota; writes above it get `507`. |
| `writes_per_minute` | `120` | Writes per minute per grant before `429`; `0` for no limit. |
| `post_fallback` | detected | `true` or `false` to override what the checks found: whether to declare `post_endpoint`. |
| `well_known_paths` | RFC-6's list | Declared well-known paths, see below. |
| `public_base` | `storage_base` | Base URL for public reads, if they go through another host (a CDN). |
| `mentions` | `true` | Receive mentions of your domain at `/pups/mention` and put them into your inbox. See [Inbox](#inbox). |
| `comments` | `true` | Receive comments on your feeds at `/pups/comments` and put them into your inbox. See [Inbox](#inbox). |
| `webpup_owner_link` | `true` | With webpup as your homepage: end the page with a link to the owner pages. See [Homepage](#homepage). |
| `allow_http` | `false` | Local tests only: accept an `http://` origin. |
| `allow_private_clients` | `false` | Local tests only: fetch client metadata documents from private addresses. Never on a public server (SSRF). |
| `extra_ca` | none | Local tests only: an additional CA certificate (PEM) for fetching client metadata documents, e.g. mkcert's. |

### Well-known paths

By default PUPS declares the list of well-known paths of RFC-6, at the domain root:

| Path | Consent screen | Notes |
| --- | --- | --- |
| `/.well-known/following.opml` | the list of people you follow | |
| `/.well-known/about.md` | your profile | may set the properties `https://bigwide.net/ns/name`, `…/title`, `…/summary`, `…/theme-color` and `…/language` |
| `/.well-known/contact.vcf` | your contact details | |
| `/feed.json` | your feed | may register feeds with the rel `https://bigwide.net/ns/feed` |
| `/feed/` | the files of your feed, and your other feeds | may register feeds with the rel `https://bigwide.net/ns/feed` |
| `/pups/images/` | your site's profile images | may set the properties `https://bigwide.net/ns/avatar` and `…/banner`, to the URL of an image in `/pups/images/` |
| `/pups/pages/` | your site's pages | may register pages with the rel `https://bigwide.net/ns/webpup-pages`, with the link property `…/webpup-hidden`, and set the property `https://bigwide.net/ns/webpup-footer` to the URL of a file in `/pups/pages/` |

The consent screen groups them, with one checkbox per group: `/feed.json`, `/feed/` and `following.opml` under "Manage your feeds", the others under "Manage your profile", and [private paths](#private-areas) under "Read non-public content" or "Manage non-public content". The names in the table appear in the group's details.

In a [folder installation](#installing-in-a-folder) only `/.well-known/` reaches PUPS at the domain root, so the defaults leave out `/feed.json` and `/feed/` there, and `/pups/images/` and `/pups/pages/` stay at `storage_base`.

**If your website already serves `/feed.json` or `/feed/`** (WordPress, for example, serves its RSS feed at `/feed/`), set `well_known_paths` without them. The setting replaces the whole list, e.g.:

```php
'well_known_paths' => [
    ['path' => '/.well-known/about.md', 'url' => 'https://me.example.com/.well-known/about.md',
     'properties' => ['https://bigwide.net/ns/name'], 'description' => 'your profile'],
    ['path' => '/pups/images/', 'url' => 'https://me.example.com/pups/images/',
     'properties' => ['https://bigwide.net/ns/avatar'], 'url_properties' => ['https://bigwide.net/ns/avatar'],
     'description' => "your site's profile images"],
    ['path' => '/pups/pages/', 'url' => 'https://me.example.com/pups/pages/',
     'rels' => ['https://bigwide.net/ns/webpup-pages'], 'link_properties' => ['https://bigwide.net/ns/webpup-hidden'],
     'properties' => ['https://bigwide.net/ns/webpup-footer'], 'url_properties' => ['https://bigwide.net/ns/webpup-footer'],
     'description' => "your site's pages"],
],
```

- **Published** in the configuration document: `path`, `url`, `rels`, `properties` and `link_properties` (properties apps may set on their links).
- **Kept on the server:**
  - `description`: how the details on the consent screen name the path;
  - `single_rels`: rels that allow only one link;
  - `url_properties`: properties whose value must be the URL of one of the app's files.

PUPS rejects what RFC-6 forbids:

- directories under `/.well-known/`;
- `host-meta`, `webfinger`, `acme-challenge`, `pki-validation` and similar files;
- anything under `/appdata/`;
- paths that overlap the server's endpoints, except `/pups/images/`, `/pups/pages/` and paths inside `/pups/private/`;
- private paths with `url`, `rels`, `properties`, `link_properties`, `url_properties` or `single_rels`.

### Private areas

Two areas hold files that only your apps can read, not the public: drafts, settings, read positions, an inbox.

- **`/appdata/<app>/private/`** is the app's own private folder. Every app has one; its scope `write:/appdata/<app>/` covers it, for reading too. Nothing needs to be configured.
- **`/pups/private/`** holds private files that several apps share, defined by extensions of RFC-6. PUPS declares one of them itself: the inbox, `/pups/private/inbox.json` (RFC-12), as long as the built-in receiver is on (see [Inbox](#inbox)). To offer others, add them to `well_known_paths` with `path` and, if you like, `description`, and nothing else: private files have no public URL and can't be linked in `host-meta.json`.

  ```php
  'well_known_paths' => [
      ...Pups\defaultWellKnown('https://me.example.com'),
      ['path' => '/pups/private/drafts/', 'description' => 'your drafts'],
  ],
  ```

  (`defaultWellKnown()` keeps RFC-6's list; in a folder installation, pass the base path as the second argument, e.g. `'/pups'`.) Apps then ask for `read:/pups/private/drafts/` to read the files there, or `write:/pups/private/drafts/` to read and write them. The consent screen shows these scopes under "Read non-public content" or "Manage non-public content".

Private files are read with the app's token at `storage_base`, like a fresh read. Without a token PUPS answers `401`, with an invalid one `401`, with a token whose scopes don't cover the path `403`, and only then, if the file is missing, `404`, so the answer never tells anyone else whether a file exists. Every response for a private path carries `Cache-Control: no-store` (`private, no-store` with the file) and `Vary: Authorization`. A `read:` scope never allows writing. The files are in `data_dir` with all the other uploads, which the web server never serves without PUPS. They are not encrypted: whoever runs the hosting can read them.

### Feeds

PUPS keeps your feeds ([RFC-7](https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md)): every feed file in `/feed.json` or `/feed/<name>.json` that carries `"_pups": { "pupsControlled": true }`. Apps send posts one at a time, with `POST` of a JSON Feed item to the feed file, and PUPS does the rest: it gives each post its index and, with webpup, the URL of its page, puts it into the archives `feed.000000.json`, `feed.000001.json`, … in the feed directory, 20 posts each ([RFC-13](https://github.com/bigwide-net/RFCs/blob/main/RFC-13-JSON-Feed-Archives.md)), and writes the feed file with the newest 30. Edits and deletes work the same way. Every request is done completely under the storage lock, archives first, so posts from several apps never get lost. Apps may also `PUT` the feed file, e.g. to change its title: PUPS compares its items with the ones it had, and adds, changes or deletes posts accordingly. Apps can't write the archives. The configuration document says `"kept_feeds": true`.

A feed you made by hand or with another tool stays untouched until you add the `_pups` marker; then PUPS puts its posts into archives on the next write.

### Inbox

PUPS has a small built-in receiver. It puts what other sites send you into your **inbox**, a private JSON Feed at `/pups/private/inbox.json` ([RFC-12](https://github.com/bigwide-net/RFCs/blob/main/RFC-12-Inbox-Feeds.md)). Your feed reader shows it, if it supports inboxes and you allow it to read non-public content (`read:/pups/private/inbox.json`). Nothing has to be set up, and both parts can be switched off in `config.php` (`mentions`, `comments`).

- **Mentions** ([RFC-11](https://github.com/bigwide-net/RFCs/blob/main/RFC-11-Mentions.md)). PUPS adds your mention endpoint, `/pups/mention`, to `host-meta.json`, once: if you remove the link, it stays removed. Other sites then send a webmention whenever a post names `@your.domain`, or answers one of your posts or comments. PUPS fetches the post and checks that it does. Posts may be RSS 2.0, JSON Feed or HTML pages (`h-entry`). A mention whose post is deleted or edited is withdrawn when the site sends it again. Mentions stay for 30 days.
- **Comments** ([RFC-4](https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md)) on posts in your feeds on this server, and replies to the published comments. The app that publishes a feed opts in: it writes `_submissions` into the feed, with `"url"` set to `/pups/comments` (the configuration document names it as `comment_endpoint`), `"republish": "full"`, `"summary"` or `"no"`, and a `comments` policy; with [pups-client](https://github.com/bigwide-net/pups-client) that is `feed.enableComments()`. With `full` or `summary`, every comment has a *Publish Comment* button: PUPS then publishes it, or with `summary` only the first 150 characters of its plain text with a link to the comment, in the post's comment feed, `/feed/comments/<index>.json`, and counts it in the post's `_source.comments`, which every post of the feed carries, `{ "count": 0, "total": 0 }` until it has comments ([RFC-7 "Publishing comments"](https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md#publishing-comments)). A reply to a comment goes into that comment's own comment feed, `/feed/comments/<index>/<comment id>.json`, which the comment's `_source.comments` names; replies can be nested as deep as the policy's `maxDepth` (default 5, at most 10), and `total` counts all levels. Edits of published comments come back for approval; deletes take effect at once, and take the replies along. Only the feed file has `_submissions`: for a comment on a post in an archive, PUPS uses the feed file's, so turning comments on or off applies to all posts ([RFC-7 "Receiving comments"](https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md#receiving-comments-rfc-4)). PUPS checks each comment against that policy: title, `minLength`, `maxLength`, `requireSocialSpec`, `allowEdit`, `allowDelete`, `maxDepth`, and `commentLimit`, the comments of a post on all levels (default 1000). It also checks the formatting ([RFC-5](https://github.com/bigwide-net/RFCs/blob/main/RFC-5-Comment-HTML.md)): the comment's Markdown (rendered like markdown-it: CommonMark with tables and strikethrough, raw HTML as text), else its HTML, else its text, may use only the features that the policy turns on (`allowStyle`, `allowLinks`, `allowCode`, `allowQuote`, `allowImages`, `allowTables`, `allowLists`, `allowHeadlines`; a missing one is off), must be well-formed, and links and images need absolute http(s) URLs. A comment that breaks a rule is rejected with the reason (e.g. `forbidden-element`, *The element &lt;img&gt; is not allowed: this feed doesn't accept images.*), never repaired. The inbox and the comment feed get the normalized HTML, with bare URLs linked if `urlAutoLinking` is on, and the Markdown, if there was any, as `_source.markdown`. Comments stay in the inbox until you approve or dismiss them. Your own comments, from a feed on your domain, skip the inbox and are published at once.
- **Limits.** The inbox holds at most 100 items, and at most 10 from one site, so that no site can fill it. A new item pushes out the oldest mention; comments are never pushed out, so when 100 comments are waiting, new ones are refused. At most 100 webmentions wait to be checked, at most 5 from one site; senders get `429` beyond that.
- **Auto-moderation**, off by default. On the page *Comments* (`/pups/comment-settings`) you can enter the API key of an OpenAI-compatible chat API (OpenRouter by default, model `openai/gpt-5-nano`; both can be changed), your own criteria, a threshold (90 % by default) and a daily limit of tokens in thousands (500 by default, at most 10,000). A model then rates each comment against general rules (spam, scams, illegal and adult content, abuse, personal data) and your criteria; comments rated at least as likely acceptable as the threshold are published at once, all others wait in your inbox with the rating. If the API fails or the day's tokens are used up, comments simply wait in your inbox. The settings, with the key, are in `data/moderation.json`.
- **Dismiss and Publish Comment.** Every item has a *Dismiss* button for readers that support [Feed Actions (RFC-9)](https://github.com/bigwide-net/RFCs/blob/main/RFC-9-Feed-Actions.md), and a *Dismiss* link for all other readers ([RFC-8](https://github.com/bigwide-net/RFCs/blob/main/RFC-8-Fallback-HTML.md)); comments that can be published also have *Publish Comment*. The link opens a page with a button; following it dismisses or publishes nothing. Dismissing such a comment tells its author that it was not approved. Both carry a secret key, which only apps that can read your inbox see.
- **When it is checked.** Every check fetches documents from other servers, so PUPS answers the webmention first (`202` for mentions; `201` with a status page for comments) and does the checks afterwards, in the same PHP process. With PHP-FPM or LiteSpeed it ends the response early; elsewhere the sender gets the full response at once, but the connection stays open until the checks are done. The server page shows which applies. Fetches are limited to 1 MB, 10 seconds, 3 redirects and public addresses, like client metadata documents.
- **One writer.** If another system writes your inbox (its `_inbox.writer` names it), PUPS leaves the file alone and says so on the apps and comments pages. Delete the file to let PUPS write it.

The apps page shows how many mentions are in the inbox, the page *Comments* how many comments.

## How it maps to RFC-6

- **OAuth is implemented by hand**, like in the Cloudflare Worker and the Node server: codes are single-use, and a reused code revokes every token issued from it. Refresh tokens rotate, and reuse revokes the grant. The exception is a 60-second grace period, while nothing issued by the replacement has been used. `me` is in every token response.
- **Same-domain mode only.** There is no auth subdomain: typical shared hosting offers no easy way to run one install on two hosts. This matches RFC-6's description of the PHP drop-in.
- **Passkeys are verified with the openssl extension**, without a library:
  - CBOR and COSE parsing, ES256 and RS256, and Ed25519 where the sodium extension exists;
  - the signature counter is checked;
  - attestation is not checked (attestation type `none`).

  The relying party ID is the owner's host.
- **Client metadata fetch (SSRF).** A small HTTP client on PHP streams, so cURL isn't needed. It resolves the host itself, refuses non-public addresses (private, loopback, link-local, CGNAT, documentation, multicast, IPv4-mapped), and connects to the address it checked, so DNS rebinding can't get around the check. It verifies the certificate against the host name. Timeout 5 seconds, 64 KB at most, no redirects. Documents are cached for at most 24 hours, and only if `Cache-Control: max-age` allows it.
- **Serving.** PHP serves every upload itself, with:
  - the type of its extension;
  - `nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: no-cache`, `Vary: Authorization` and CORS;
  - ETags, ranges and conditional requests.

  **Fresh reads:** a `GET` or `HEAD` with `Authorization: Bearer <token>` accepts any valid access token, `identify` included, and checks no scope. It is read from disk like every request, and gets `Cache-Control: private, no-store`. An invalid, expired or revoked token gets `401`, never a public read. The read counts as use of the token, like a write (this matters for the refresh grace period). A token's first use is saved at once; after that, the grant's "last used" time is saved at most once a minute, so reads don't write `state.json` every time. Caches in front of PHP, such as LiteSpeed Cache, a hosting provider's page cache or a CDN, normally pass requests with `Authorization` through; if yours is configured to cache them anyway, exclude them.

  **Private files** (`/appdata/<app>/private/…` and `/pups/private/…`, see [Private areas](#private-areas)) need a token whose `write:` or `read:` scope covers them, checked before PUPS looks for the file. Their paths are compared case-insensitively, in case the disk is: `/APPDATA/app.example/PRIVATE/a.json` is private too.

  Requests with `Service-Worker: script` get `403`. Because PHP sets these headers, PUPS doesn't depend on `mod_headers` or `AddType`. The data folder's `.htaccess` files deny all direct access and switch off script handlers, in case the rewrite to `index.php` ever stops working.
- **ETags** are the SHA-256 of the content for files up to 1 MB. For larger files they are a hash of size, modification time and inode: every write creates a new file, so the inode changes.
- **The POST fallback is automatic.** The setup and server pages test whether `PUT` and `DELETE` reach PHP. If not, the configuration document declares `post_endpoint`, as RFC-6 suggests for hosts behind a firewall.
- **Revocation** cleans up `host-meta.json` once an app has no grant left: its `/appdata/` links are removed, and its well-known links lose the ownership marker and become yours.

Differences from the Cloudflare Worker:

- the data is in JSON files instead of SQLite;
- uploads are at the domain root instead of `/files/`;
- passkeys can be added and removed after setup;
- there is a server page with checks and the log.

Apps take the base URLs from the configuration document, so either layout works for them.

## Code

The server is in `pups/`; the paths below are relative to it. `tests/` and `scripts/` are for development only.

| File | Contents |
| --- | --- |
| `index.php` | Entry point: checks the PHP version, calls `Pups\run()`. |
| `.htaccess` | Sends every request to `index.php`, except webpup's script, styles and themes; passes the `Authorization` header on. |
| `controller.php` | Routing, error handling, sending responses (`handle()`, `emit()`, `run()`). |
| `handler/discovery.php` | `host-meta.json`, configuration document, RFC 8414 metadata, start page. |
| `handler/oauth.php` | Authorization endpoint with consent screen, token and revocation endpoints. |
| `handler/files.php` | Upload API, POST fallback, public reads with the sandbox headers. |
| `handler/hostmeta.php` | `host_meta_endpoint` and the cleanup after revocation. |
| `handler/admin.php` | The apps and sign-in pages. |
| `handler/setup.php` | Setup, environment checks, the server page, the probe. |
| `handler/homepage.php` | The homepage: installing and removing webpup, the page *Homepage*, serving `/` and webpup's URLs. |
| `handler/mentions.php` | The built-in receiver: `/pups/mention`, `/pups/comments`, status pages, the queue and the checks. |
| `handler/inbox.php` | Dismissing inbox items: the RFC-9 action and the confirmation page. |
| `lib/inbox.php` | The inbox file: writing it under the storage lock, items, limits, the action key. |
| `lib/feeds.php` | Fetching posts with limits; parsing JSON Feed, RSS and HTML pages; finding items in archives. |
| `lib/comments.php` | Comment feeds (RFC-7 "Publishing comments"): publishing approved comments, edits and deletes, the posts' counts. |
| `lib/moderation.php` | Auto-moderation of comments: the owner's settings, the model's rating, the daily token limit. |
| `lib/commenthtml.php` | Comment HTML (RFC-5): checking a comment against the policy's features with a strict tokenizer, normalizing it, auto-linking. |
| `lib/markdown.php` | Comment Markdown (RFC-5): CommonMark with tables and strikethrough, rendered like markdown-it. |
| `lib/archive.php` | Kept feeds (RFC-7): `PUT` of a feed file and `POST` of items, the RFC-13 archives, indexes and post URLs. |
| `lib/content.php` | Visible text, handles and excerpts of incoming posts. |
| `lib/config.php` | Configuration and well-known path rules. |
| `lib/state.php` | `state.json`: owner, codes, grants, tokens, refresh rotation, rate limits, all under a lock. |
| `lib/storage.php` | Files on disk: atomic writes, ETags, the storage lock, no symlinks out of the root. |
| `lib/cimd.php` | Client metadata documents, and the HTTP client with SSRF protection. |
| `lib/webauthn.php` | Passkeys: options, registration, assertions, CBOR, COSE. |
| `lib/owner.php` | Owner confirmation with passkey or password, rate-limited and logged. |
| `lib/paths.php`, `lib/filetypes.php` | Path, scope and file type rules. |
| `lib/sanitize.php` | Sanitizing of untrusted values. |
| `lib/http.php`, `lib/html.php` | Request, response, limits, form parsing; page layout. |
| `lib/log.php`, `lib/context.php` | The log; the shared context and the data folder. |
| `assets/owner.css`, `assets/owner.js` | Look of the owner pages (no classes, see the comment at the top) and the passkey ceremonies. Copies from pups-ui. |
| `lib/texts.json` | Texts of the consent screen, the permission lists and the confirmation fieldset (`t()` in `lib/html.php`). A copy from pups-ui. |
| `webpup/` | A build of [webpup](../webpup), which the page *Homepage* installs. |

The stylesheet, the script and `texts.json` are shared with the TypeScript implementations through [pups-ui](../lib/pups-ui). Change them there and run `scripts/sync-ui.sh` to copy them here; a test fails while the copies are out of date. The server itself never needs pups-ui.

`webpup/` is a production build of [webpup](../webpup). After changing webpup, run `scripts/sync-webpup.sh`: it builds webpup and copies the build here.

```sh
php tests/run.php            # all tests; php tests/run.php <filter> for some
```

The tests need no framework. Most of them run requests in-process against a fresh server, with a fake network for client metadata documents and a clock they can move. A software authenticator tests the passkeys.

They cover:

- discovery and consent;
- PKCE, code reuse and expiry;
- refresh rotation, the grace period and reuse detection;
- revocation and scope enforcement;
- ETag preconditions, ranges, quota and rate limit;
- path and type rules, serving headers, the POST fallback;
- `host-meta.json` editing and the owner pages;
- setup, passkeys and rate limiting;
- untrusted input and size limits;
- folder installations and persistence;
- auto-moderation: the settings on the page *Comments*, ratings above and below the threshold, failures of the model, the daily token limit;
- Comment HTML and Markdown (RFC-5): the cases that pups-inbox runs with markdown-it (`lib/pups-inbox/test/*-cases.json`, if checked out), the RFC's examples, comments rejected for their formatting;
- comment feeds: `_source.comments` on posts, Publish Comment and Dismiss, edits and deletes of published comments, replies to comments on several levels, the comment limit;
- kept feeds: posting, editing and deleting items, archives of 20 and the newest 30 in the feed file, `PUT` of the feed file, handed-over feeds, post URLs, and archives that apps can't write;
- the inbox: mentions by name and replies (RSS, JSON Feed, HTML, archives, items republished by groups), comments and their rules, edits and deletes, the limits, Dismiss, and another system's inbox. A fake network serves the posts.

`tests/server_test.php` also runs PUPS on PHP's built-in server. That covers the real request and response path: `.htaccess`-style routing, the `Authorization` header, streaming uploads, ranges, `HEAD`, the self-test checks and configuration errors.
