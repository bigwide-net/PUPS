import { authenticate, requireScope } from './files'
import { HttpError, json, methodNotAllowed, readLimited } from './http'
import { appdataPrefix, covers, isPrivate, pathFromPublicUrl, writePrefixes } from './paths'
import { mentionLink, MENTION_REL } from 'pups-inbox'
import { hasUnsafeChars, POST_URL_TEMPLATE_PROP, webpupPostUrlTemplate } from 'pups-ui'
import { type Env, PUPS_CLIENT_PROP, PUPS_PROP_PREFIX, PUPS_REL, type Settings, store } from './settings'
import type { Grant } from './store'

/**
 * host-meta.json is the domain's index and the source of truth: PUPS keeps no separate
 * registry, never touches the owner's links, and changes the file only with a conditional
 * read-modify-write.
 */

export const HOST_META_KEY = '.well-known/host-meta.json'
const MAX_LINKS = 1000
const MAX_APPDATA_LINKS = 10
const MAX_ATTEMPTS = 5
/** host-meta.json may be edited by hand; larger files are neither read nor changed. */
const MAX_HOST_META_BYTES = 1024 * 1024
const tooLargeMessage = `host-meta.json is larger than ${MAX_HOST_META_BYTES} bytes`

/** Rels nobody may register through PUPS: discovery and identity relations. */
const RESERVED_RELS = new Set([
  PUPS_REL, 'http://webfinger.net/rel/profile-page', 'http://webfinger.net/rel/avatar', 'me', 'self', 'lrdd',
  'authorization_endpoint', 'token_endpoint', 'indieauth-metadata', 'micropub', 'openid', 'openid2.provider',
  'http://openid.net/specs/connect/1.0/issuer',
])

export interface Link {
  rel: string
  href?: string
  type?: string
  titles?: Record<string, string>
  properties?: Record<string, string | null>
  [k: string]: unknown
}

export interface HostMeta {
  links?: Link[]
  properties?: Record<string, string | null>
  [k: string]: unknown
}

export const pupsLink = (s: Settings): Link => ({ rel: PUPS_REL, type: 'application/json', href: s.configUrl })
/** The generated host-meta.json: the PUPS link, and the mention link of the built-in receiver (RFC-11). */
const defaultHostMeta = (s: Settings): HostMeta => ({ links: [pupsLink(s), ...s.mentions ? [mentionLink({ base: s.ownerOrigin })] : []] })

/** GET /.well-known/host-meta.json: the stored file, or a generated one with the PUPS link. */
export async function serveHostMeta(req: Request, s: Settings, env: Env): Promise<Response> {
  if (req.method != 'GET' && req.method != 'HEAD') throw methodNotAllowed('GET, HEAD, OPTIONS')
  const obj = await env.FILES.get(HOST_META_KEY)
  const headers = {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
    ...obj && { etag: obj.httpEtag },
  }
  return new Response(req.method == 'HEAD' ? null : obj ? obj.body : JSON.stringify(defaultHostMeta(s), null, 2), { headers })
}

export async function readHostMeta(s: Settings, env: Env): Promise<{ doc: HostMeta; stored: boolean; error?: string }> {
  const obj = await env.FILES.get(HOST_META_KEY)
  if (!obj) return { doc: defaultHostMeta(s), stored: false }
  if (obj.size > MAX_HOST_META_BYTES) return { doc: {}, stored: true, error: tooLargeMessage }
  try {
    return { doc: parse(await obj.text()), stored: true }
  } catch (e) {
    return { doc: {}, stored: true, error: (e as Error).message }
  }
}

function parse(text: string): HostMeta {
  const doc = JSON.parse(text)
  if (!doc || typeof doc != 'object' || Array.isArray(doc)) throw new Error('host-meta.json is not a JSON object')
  if (doc.links != undefined && !Array.isArray(doc.links)) throw new Error('links in host-meta.json is not an array')
  if (doc.properties != undefined && (typeof doc.properties != 'object' || Array.isArray(doc.properties)))
    throw new Error('properties in host-meta.json is not an object')
  return doc
}

/**
 * Conditional read-modify-write. `fn` changes the document and returns whether it changed.
 * If the file changed in between, it is reread and `fn` runs again.
 */
