# webpup

A single-page website for a domain with a [Personal Upload Server](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md)
(PUPS). Apps write the owner's feeds, pages and profile through PUPS; webpup turns them into a website,
in the visitor's browser, without any server code:

- the profile header: banner, avatar, name, summary (from `host-meta.json`), a reader-independent
  **Follow** button and an email button (from `contact.vcf`);
- **Posts**: every post of `/feed.json`, rendered like Downread's reader (images, audio and video,
  embeds), with archive pages for feeds that have archives ([RFC-7](https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md));
- **comments** on posts that have a comment feed ([RFC-1](https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md)
  `_source.comments`, which PUPS writes for the comments the owner approved): "3 comments" opens them
  below the post, and on the post's own page they are open; replies open under their comment;
- one tab per further feed registered in `host-meta.json` (`/feed/<name>.json`), named by the link's
  `titles` (in the site's language, else `default`), else by the feed's own title;
- **Following**, **About** and **Contact** from the [SocialSpec](https://socialspec.org) files; on Following, each
  site with a feed has a Follow button that opens the follow dialog, and the list downloads as OPML;
- **pages**: Markdown files registered in `host-meta.json`, as a tab of their own or on a **Pages** tab,
  and other Markdown files of the site that they link to;
- optionally a **Markdown home page** at `/` instead of the feed (see [Home page](#home-page));
- a **footer** from a Markdown file, on every page;
- optionally a **theme selector** with ten themes to try.

> **Experimental:** webpup and PUPS are at an experimental stage. Expect backward-incompatible changes between versions.

## Files

| File | |
| --- | --- |
| `index.html` | The page. Loads the three files below by absolute path, so webpup must be at the domain root. |
| `webpups.js` | The script (about 100 KB). |
| `webpup.css` | The default look, light and dark. |
| `theme.css` | Empty. Replace it with a theme (see `themes/`) or your own CSS. |
| `webpup-themes/` | Optional: the themes for the theme selector (`index.json`, `<id>.css`, `<id>.jpg`). |
| `webpup-config.json` | Optional settings, see below. Not in `dist/`: without it, the page shows the theme selector. |

`npm run build` writes them to `dist/`.

## Installing

**With [pups-php](../pups-php):** on the owner page *Homepage* (`/pups/homepage`), choose a theme and
whether the theme selector shows, and click **Install webpup**. pups-php comes with a build of webpup,
copies it to the domain root, and serves `/` and `/p/*`. Nothing else to do.

**By hand:**
Copy the files from `dist/` to the root of the domain, next to `/feed.json` and `/.well-known/`.
A new site then shows the theme selector at the bottom of the page: pick a theme, copy it to
`theme.css`, and add a `webpup-config.json` (e.g. `{}`) to remove the selector. `webpup-themes/` can
be left out (or deleted afterwards); the selector then doesn't appear.
This is done by whoever installs PUPS (or by the PUPS server itself), not through PUPS: apps can't
upload HTML, JavaScript or CSS.

The web server must serve the four files as they are: with their normal content types, and without
the `Content-Security-Policy: sandbox` that PUPS puts on uploaded files (it would stop the script).
Two optional things make the URLs nicer:

- **`/` serves `/index.html`.** Otherwise the start page is `/index.html`.
- **`/p/*` serves `/index.html`** (an internal rewrite, not a redirect). Then pages have URLs like
  `/p/about` instead of `/index.html?show=about`.

```nginx
location = / { try_files /index.html =404; }
location /p/ { try_files /index.html =404; }
```

```apache
DirectoryIndex index.html
RewriteEngine On
RewriteRule ^p/ /index.html [L]
```

```caddy
rewrite /p/* /index.html
```

webpup finds out by itself what the server does: it requests `/p/webpup-probe` and `/` and checks
whether they return its `index.html` (by the `<meta name="generator" content="webpup">` line, so
keep it). The answer is kept in the browser's localStorage for 7 days.

## URLs

| Page | With the `/p/*` rewrite | Without |
| --- | --- | --- |
| Start page: the profile and the main feed (or the [Markdown home page](#home-page)) | `/` | `/index.html` |
| The main feed, when the start page is a Markdown page | `/p/blog` | `/index.html?show=blog` |
| About, Following, Contact | `/p/about`, `/p/following`, `/p/contact` | `/index.html?show=about`, … |
| Archive page 3 of the main feed | `/p/blog/archive/3` | `/index.html?show=blog&mode=archive&page=3` |
| Named feed `photos` | `/p/feed/photos` | `/index.html?show=feed&feed=photos` |
| Archive page 3 of `photos` | `/p/feed/photos/archive/3` | `/index.html?show=feed&feed=photos&mode=archive&page=3` |
| The Pages tab | `/p/pages` | `/index.html?show=pages` |
| The page `imprint.md` | `/p/page/imprint` | `/index.html?show=page&name=imprint` |
| A Markdown file that a page links to, `/docs/intro.md` | `/p/md/docs/intro.md` | `/index.html?show=md&path=/docs/intro.md` |
| Post 47 of the main feed (`_archive.index` 47) | `/p/feed/post/47` | `/index.html?show=post&feed=feed&index=47` |
| Post 3 of `photos` | `/p/feed/photos/post/3` | `/index.html?show=post&feed=feed/photos&index=3` |
| A post without an index | its page + `#<item id>` | the same |

- Both forms always work; webpup switches the address bar to the one the server supports.
- `/p/blog/…` is the main feed and `/p/feed/<name>/…` are the named feeds, so feeds can have any
  name, also `about` or `archive`.
- Archive pages are numbered like the archive files: page 3 is `feed.000003.json`. The numbers
  never change, so links to an archive page, and to the posts on it (`#id`), stay valid forever
  (RFC-7: "the archive's URL plus `#id` addresses an item forever"). Page 0 holds the oldest posts.
- **Post pages** show one post. webpup finds it by its index ([RFC-7](https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md#indexes)): in the
  feed file, else in archive ⌊index / 20⌋ or one next to it, so it loads at most a few files. Each
  post's **Link** goes there. Apps that write the feeds give new posts this URL as their `url` when
  `host-meta.json` has the site property `https://bigwide.net/ns/post-url-template`
  ([RFC-6](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md#post-urls)), e.g.
  `"https://tim.example/p/{feed}/post/{index}"` (or `…/index.html?show=post&feed={feed}&index={index}`
  without the rewrite). pups-php sets it when it installs webpup; by hand, add it yourself. An item
  whose `url` is such a page of the site gets no extra **Open** link.
- Links to pages of the site don't reload the page: webpup changes the URL with `pushState` and
  renders the new page (Back and Forward work, and restore the scroll position).

## Keyboard

In a feed, **j** or **n** goes to the next post and **k** or **p** to the previous one: the post is
scrolled to the top of the window and marked. After the last post, the page scrolls to the pager
(Older posts). The keys do nothing while the follow dialog is open or a text field has the focus.

## What it reads

All from the site's own origin, in parallel:

- `/.well-known/host-meta.json`: the feeds (links with `rel` `https://bigwide.net/ns/feed` to
  `/feed/<name>.json` on this site; others, like feeds on other domains or RSS feeds, are ignored,
  and so are feeds that visitors can't read: links with the [RFC-10](https://github.com/bigwide-net/RFCs/blob/main/RFC-10-Identity-Tokens.md#announcing-a-feed)
  property `https://bigwide.net/ns/access` set to `restricted`, `personal` or an unknown value)
  and the [site properties](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md#site-properties):

  | Property | Used for |
  | --- | --- |
  | `https://bigwide.net/ns/title` | The site's name in the header and the page title |
  | `https://bigwide.net/ns/name` | The same, if there is no title; next to the domain if there is one |
  | `https://bigwide.net/ns/summary` | The line under the name, and the page's meta description |
  | `https://bigwide.net/ns/avatar` | The avatar. Without it, the avatar stays empty: no guessing from icons. |
  | `https://bigwide.net/ns/banner` | The banner. Without it, a band in the accent color. |
  | `https://bigwide.net/ns/theme-color` | The accent color, unless `theme.css` has any rules |
  | `https://bigwide.net/ns/language` | `<html lang>` |

  Without a title or name, the name comes from `contact.vcf`, then the main feed's title, then the
  domain; without a summary, from `about.md`'s `summary`, then the main feed's description.
- The **pages**: links with `rel` `https://bigwide.net/ns/webpup-pages` to Markdown files on this
  site. See [Pages and footer](#pages-and-footer).
- The **footer**: the Markdown file of the property `https://bigwide.net/ns/webpup-footer`.
- The **home page**, if `webpup-config.json` or a page link names one (see [Home page](#home-page)).
- Markdown files are asked for with `Accept: text/markdown, text/plain;q=0.9`: a server that serves
  the same URL as HTML to browsers and as Markdown to Markdown browsers like
  [bonBon](https://github.com/scripting/bonBon) gives webpup the Markdown. After a `406`, webpup asks
  again with `Accept: */*`, as bonBon does. An answer of type `text/html` is not used (e.g. a server
  that answers unknown paths with `index.html`); anything else is read as Markdown.
- `/feed.json`, registered or not, and the registered named feeds. Archives
  ([RFC-13](https://github.com/bigwide-net/RFCs/blob/main/RFC-13-JSON-Feed-Archives.md):
  `_archive.archive_url`, and `archive_template` if given) are loaded when an archive page is opened.
  Feeds without `archive_url` have no archive pages. Feeds of earlier drafts, with `archive_url` and
  `index` in `_pups`, work as well.
- `/.well-known/about.md`, `following.opml`, `contact.vcf`. A tab shows only if its file exists.
- `/webpup-config.json`, if it exists.

## Pages and footer

Markdown files of the site become pages when `host-meta.json` links them. Apps publish them through
PUPS: the files go into the well-known directory `/pups/pages/`, and the host-meta endpoint adds the
links (with `titles` and `webpup-hidden`), orders them and sets the footer (RFC-6, "Pages"). The
owner can also edit `host-meta.json` by hand.

```json
{
  "links": [
    { "rel": "https://bigwide.net/ns/webpup-pages", "type": "text/markdown", "href": "https://tim.example.com/pups/pages/welcome.md",
      "properties": { "https://bigwide.net/ns/webpup-homepage": "true" } },
    { "rel": "https://bigwide.net/ns/webpup-pages", "type": "text/markdown", "href": "https://tim.example.com/pups/pages/now.md" },
    { "rel": "https://bigwide.net/ns/webpup-pages", "type": "text/markdown", "href": "https://tim.example.com/pups/pages/uses.md",
      "titles": { "default": "Uses" } },
    { "rel": "https://bigwide.net/ns/webpup-pages", "type": "text/markdown", "href": "https://tim.example.com/pups/pages/imprint.md",
      "properties": { "https://bigwide.net/ns/webpup-hidden": "true" } }
  ],
  "properties": {
    "https://bigwide.net/ns/webpup-footer": "https://tim.example.com/pups/pages/footer.md"
  }
}
```

- **Tabs.** One listed page is a tab of its own (after About, like it); with several, a **Pages**
  tab lists them.
- **Order.** The order of the links in `host-meta.json`, as RFC 7033 allows ("the order of
  elements in the links array MAY be interpreted as indicating an order of preference").
- **Hidden pages.** A link with the property `https://bigwide.net/ns/webpup-hidden` set to `"true"`
  is a page with its own URL, but neither a tab nor on the Pages tab: e.g. an imprint that only the
  footer links to.
- **Titles.** The link's `titles` (the site's language, else `default`, else any), else the first
  heading of the file, else its file name. The file name is also the page's name in URLs
  (`imprint.md` is `/p/page/imprint`).
- **Footer.** The Markdown file of `https://bigwide.net/ns/webpup-footer`, shown at the bottom of
  every page.
- **Home page.** A link with the property `https://bigwide.net/ns/webpup-homepage` set to `"true"`
  is the home page (see [Home page](#home-page)).
- **Links** in the site's Markdown (pages, footer, `about.md`, the home page) to the Markdown file of
  a page go to that page, e.g. `[Imprint](/pups/pages/imprint.md)`; to the home page's file, to `/`;
  to `/.well-known/about.md`, to About. Links to other Markdown files of the site (`.md` or
  `.markdown`, relative or not, without a query) open them as pages of their own, e.g.
  `[Intro](/docs/intro.md)` is `/p/md/docs/intro.md`, and the links in that file work the same way,
  relative to it. The Markdown keeps plain links to the files, so the site also works in a Markdown
  browser like bonBon. Links to the site open in the same tab, others in a new one.
- Only files on the site's own origin are used. They are rendered by postviewer's Markdown
  renderer, without raw HTML.

## Home page

By default, `/` shows the main feed. It can show a Markdown file instead, e.g. a welcome page; the
feed is then on the **Posts** tab, at `/p/blog`, and a **Home** tab comes first. Two ways to choose
the file:

- `"homepage": "/index.md"` in `webpup-config.json`: the path of any Markdown file on the site. If it
  is also a registered page, it gets the page's title.
- In `host-meta.json`, the page link with the property `https://bigwide.net/ns/webpup-homepage` set
  to `"true"` ([RFC-6, Pages](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md#pages)).
  Apps that publish pages can set it. If several links have it, the first one counts.

The config wins over `host-meta.json`. The home page is neither a tab of its own nor on the Pages
tab. If its file is missing, empty or an HTML page, `/` shows the main feed as before.

Markdown browsers like [bonBon](https://github.com/scripting/bonBon) don't run the script, but they
follow a `<link rel="alternate" type="text/markdown" href="…">` in the page's head to its Markdown
file. The static `index.html` can't know the home page, so the PUPS servers add that link when they
serve it: at `/` the home page, at `/p/md/<path>` that file. By hand, add it to `index.html`
yourself, with the home page's URL (it is then on every page).

## Configuration

`webpup-config.json`:

```json
{ "embeds": "on", "theme-selector": false }
```

- `homepage`: the path of a Markdown file on the site that `/` shows instead of the main feed, e.g.
  `"/index.md"`. See [Home page](#home-page).
- `embeds`: what happens with YouTube videos, embedded posts (X, Instagram, Bluesky, …) and other
  third-party content in the posts. `"on"` (default): shown at once, as the owner put them in their
  feed. `"consent"`: behind an overlay until the visitor allows the service (remembered in their
  browser). `"off"`: video players are removed, embedded posts stay plain quotes.
- `owner-link`: a path on the site, e.g. `"/pups/"`. The very bottom of every page then has a small
  **Owner** link to it. pups-php adds it when it serves the file (`webpup_owner_link` in its
  `config.php` turns it off).
- `settings-url`: a path on the site where the owner chooses the theme, e.g. `"/pups/homepage"`. The
  theme selector then tells the owner to keep a theme or remove the selector there, instead of
  explaining which files to copy. pups-php adds it.
- `theme-selector`: shows the theme selector above the footer, a row of the themes in
  `/webpup-themes/`. A click puts a theme on the page until it is reloaded; the text under the row
  says which file to copy to `theme.css` to keep it. **On while there is no `webpup-config.json`**,
  so a new site shows it; with a config file, only if it says `true`.

## Themes

Every color, font and size of `webpup.css` is a `--wp-*` custom property (listed at the top of
`src/webpup.css`), and `theme.css` is loaded after it. A theme is a `theme.css` that sets them, or
restyles anything else (`wp-*` page classes, `post*` post classes, `fd-*` follow dialog). Dark mode
follows the system unless `<html data-theme="light|dark">` says otherwise.

`themes/` has ten themes, from new colors (Night, Pastel) to another layout (Sidebar) and the
silly (Retro). See [themes/README.md](themes/README.md).

## The Follow button

The follow dialog of rssdirectory.org and sodir.org (`follow` in bigwide-net/lib): the visitor picks their reader
(Downread first, then Feedbin, Feedly, Inoreader, NetNewsWire, NewsBlur, HyperTexting on iOS, or a
custom subscribe URL), webpup opens the feed there; "Remember" makes the next Follow go straight to
it. The feed URL can also be copied. The list is `READERS` in `src/follow.ts`. **TODO:** check that
every listed reader subscribes to JSON Feeds (RFC-7 feeds are JSON only), and drop those that don't.

## Development

```bash
git clone https://github.com/bigwide-net/lib ../../lib && (cd ../../lib && npm install)   # once
bin/dev.sh               # debug build + dev server on :8095 with the example site, plain URLs
bin/dev.sh --rewrite     # ... with the /p/* rewrite (pretty URLs)
bin/dev.sh --rewrite --port 8096 --theme themes/night.css --no-root --data ../my-site
npm test                 # jest (jsdom)
npm run typecheck
npm run build            # production build into dist/
node scripts/make-example.mjs   # regenerate example/
node scripts/make-thumbnails.mjs [theme ...]   # theme thumbnails into themes/thumbs/ (needs a build)
```

The dev server (`scripts/serve.mjs`) serves webpup from `dist/` and the site's files from
`example/` the way PUPS serves uploads (CORS, `CSP: sandbox`, `no-cache`), and replaces
`https://tim.example` in them with its own origin. webpup remembers the URL style per origin for 7
days: to compare both modes, run them on different ports.

### Source

TypeScript in `src/`, bundled with esbuild:

- `router.ts`: the URL scheme (both styles), detecting the server's style, navigation without
  reload.
- `data.ts`: loading `host-meta.json`, the SocialSpec files, the feeds and archives, the config.
- `jsonfeed.ts`: JSON Feed items (with `_source`, `_image`) as posts of postviewer.
- `view.ts`: header, tabs, About/Following/Contact; `posts.ts`: the feed and archive pages.
- `comments.ts`: the comments of a post and the replies to them, from their comment feeds.
- `follow.ts`: the follow dialog's markup and the Follow button.
- `themes.ts`: the theme color, and the theme selector.

It uses three libraries of [bigwide-net/lib](https://github.com/bigwide-net/lib), checked out next
to the PUPS repository (`../../lib`; `@lib/*` in `tsconfig.json` and `jest.config.js`): `postviewer` (post
rendering and sanitizing with DOMPurify, Markdown), `socialspec` (the about.md, OPML and vCard
parsers) and `follow` (the follow dialog). `bin/dev.sh` checks it out and installs it if it's
missing.

## Not done yet

- Search engines see the page only after running the script; `index.html` has no content of its own.
