import { alert, confirmFields, type ConfirmOptions, escapeHtml as h, page, status } from './html'
import { WEBPUP_FILES } from './webpup-files'

/**
 * The homepage of the domain: webpup (the single-page website of a PUPS domain), which the owner installs at
 * /pups/homepage, served at / and /p/*. Without a homepage, / forwards to the owner pages at /pups/. The servers keep
 * the owner's choice (HomepageState) and pass it in; webpup's files come with this package (src/webpup-files.ts,
 * written by scripts/sync-webpup.mjs).
 */

/** The line webpup's index.html carries. */
export const WEBPUP_GENERATOR = '<meta name="generator" content="webpup">'
/** The site property that tells apps the URL of a post's page (RFC-6 "Site properties", RFC-7 items). */
export const POST_URL_TEMPLATE_PROP = 'https://bigwide.net/ns/post-url-template'

/** What the owner chose on /pups/homepage. Undefined: webpup is not installed. */
export interface HomepageState {
  /** A theme's id, or 'default' for webpup's own look. */
  theme: string
  /** Show all themes at the bottom of the page. */
  themeSelector: boolean
}

/** Who owns /: webpup, an existing website behind this server, or nobody (it forwards to /pups/). */
export type HomepageKind = 'webpup' | 'website' | 'none'

/** The themes that come with webpup: id → [title, description]. */
export function webpupThemes(): Record<string, [string, string]> {
  const list = JSON.parse(WEBPUP_FILES['/webpup-themes/index.json']?.text ?? '{}').themes
  const out: Record<string, [string, string]> = {}
  for (const t of Array.isArray(list) ? list : [])
    if (typeof t?.id == 'string' && /^[a-z0-9-]+$/.test(t.id) && typeof t.title == 'string')
      out[t.id] = [t.title, typeof t.description == 'string' ? t.description : '']
  return out
}

export const isTheme = (id: string) => id == 'default' || id in webpupThemes()

/** webpup's post pages: /p/feed/post/12, /p/feed/photos/post/12. */
export const webpupPostUrlTemplate = (ownerOrigin: string) => `${ownerOrigin}/p/{feed}/post/{index}`

const decode = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0))
const etags = new Map<string, string>()

/** A file of webpup, revalidated on every use (webpup's files have fixed names). */
async function siteFile(req: Request, type: string, body: string | Uint8Array<ArrayBuffer>): Promise<Response> {
  const key = typeof body == 'string' ? body : ''
  let etag = key ? etags.get(key) : undefined
  if (!etag) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', typeof body == 'string' ? new TextEncoder().encode(body) : body))
    etag = `"${[...hash.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join('')}"`
    if (key && etags.size < 100) etags.set(key, etag)
  }
  const headers = {
    'content-type': type.startsWith('image/') ? type : `${type}; charset=utf-8`, 'cache-control': 'no-cache', etag, 'x-content-type-options': 'nosniff',
  }
  if (req.headers.get('if-none-match') == etag) return new Response(null, { status: 304, headers })
  return new Response(req.method == 'HEAD' ? null : body, { headers })
}

export interface WebpupOptions {
  /** Where the theme browser tells the owner to change the theme: the URL of /pups/homepage. */
  settingsUrl: string
  /** The link to the owner pages at the bottom of the page, if any: the URL of /pups/. */
  ownerLink?: string
}

/**
 * GET / and webpup's URLs while it is installed: index.html for / and /p/* (webpup's pretty URLs), its script and
 * styles, the theme, the themes of the theme browser, and webpup-config.json with the links PUPS adds. Undefined for
 * any other path.
 */
export async function webpupResponse(req: Request, path: string, state: HomepageState, o: WebpupOptions): Promise<Response | undefined> {
  if (req.method != 'GET' && req.method != 'HEAD') return
  const file = (name: string) => WEBPUP_FILES[name]
  if (path == '/' || path == '/index.html' || path.startsWith('/p/')) return siteFile(req, 'text/html', file('/index.html')!.text!)
  if (path == '/webpups.js' || path == '/webpup.css') return siteFile(req, file(path)!.type, file(path)!.text!)
  if (path == '/theme.css')
    return siteFile(req, 'text/css', `/* webpup theme: ${state.theme}. Installed by PUPS; choose another one at ${o.settingsUrl} */\n` +
      (state.theme == 'default' ? '' : file(`/webpup-themes/${state.theme}.css`)?.text ?? ''))
  if (path == '/webpup-config.json')
    return siteFile(req, 'application/json', JSON.stringify({
      'theme-selector': state.themeSelector, 'settings-url': o.settingsUrl, ...o.ownerLink && { 'owner-link': o.ownerLink },
    }, null, 2) + '\n')
  const theme = file(path)
  if (state.themeSelector && /^\/webpup-themes\/([a-z0-9-]+\.(css|jpg)|index\.json)$/.test(path) && theme)
    return siteFile(req, theme.type, theme.base64 ? decode(theme.base64) : theme.text!)
}

/** /pups/assets/themes/<id>.jpg: the theme thumbnails for the homepage page. */
export function themeThumbnail(name: string): Response | undefined {
  const f = /^[a-z0-9-]+$/.test(name) ? WEBPUP_FILES[`/webpup-themes/${name}.jpg`] : undefined
  return f?.base64 ? new Response(decode(f.base64), {
    headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' },
  }) : undefined
}

// --- Pages ---------------------------------------------------------------------------------

export interface HomepageSite {
  ownerHost: string
  ownerOrigin: string
  /** The built-in receiver takes comments: the owner pages have a comments page. */
  comments?: boolean
}