export async function modifyHostMeta(s: Settings, env: Env, fn: (doc: HostMeta) => boolean, createIfMissing = true): Promise<void> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const obj = await env.FILES.get(HOST_META_KEY)
    if (!obj && !createIfMissing) return
    if (obj && obj.size > MAX_HOST_META_BYTES) throw new HttpError(409, 'invalid_host_meta', tooLargeMessage)
    let doc: HostMeta
    try {
      doc = obj ? parse(await obj.text()) : defaultHostMeta(s)
    } catch (e) {
      throw new HttpError(409, 'invalid_host_meta', `host-meta.json can't be changed: ${(e as Error).message}`)
    }
    if (!fn(doc)) return
    const put = await env.FILES.put(HOST_META_KEY, JSON.stringify(doc, null, 2), {
      onlyIf: obj ? { etagMatches: obj.etag } : new Headers({ 'if-none-match': '*' }),
      httpMetadata: { contentType: 'application/json' },
    })
    if (put) return
  }
  throw new HttpError(409, 'conflict', 'host-meta.json changed concurrently; try again')
}

const owner = (l: Link) => l.properties?.[PUPS_CLIENT_PROP]
const hasControl = hasUnsafeChars

/** An href from a request, in its canonical URL form (ASCII, percent-encoded), as stored in host-meta.json. */
function canonicalHref(href: unknown): string {
  try {
    if (typeof href == 'string' && href.length <= 2048 && !hasUnsafeChars(href) && /^https?:\/\//.test(href)) return new URL(href).href
  } catch {}
  throw new HttpError(400, 'invalid_request', 'href must be an http(s) URL without control or invisible characters')
}

function relOnClientHost(rel: string, clientHost: string): boolean {
  try {
    const u = new URL(rel)
    const h = u.host
    return (u.protocol == 'https:' || u.protocol == 'http:') &&
      (h == clientHost || h == `www.${clientHost}` || (clientHost.startsWith('www.') && h == clientHost.slice(4)))
  } catch {
    return false
  }
}

/** Maps an href (or a URL property value) to a path inside the grant's scope, never a private file, or throws 403. */
function ownFile(href: unknown, grant: Grant, s: Settings): string {
  if (typeof href != 'string' || href.length > 2048) throw new HttpError(400, 'invalid_request', 'href must be a URL')
  const path = pathFromPublicUrl(href, s)
  if (!path) throw new HttpError(403, 'insufficient_scope', 'href must be the public URL of a file on this server')
  if (isPrivate(path)) throw new HttpError(403, 'forbidden', "Private files can't be linked")
  requireScope(grant, path)
  return path
}

const MAX_TITLES = 20

/** `titles` of a request (RFC 7033: a language tag or "default" → a title), or undefined. */
function linkTitles(titles: unknown): Record<string, string> | undefined {
  if (titles == undefined) return
  const entries = titles && typeof titles == 'object' && !Array.isArray(titles) ? Object.entries(titles) : undefined
  if (!entries || entries.length > MAX_TITLES || entries.some(([k, v]) =>
    !/^(default|[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*)$/.test(k) || typeof v != 'string' || !v || v.length > 255 || hasControl(v)))
    throw new HttpError(400, 'invalid_request', `titles must map at most ${MAX_TITLES} language tags or "default" to titles of at most 255 characters`)
  return entries.length ? Object.fromEntries(entries) as Record<string, string> : undefined
}

/** `properties` of a request: only the declared link properties of the well-known path. */
function linkProperties(props: unknown, allowed: string[]): Record<string, string> {
  if (props == undefined) return {}
  const entries = props && typeof props == 'object' && !Array.isArray(props) ? Object.entries(props) : undefined
  if (!entries) throw new HttpError(400, 'invalid_request', 'properties must be an object')
  for (const [k, v] of entries) {
    if (!allowed.includes(k)) throw new HttpError(403, 'property_not_allowed', `The link property ${k.slice(0, 512)} is not allowed for this link`)
    if (typeof v != 'string' || !v || v.length > 2048 || hasControl(v))
      throw new HttpError(400, 'invalid_request', 'Link property values must be non-empty strings of at most 2048 characters without control or invisible characters')
  }
  return Object.fromEntries(entries) as Record<string, string>
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) == JSON.stringify(b)

function addLink(doc: HostMeta, body: any, grant: Grant, s: Settings): boolean {
  const { rel, type } = body
  if (typeof rel != 'string' || !rel || rel.length > 512 || hasControl(rel)) throw new HttpError(400, 'invalid_request', 'rel is required')
  const href = canonicalHref(body.href)
  if (type != undefined && (typeof type != 'string' || type.length > 255))
    throw new HttpError(400, 'invalid_request', 'type must be a media type of at most 255 characters')
  if (type != undefined && (typeof type != 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(type)))
    throw new HttpError(400, 'invalid_request', 'type must be a media type')
  if (RESERVED_RELS.has(rel)) throw new HttpError(403, 'rel_not_allowed', 'This link relation is reserved')
  const path = ownFile(href, grant, s)
  const links = doc.links ??= []
  const prefix = appdataPrefix(grant.clientHost)
  const appdata = covers(prefix, path)
  const entry = appdata ? undefined : s.wellKnown.find(e => covers(e.path, path))
  if (appdata) {
    if (!relOnClientHost(rel, grant.clientHost))
      throw new HttpError(403, 'rel_not_allowed', `Links to the app's own data must use a URI rel on ${grant.clientHost}`)
  } else {
    if (!entry?.rels.includes(rel)) throw new HttpError(403, 'rel_not_allowed', 'This rel is not allowed for this well-known path')
    if (entry.singleRels.includes(rel) && links.some(l => l.rel == rel && l.href != href))
      throw new HttpError(409, 'conflict', 'This rel allows only one link, and one exists already')
  }
  const titles = linkTitles(body.titles)
  const props = linkProperties(body.properties, entry?.linkProperties ?? [])
  const link: Link = { rel, href, ...type && { type }, ...titles && { titles }, properties: { ...props, [PUPS_CLIENT_PROP]: grant.clientId } }
  const existing = links.find(l => l.rel == rel && l.href == href)
  if (existing) {
    // The app's own link takes the request's type, titles and properties; anyone else's stays.
    if (owner(existing) != grant.clientId) {
      if (body.titles != undefined || body.properties != undefined)
        throw new HttpError(409, 'conflict', "This link exists already and belongs to the owner or another app; it can't be changed")
      return false
    }
    const { rel: _r, href: _h, type: _t, titles: _ti, properties: _p, ...rest } = existing
    if (sameJson({ ...link, ...rest }, existing)) return false
    Object.keys(existing).forEach(k => delete existing[k])
    Object.assign(existing, link, rest)
    return true
  }
  if (links.length >= MAX_LINKS) throw new HttpError(413, 'limit_reached', `host-meta.json has ${MAX_LINKS} links already`)
  if (appdata) {
    const mine = links.filter(l => owner(l) == grant.clientId && typeof l.href == 'string' && covers(prefix, pathFromPublicUrl(l.href, s) ?? ''))
    if (mine.length >= MAX_APPDATA_LINKS) throw new HttpError(413, 'limit_reached', `At most ${MAX_APPDATA_LINKS} links to an app's own data`)
  }
  links.push(link)
  return true
}

/**
 * Puts the links of one rel into the order of `hrefs`, in the positions they occupy. `hrefs`
 * must name every link of the rel exactly once, the owner's and other apps' included.
 */
function orderLinks(doc: HostMeta, body: any, grant: Grant, s: Settings): boolean {
  const { rel, hrefs } = body
  if (typeof rel != 'string' || !rel || rel.length > 512 || hasControl(rel)) throw new HttpError(400, 'invalid_request', 'rel is required')
  if (!Array.isArray(hrefs) || hrefs.length > MAX_LINKS) throw new HttpError(400, 'invalid_request', 'hrefs must be an array of URLs')
  const prefixes = writePrefixes(grant.scope)
  if (!s.wellKnown.some(e => e.rels.includes(rel) && prefixes.includes(e.path)) &&
    !(relOnClientHost(rel, grant.clientHost) && prefixes.includes(appdataPrefix(grant.clientHost))))
    throw new HttpError(403, 'rel_not_allowed', 'The granted scopes allow no links of this rel')
  const wanted = hrefs.map(canonicalHref)
  const links = doc.links ?? []
  const slots = links.flatMap((l, i) => l.rel == rel ? [i] : [])
  const current = slots.map(i => links[i].href)
  if (new Set(wanted).size != wanted.length || wanted.length != current.length || wanted.some(h => !current.includes(h)))
    throw new HttpError(409, 'conflict', 'hrefs must list every link of this rel exactly once; reread host-meta.json')
  const ordered = wanted.map(h => links[slots[current.indexOf(h)]])
  if (ordered.every((l, n) => l == links[slots[n]])) return false
  slots.forEach((i, n) => links[i] = ordered[n])
  return true
}

function removeLink(doc: HostMeta, body: any, grant: Grant): boolean {
  const { rel } = body
  if (typeof rel != 'string' || rel.length > 512) throw new HttpError(400, 'invalid_request', 'rel and href are required')
  const href = canonicalHref(body.href)
  const before = doc.links?.length ?? 0
  doc.links = doc.links?.filter(l => !(l.rel == rel && l.href == href && owner(l) == grant.clientId))
  return (doc.links?.length ?? 0) != before
}

function setProperty(doc: HostMeta, body: any, grant: Grant, s: Settings): boolean {
  const { property, value } = body
  if (typeof property != 'string' || !property || property.length > 512 || hasControl(property))
    throw new HttpError(400, 'invalid_request', 'property must be a URI of at most 512 characters')
  if (property.startsWith(PUPS_PROP_PREFIX)) throw new HttpError(403, 'property_not_allowed', "PUPS's own properties can't be set")
  const prefixes = writePrefixes(grant.scope)
  const entries = s.wellKnown.filter(e => e.properties.includes(property) && prefixes.includes(e.path))
  if (!entries.length) throw new HttpError(403, 'property_not_allowed', 'This property is not allowed for the granted scopes')
  if (typeof value != 'string' || !value || value.length > 2048 || hasControl(value))
    throw new HttpError(400, 'invalid_request', 'value must be a non-empty string of at most 2048 characters without control or invisible characters')
  if (entries.some(e => e.urlProperties.includes(property))) ownFile(value, grant, s)
  const props = doc.properties ??= {}
  if (props[property] == value) return false
  props[property] = value
  return true
}

/** POST <host_meta_endpoint>: apps add and order links and set properties in host-meta.json. */
export async function hostMetaEndpoint(req: Request, s: Settings, env: Env): Promise<Response> {
  if (req.method != 'POST') throw methodNotAllowed('POST, OPTIONS')
  const grant = await authenticate(req, s, env, true)
  const raw = await readLimited(req.body, 16 * 1024)
  let body: any
  try {
    body = JSON.parse(new TextDecoder().decode(raw!))
  } catch {
    throw new HttpError(400, 'invalid_request', 'The body must be a JSON object')
  }
  switch (typeof body?.action == 'string' && body.action.length <= 256 ? body.action : undefined) {
    case 'add':
      await modifyHostMeta(s, env, doc => addLink(doc, body, grant, s))
      return json({ ok: true }, 201)
    case 'remove':
      await modifyHostMeta(s, env, doc => removeLink(doc, body, grant), false)
      return new Response(null, { status: 204 })
    case 'set-property':
      await modifyHostMeta(s, env, doc => setProperty(doc, body, grant, s))
      return json({ ok: true }, 201)
    case 'order':
      await modifyHostMeta(s, env, doc => orderLinks(doc, body, grant, s))
      return new Response(null, { status: 204 })
    default:
      throw new HttpError(400, 'invalid_request', 'action must be add, remove, set-property or order')
  }
}

/**
 * After a grant is revoked and the app has no other grant: remove its links to its own
 * data; its well-known links stay (the files stay too) and become the owner's.
 * Properties are never removed.
 */
export async function onGrantRevoked(clientId: string, s: Settings, env: Env): Promise<void> {
  if (await store(env).clientHasGrant(clientId)) return
  try {
    await modifyHostMeta(s, env, doc => {
      let changed = false
      doc.links = doc.links?.filter(l => {
        if (owner(l) != clientId) return true
        changed = true
        const path = typeof l.href == 'string' ? pathFromPublicUrl(l.href, s) : undefined
        if (path?.startsWith('/appdata/')) return false
        delete l.properties![PUPS_CLIENT_PROP]
        if (!Object.keys(l.properties!).length) delete l.properties
        return true
      })
      return changed
    }, false)
  } catch (e) {
    // An invalid host-meta.json must not make revocation fail.
    console.error('host-meta cleanup failed', e)
  }
}

/** Environments (one per isolate in production) whose host-meta.json was checked for the mention link. */
const mentionLinkChecked = new WeakSet<Env>()

/**
 * Adds the mention link to a stored host-meta.json, once: at the first request with mentions on. If the owner removes
 * it later, it stays removed. Without a stored file, the generated one contains it (defaultHostMeta()).
 */
export async function ensureMentionLink(s: Settings, env: Env): Promise<void> {
  if (!s.mentions || mentionLinkChecked.has(env)) return
  const db = store(env)
  if (!await db.setting('mention-link')) {
    try {
      await modifyHostMeta(s, env, doc => {
        if (doc.links?.some(l => l?.rel == MENTION_REL)) return false
        doc.links = [...doc.links ?? [], mentionLink({ base: s.ownerOrigin })]
        return true
      }, false)
      await db.setSetting('mention-link', { href: mentionLink({ base: s.ownerOrigin }).href, at: new Date().toISOString() })
    } catch (e) {
      console.error('host-meta.json: adding the mention link failed', e)
      return
    }
  }
  mentionLinkChecked.add(env)
}

/**
 * Sets the post URL template in host-meta.json to webpup's (`on`), or removes it if it is still webpup's. Apps that
 * write the feeds then give new posts the URL of their page (RFC-7).
 */
export function setPostUrlTemplate(s: Settings, env: Env, on: boolean): Promise<void> {
  const template = webpupPostUrlTemplate(s.ownerOrigin)
  return modifyHostMeta(s, env, doc => {
    const props = doc.properties ??= {}
    if (on == (props[POST_URL_TEMPLATE_PROP] == template)) return false
    if (on) props[POST_URL_TEMPLATE_PROP] = template
    else delete props[POST_URL_TEMPLATE_PROP]
    return true
  }, on)
}
