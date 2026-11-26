import { commentEndpoint, commentStatusEndpoint, dismissPage, inboxActionEndpoint, mentionEndpoint, type Receiver } from 'pups-inbox'
import { errorPage, themeThumbnail, webpupResponse } from 'pups-ui'
import { ownerCss, ownerJs } from 'pups-ui/assets'
import { filesEndpoint, postEndpoint, serve } from './files'
import { ensureMentionLink, hostMetaEndpoint, serveHostMeta } from './hostmeta'
import { cors, HttpError, htmlErrors, json, methodNotAllowed } from './http'
import { authorize, configDocument, oauthMetadata, revoke, token } from './oauth'
import { apps, commentSettings, feedSettings, homepage, homepageState, login, logout, password, setup, start } from './owner'
import { receiver, work } from './receiver'
import { hubEndpoint, workEndpoint, WORK_PATH } from './websub'
import { HUB_PATH } from 'pups-feeds'
import { covers, isPrivate, parsePath } from './paths'
import { CONFIG_PATH, type Env, type Settings, settings, STORAGE_PREFIX } from './settings'

const HSTS = 'max-age=31536000'

/** The stylesheet and script of the owner pages, bundled into the script. */
const ASSETS: Record<string, [string, string]> = {
  '/pups/assets/owner.css': [ownerCss, 'text/css; charset=utf-8'],
  '/pups/assets/owner.js': [ownerJs, 'text/javascript; charset=utf-8'],
}

function asset(req: Request, path: string): Response | undefined {
  const a = ASSETS[path]
  if (!a || req.method != 'GET' && req.method != 'HEAD') return
  return new Response(req.method == 'HEAD' ? null : a[0], {
    headers: { 'content-type': a[1], 'cache-control': 'max-age=300', 'x-content-type-options': 'nosniff' },
  })
}

/** Forwards a request to ORIGIN_URL (an existing website behind this server). */
function fromOrigin(req: Request, url: URL, origin: string): Promise<Response> {
  const headers = new Headers(req.headers)
  headers.delete('host')
  return fetch(origin + url.pathname + url.search, {
    method: req.method, headers, body: req.method == 'GET' || req.method == 'HEAD' ? undefined : req.body,
    redirect: 'manual', ...req.body && { duplex: 'half' },
  } as RequestInit)
}

const getJson = (req: Request, body: () => unknown) => cors(req, () => {
  if (req.method != 'GET' && req.method != 'HEAD') throw methodNotAllowed('GET, HEAD, OPTIONS')
  return json(body(), 200, { 'cache-control': 'no-cache' })
})

const notFound = () => errorPage('Not found', 'This page does not exist.', 404)
const seeOther = (location: string) => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } })

/** Owner pages and OAuth endpoints, on the auth host (the owner host in same-domain mode). */
function authRoutes(req: Request, path: string, s: Settings, env: Env): Promise<Response> | undefined {
  const thumbnail = /^\/pups\/assets\/themes\/([^/]+)\.jpg$/.exec(path)
  if (thumbnail) return Promise.resolve(req.method == 'GET' && themeThumbnail(thumbnail[1]) || notFound())
  switch (path) {
    case '/pups/': return htmlErrors(() => start(req, s, env))
    case '/pups/homepage': return htmlErrors(() => homepage(req, s, env))
    case '/.well-known/oauth-authorization-server': return getJson(req, () => oauthMetadata(s))
    // The authorization endpoint and owner pages are never CORS-enabled.
    // Owner pages answer with HTML error pages, also for oversized values.
    case '/oauth/authorize': return htmlErrors(() => authorize(req, s, env))
    case '/oauth/token': return cors(req, () => token(req, s, env))
    case '/oauth/revoke': return cors(req, () => revoke(req, s, env))
    case '/pups/setup': return htmlErrors(() => setup(req, s, env))
    case '/pups/recover': return htmlErrors(() => setup(req, s, env, true))
    case '/pups/login': return htmlErrors(() => login(req, s, env))
    case '/pups/logout': return htmlErrors(() => logout(req, s, env))
    case '/pups/apps': return htmlErrors(() => apps(req, s, env))
    case '/pups/feed-settings': return htmlErrors(() => feedSettings(req, s, env))
    case '/pups/comment-settings': return s.comments ? htmlErrors(() => commentSettings(req, s, env)) : undefined
    case '/pups/password': return htmlErrors(() => password(req, s, env))
  }
  const a = asset(req, path)
  if (a) return Promise.resolve(a)
}