/** A line about the homepage, for the start page and the end of the setup. */
export function homepageSummary(site: HomepageSite, kind: HomepageKind): string {
  const home = `${h(site.ownerOrigin)}/`
  return kind == 'webpup' ? `<p>Your homepage is <a href="${home}">webpup</a>. <a href="/pups/homepage">Change its theme, or remove it</a>.</p>`
    : kind == 'website' ? `<p>Your homepage is your own website at <a href="${home}">${h(site.ownerHost)}</a>, behind this server.</p>`
    : `<p>Your domain has no homepage yet: <a href="${home}">${h(site.ownerHost)}</a> forwards to these pages. <a href="/pups/homepage">Install webpup</a>,
a homepage that shows your profile, posts and pages from the files your apps write.</p>`
}

const INTRO = `<p>webpup is a homepage for your domain. It shows your profile, your posts and your pages: the files your apps write
through PUPS, like your feeds, <code>about.md</code> and <code>contact.vcf</code>. It runs in your visitors’ browsers, and changes
when your apps change these files.</p>`

export interface HomepagePage {
  kind: HomepageKind
  state?: HomepageState
  confirm: ConfirmOptions
  nav: string
  message?: string
  error?: string
}

/** /pups/homepage before the owner confirmed (same-domain mode). */
export const homepageUnlockPage = (site: HomepageSite, confirm: ConfirmOptions, nav: string, error?: string) => page('Homepage', `<h1>Homepage</h1>
<p>Confirm that you are the owner of <strong>${h(site.ownerHost)}</strong> to change the homepage of your domain.</p>
${alert(error)}
<form method="post">
${confirmFields(confirm)}
<p><button type="submit" name="show" value="1">Continue</button></p>
</form>`, { site: site.ownerHost, nav, status: error ? 401 : 200 })

/** /pups/homepage: install webpup, choose its theme and the theme browser, or remove it. */
export function homepagePage(site: HomepageSite, o: HomepagePage): Response {
  const opts = { site: site.ownerHost, nav: o.nav, status: o.error ? 400 : 200 }
  const home = `${h(site.ownerOrigin)}/`
  if (o.kind == 'website')
    return page('Homepage', `<h1>Homepage</h1>\n${status(o.message)}\n${INTRO}
<p>Your domain already has its own website, behind this server. To use webpup instead, turn off the forwarding to that website in the server's configuration.</p>`, opts)
  const installed = o.kind == 'webpup'
  const current = o.state?.theme ?? 'default'
  const themes: Record<string, [string, string]> = { default: ['Default', 'webpup’s own look, light or dark like the visitor’s system'], ...webpupThemes() }
  const choices = Object.entries(themes).map(([id, [title, description]]) => `<label><input type="radio" name="theme" value="${h(id)}"${id == current ? ' checked' : ''}> ` +
    `<img src="/pups/assets/themes/${h(id)}.jpg" alt="" width="100" height="70"> <span><strong>${h(title)}</strong><br><small>${h(description)}</small></span></label>`)
  return page('Homepage', `<h1>Homepage</h1>
${status(o.message)}${alert(o.error)}
${INTRO}
${installed ? `<p>webpup is the homepage of <a href="${home}">${h(site.ownerHost)}</a>. Every post has a page of its own on it, and apps that
write your feeds link new posts to it: <code>host-meta.json</code> tells them the address, <code>${h(webpupPostUrlTemplate(site.ownerOrigin))}</code>.</p>`
    : `<p>Your domain has no homepage yet: <a href="${home}">${h(site.ownerHost)}</a> forwards to these pages.</p>`}
<form method="post">
<fieldset>
<legend>Theme</legend>
${choices.join('\n')}
</fieldset>
<fieldset>
<legend>Theme browser</legend>
<label><input type="checkbox" name="theme_selector" value="1"${o.state?.themeSelector ? ' checked' : ''}> <span>Show all themes at the bottom of the page,
so that you and your visitors can try them</span></label>
</fieldset>
${confirmFields(o.confirm)}
<p><button type="submit" name="webpup" value="install">${installed ? 'Save' : 'Install webpup'}</button>${installed ? ' <button type="submit" name="webpup" value="remove">Remove webpup</button>' : ''}</p>
</form>`, opts)
}

export interface StartPage {
  hasOwner: boolean
  homepage: HomepageKind
  /** The URL of the configuration document. */
  configUrl: string
  nav: string
}

/** The start page of the owner pages, /pups/ (/ forwards here while the domain has no homepage). */
export const startPage = (site: HomepageSite, o: StartPage) => page(`Personal Upload Server for ${site.ownerHost}`, `<h1>Personal Upload Server</h1>
<p>This is the Personal Upload Server of <strong>${h(site.ownerHost)}</strong>. Apps can upload files to this domain once its owner allows them.</p>
${o.hasOwner ? homepageSummary(site, o.homepage) : '<p role="note">This server has no owner yet. <a href="/pups/setup">Set it up</a>.</p>'}
<ul>
<li><a href="/pups/apps">Your apps</a>: see which apps have access, and remove them.</li>
<li><a href="/pups/homepage">Homepage</a>: install webpup as the homepage of your domain, choose its theme, or remove it.</li>
${site.comments ? '<li><a href="/pups/comment-settings">Comments</a>: the comments waiting for you, and auto-moderation.</li>\n' : ''}<li>Discovery: <a href="${h(site.ownerOrigin)}/.well-known/host-meta.json">/.well-known/host-meta.json</a> → <a href="${h(o.configUrl)}">${h(o.configUrl)}</a>
· <a href="/.well-known/oauth-authorization-server">OAuth metadata</a></li>
</ul>`, { site: site.ownerHost, nav: o.nav })
