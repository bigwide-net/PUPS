import { errorPage } from 'pups-ui'
import { filesEndpoint, isPrivateRaw, postEndpoint, serve } from './files'
import { hostMetaEndpoint, serveHostMeta } from './hostmeta'
import { cors, HttpError, htmlErrors, json, methodNotAllowed } from './http'
import { authorize, configDocument, oauthMetadata, revoke, token } from './oauth'
import { apps, login, logout, password, setup } from './owner'
import { covers } from './paths'
import { CONFIG_PATH, type Env, type Settings, settings, STORAGE_PREFIX } from './settings'

export { PupsStore } from './store'

const HSTS = 'max-age=31536000'

const getJson = (req: Request, body: () => unknown) => cors(req, () => {
  if (req.method != 'GET' && req.method != 'HEAD') throw methodNotAllowed('GET, HEAD, OPTIONS')
  return json(body(), 200, { 'cache-control': 'no-cache' })
})

/** Owner pages and OAuth endpoints, on the auth host (the owner host in same-domain mode). */
function authRoutes(req: Request, path: string, s: Settings, env: Env): Promise<Response> | undefined {
  switch (path) {
    case '/.well-known/oauth-authorization-server': return getJson(req, () => oauthMetadata(s))
    // The authorization endpoint and owner pages are never CORS-enabled.
    // Owner pages answer with HTML error pages, also for oversized values.
    case '/oauth/authorize': return htmlErrors(() => authorize(req, s, env))
    case '/oauth/token': return cors(req, () => token(req, s, env))
    case '/oauth/revoke': return cors(req, () => revoke(req, s, env))
    case '/pups/setup': return htmlErrors(() => setup(req, s, env))
    case '/pups/login': return htmlErrors(() => login(req, s, env))
    case '/pups/logout': return htmlErrors(() => logout(req, s, env))
    case '/pups/apps': return htmlErrors(() => apps(req, s, env))
    case '/pups/password': return htmlErrors(() => password(req, s, env))
    // /pups/assets/* (stylesheet and script) are static assets from public/.
  }
}

/** Discovery, the upload API and uploaded files, on the owner's domain. */
function ownerRoutes(req: Request, url: URL, s: Settings, env: Env): Promise<Response> | undefined {
  const path = url.pathname
  switch (path) {
    case '/.well-known/host-meta.json': return cors(req, () => serveHostMeta(req, s, env))
    case CONFIG_PATH: return getJson(req, () => configDocument(s))
    case '/pups/host-meta': return cors(req, () => hostMetaEndpoint(req, s, env))
    case '/pups/post': if (s.postFallback) return cors(req, () => postEndpoint(req, s, env))
  }
  if (path.startsWith(STORAGE_PREFIX)) return cors(req, () => filesEndpoint(req, path.slice(STORAGE_PREFIX.length - 1), s, env))
  // Well-known files with their own URL (e.g. /.well-known/about.md at the domain root).
  for (const e of s.wellKnown) {
    if (!e.url?.startsWith(s.ownerOrigin + '/')) continue
    const urlPath = e.url.slice(s.ownerOrigin.length)
    if (!covers(urlPath, path)) continue
    const raw = e.path + path.slice(urlPath.length)
    const file = () => cors(req, () => serve(req, raw, s, env))
    // In front of an existing website, a declared file that nobody has uploaded yet comes from the
    // origin. Never a private one: its 404 must not reveal or hide anything (RFC-6 "Private areas").
    return s.originFallback && !isPrivateRaw(raw, s) ? file().then(r => r.status == 404 ? fetch(req) : r) : file()
  }
  // A public_base on the owner's domain with another path than storage_base.
  if (s.publicBase.startsWith(s.ownerOrigin + '/')) {
    const base = s.publicBase.slice(s.ownerOrigin.length)
    if (path.startsWith(base)) return cors(req, () => serve(req, path.slice(base.length - 1), s, env))
  }
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  // A misconfigured wrangler.jsonc would otherwise fail later with an obscure error.
  if (!env.FILES || !env.STORE)
    return errorPage('Server misconfigured', `The ${env.FILES ? 'Durable Object binding STORE' : 'R2 binding FILES'} is missing. ` +
      'Check r2_buckets and durable_objects in wrangler.jsonc and deploy again.', 500)
  const s = settings(env, url)
  if (url.protocol != 'https:' && !s.allowHttp) {
    if (req.method == 'GET' || req.method == 'HEAD') return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301)
    return json({ error: 'https_required', message: 'PUPS works only over HTTPS' }, 403)
  }
  const host = url.host.toLowerCase()
  const onAuth = host == s.authHost
  const onOwner = host == s.ownerHost
  if (!onAuth && !onOwner) return errorPage('Unknown host', `This server answers for ${s.ownerHost}.`, 404)

  const res = (onAuth ? authRoutes(req, url.pathname, s, env) : undefined) ?? (onOwner ? ownerRoutes(req, url, s, env) : undefined)
  if (res) return res
  // Private paths never go to the origin, whatever the URL.
  if (s.originFallback && onOwner && !isPrivateRaw(url.pathname, s)) return fetch(req)
  return errorPage('Not found', 'This page does not exist.', 404)
}

export default {
  async fetch(req, env): Promise<Response> {
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
    if (new URL(req.url).protocol == 'https:' && !res.headers.has('strict-transport-security')) {
      res = new Response(res.body, res)
      res.headers.set('Strict-Transport-Security', HSTS)
    }
    return res
  },
} satisfies ExportedHandler<Env>