/**
 * The built-in receiver (pups-inbox): webmentions, comment status pages and the inbox actions, CORS-enabled, and the
 * Dismiss page of readers without actions. A queued webmention is checked after the response (Bunny.v1.waitUntil).
 */
function receiverRoutes(req: Request, path: string, s: Settings, env: Env): Promise<Response> | undefined {
  if (!s.mentions && !s.comments) return
  const status = /^\/pups\/comments\/status\/([^/]+)$/.exec(path)
  const queued = (endpoint: typeof mentionEndpoint) => cors(req, async () => {
    const r = await receiver(s, env)
    const res = await endpoint(req, r)
    if (!res) throw new HttpError(404, 'not_found', 'Not found')
    if (res.status == 201 || res.status == 202) {
      // Without waitUntil (outside Bunny), the work runs on while the response is sent, as far as the runtime lets it.
      const w = work(r)
      env.waitUntil?.(w)
    }
    return res
  })
  if (path == '/pups/mention' && s.mentions) return queued(mentionEndpoint)
  if (path == '/pups/comments' && s.comments) return queued(commentEndpoint)
  if (status) return cors(req, async () => await commentStatusEndpoint(req, status[1], await receiver(s, env)) ?? notFound())
  // Publishing or rejecting a comment queues the mentions it sends.
  const approving = async (r: Receiver, res: Response) => {
    if (req.method == 'POST') env.waitUntil?.(work(r))
    return res
  }
  if (path == '/pups/inbox/action') return cors(req, async () => {
    const r = await receiver(s, env)
    return approving(r, await inboxActionEndpoint(req, r))
  })
  if (path == '/pups/inbox/dismiss') return receiver(s, env).then(r => dismissPage(req, r, s.ownerHost))
  if (path == '/pups/inbox/approve') return receiver(s, env).then(async r => approving(r, await dismissPage(req, r, s.ownerHost, 'approve')))
  if (path == '/pups/inbox/reject') return receiver(s, env).then(async r => approving(r, await dismissPage(req, r, s.ownerHost, 'reject')))
}

/** The homepage: webpup while it is installed, else / forwards to the owner pages. An existing website behind this server keeps /. */
async function homeRoutes(req: Request, path: string, s: Settings, env: Env): Promise<Response | undefined> {
  if (s.originUrl || (req.method != 'GET' && req.method != 'HEAD')) return
  const webpup = ['/', '/index.html', '/webpups.js', '/webpup.css', '/theme.css', '/webpup-config.json'].includes(path) ||
    path.startsWith('/p/') || path.startsWith('/webpup-themes/')
  if (!webpup) return
  const state = await homepageState(env)
  if (!state) return path == '/' ? seeOther(s.subdomainMode ? `${s.issuer}/pups/` : '/pups/') : undefined
  return webpupResponse(req, path, state, {
    settingsUrl: `${s.issuer}/pups/homepage`, ...s.webpupOwnerLink && { ownerLink: `${s.issuer}/pups/` },
  })
}

/** Discovery, the upload API and uploaded files, on the owner's domain. */
function ownerRoutes(req: Request, url: URL, s: Settings, env: Env): Promise<Response | undefined> | undefined {
  const path = url.pathname
  switch (path) {
    case '/.well-known/host-meta.json': return cors(req, () => serveHostMeta(req, s, env))
    case CONFIG_PATH: return getJson(req, () => configDocument(s))
    case '/pups/host-meta': return cors(req, () => hostMetaEndpoint(req, s, env))
    case '/pups/post': if (s.postFallback) return cors(req, () => postEndpoint(req, s, env))
      break
    case HUB_PATH: return hubEndpoint(req, s, env)
    case WORK_PATH: return workEndpoint(req, s, env)
  }
  const received = receiverRoutes(req, path, s, env)
  if (received) return received
  if (path.startsWith(STORAGE_PREFIX)) return cors(req, () => filesEndpoint(req, path.slice(STORAGE_PREFIX.length - 1), s, env))
  // A private path at the domain root (e.g. with public_base there) needs a token that covers it, and
  // never comes from the origin.
  const p = parsePath(path, s)
  if ('path' in p && isPrivate(p.path)) return cors(req, () => serve(req, path, s, env))
  // Well-known files with their own URL (e.g. /.well-known/about.md at the domain root).
  for (const e of s.wellKnown) {
    if (!e.url?.startsWith(s.ownerOrigin + '/')) continue
    const urlPath = e.url.slice(s.ownerOrigin.length)
    if (!covers(urlPath, path)) continue
    const file = () => cors(req, () => serve(req, e.path + path.slice(urlPath.length), s, env))
    // In front of an existing website, a declared file that nobody has uploaded yet comes from the origin.
    // Never a private one: entries with a url can't cover private paths (settings.ts).
    return s.originUrl ? file().then(r => r.status == 404 ? fromOrigin(req, url, s.originUrl!) : r) : file()
  }
  // A public_base on the owner's domain with another path than storage_base.
  if (s.publicBase.startsWith(s.ownerOrigin + '/')) {
    const base = s.publicBase.slice(s.ownerOrigin.length)
    if (path.startsWith(base)) return cors(req, () => serve(req, path.slice(base.length - 1), s, env))
  }
  return homeRoutes(req, path, s, env)
}

/**
 * Did the request come over HTTPS? The pull zone may pass the original scheme in the URL or
 * only in X-Forwarded-Proto (not documented; README, "Open questions").
 */
const isHttps = (req: Request, url: URL) => url.protocol == 'https:' || req.headers.get('x-forwarded-proto')?.toLowerCase() == 'https'

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  // A misconfigured script would otherwise fail later with an obscure error.
  if (!env.files)
    return errorPage('Server misconfigured', 'The storage zone is not configured. Set STORAGE_ZONE, STORAGE_HOST and the secret ' +
      'STORAGE_ACCESS_KEY in the Edge Script\'s environment.', 500)
  const s = settings(env, url)
  if (!isHttps(req, url) && !s.allowHttp) {
    if (req.method == 'GET' || req.method == 'HEAD') return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301)
    return json({ error: 'https_required', message: 'PUPS works only over HTTPS' }, 403)
  }
  const host = url.host.toLowerCase()
  const onAuth = host == s.authHost
  const onOwner = host == s.ownerHost
  if (!onAuth && !onOwner) return errorPage('Unknown host', `This server answers for ${s.ownerHost}.`, 404)

  if (onOwner) await ensureMentionLink(s, env)
  const res = await ((onAuth ? authRoutes(req, url.pathname, s, env) : undefined) ?? (onOwner ? ownerRoutes(req, url, s, env) : undefined))
  if (res) return res
  // In auth subdomain mode, the auth host's root leads to the owner pages.
  if (onAuth && !onOwner && url.pathname == '/') return seeOther('/pups/')
  if (s.originUrl && onOwner) return fromOrigin(req, url, s.originUrl)
  return errorPage('Not found', 'This page does not exist.', 404)
}

/** Handles one request. The Edge Script entry point (main.ts) calls this for every request. */
export async function handle(req: Request, env: Env): Promise<Response> {
  let res: Response
  try {
    res = await route(req, env)
  } catch (e) {
    if (e instanceof HttpError) res = e.response()
    else {
      console.error(e)
      res = json({ error: 'server_error', message: 'Internal server error' }, 500)
    }
  }
  if (isHttps(req, new URL(req.url)) && !res.headers.has('strict-transport-security')) {
    res = new Response(res.body, res)
    res.headers.set('Strict-Transport-Security', HSTS)
  }
  return res
}
