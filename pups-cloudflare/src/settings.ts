import { isPrivate } from './paths'
import type { PupsStore } from './store'

export interface Env {
  STORE: DurableObjectNamespace<PupsStore>
  FILES: R2Bucket
  OWNER_HOST?: string
  AUTH_HOST?: string
  PUBLIC_BASE?: string
  MAX_UPLOAD_BYTES?: string
  MAX_STORAGE_BYTES?: string
  WRITES_PER_MINUTE?: string
  WELL_KNOWN_PATHS?: string
  POST_FALLBACK?: string
  ORIGIN_FALLBACK?: string
  DEV_ALLOW_HTTP?: string
  BOOTSTRAP_SECRET?: string
}

export const SPEC_VERSION = '0.1'
/** Link relation of the configuration document in host-meta.json (placeholder, see RFC-6). */
export const PUPS_REL = 'https://bigwide.net/ns/personal-storage'
/** Ownership marker property on links that PUPS added for an app. */
export const PUPS_CLIENT_PROP = 'https://bigwide.net/ns/pups#client'
export const PUPS_PROP_PREFIX = 'https://bigwide.net/ns/pups#'
export const CONFIG_PATH = '/personal-storage.json'
export const STORAGE_PREFIX = '/files/'

/**
 * A declared well-known path. `path`, `url`, `rels`, `properties` and `linkProperties` (the
 * properties apps may set on their links) are published in the configuration document; `single_rels` and `url_properties` are server-side knowledge
 * from the bigwide.net list of well-known paths (rels that may have only one link, and
 * properties whose value is a URL).
 */
export interface WellKnownEntry {
  path: string
  url?: string
  rels: string[]
  properties: string[]
  linkProperties: string[]
  singleRels: string[]
  urlProperties: string[]
  /** How the consent screen names the path, e.g. "your feed" (RFC-6 list of well-known paths). */
  description?: string
}

export interface Settings {
  /** Host of the owner's domain, e.g. `tim.example.com`. */
  ownerHost: string
  /** `https://tim.example.com` */
  ownerOrigin: string
  /** `https://tim.example.com/`, the identity returned as `me`. */
  me: string
  /** Host serving OAuth endpoints and owner pages (owner host in same-domain mode). */
  authHost: string
  issuer: string
  subdomainMode: boolean
  storageBase: string
  publicBase: string
  configUrl: string
  maxUploadBytes: number
  maxStorageBytes: number
  writesPerMinute: number
  wellKnown: WellKnownEntry[]
  postFallback: boolean
  originFallback: boolean
  allowHttp: boolean
  /** WebAuthn relying party ID. */
  rpId: string
}

/** Files under /.well-known/ that may never be declared as well-known paths. */
const FORBIDDEN_WELL_KNOWN = new Set([
  'host-meta', 'host-meta.json', 'webfinger', 'oauth-authorization-server', 'openid-configuration',
  'security.txt', 'change-password', 'oauth-protected-resource', 'did.json', 'nodeinfo',
  'apple-app-site-association', 'assetlinks.json', 'mta-sts.txt', 'openpgpkey',
])

const NS = 'https://bigwide.net/ns/'
/**
 * The only well-known directories under the server's own /pups/: the site's profile images and pages,
 * and paths strictly inside /pups/private/ (RFC-6 "Private areas").
 */
const PUPS_DIRS = ['/pups/images/', '/pups/pages/', '/pups/private/']
/** Fields a private well-known entry can't have: private files are never linked. */
const PRIVATE_FORBIDDEN = ['url', 'rels', 'properties', 'link_properties', 'url_properties']

/** The list of well-known paths (RFC-6), served at the domain root, with the consent screen's wording. */
const DEFAULT_WELL_KNOWN = (origin: string) => [
  { path: '/.well-known/following.opml', description: 'the list of people you follow' },
  { path: '/.well-known/about.md', properties: ['name', 'title', 'summary', 'theme-color', 'language'].map(p => NS + p), description: 'your profile' },
  { path: '/.well-known/contact.vcf', description: 'your contact details' },
  { path: '/feed.json', rels: [`${NS}feed`], description: 'your feed' },
  { path: '/feed/', rels: [`${NS}feed`], description: 'the files of your feed, and your other feeds' },
  { path: '/pups/images/', properties: [`${NS}avatar`, `${NS}banner`], url_properties: [`${NS}avatar`, `${NS}banner`], description: "your site's profile images" },
  { path: '/pups/pages/', rels: [`${NS}webpup-pages`], link_properties: [`${NS}webpup-hidden`], properties: [`${NS}webpup-footer`], url_properties: [`${NS}webpup-footer`], description: "your site's pages" },
].map(e => ({ ...e, url: origin + e.path }))

const strings = (v: unknown, what: string) => {
  if (v == undefined) return []
  if (!Array.isArray(v) || v.some(x => typeof x != 'string')) throw new Error(`${what} must be an array of strings`)
  return v as string[]
}

/** Parses and validates WELL_KNOWN_PATHS. Throws on configuration errors. */
export function parseWellKnown(json: string | undefined, origin: string): WellKnownEntry[] {
  const raw = json?.trim() ? JSON.parse(json) : DEFAULT_WELL_KNOWN(origin)
  if (!Array.isArray(raw)) throw new Error('WELL_KNOWN_PATHS must be a JSON array')
  return raw.map((e: any): WellKnownEntry => {
    const path = e?.path
    if (typeof path != 'string' || !/^\/(?:[A-Za-z0-9\-._~]+\/)*[A-Za-z0-9\-._~]*$/.test(path) || path == '/')
      throw new Error(`Invalid well-known path: ${JSON.stringify(path)}`)
    const segments = path.split('/').slice(1).filter(Boolean)
    if (segments.some(s => s == '.' || s == '..')) throw new Error(`Invalid well-known path: ${path}`)
    if (segments[0] == 'appdata') throw new Error(`Well-known paths can't be under /appdata/: ${path}`)
    if (segments[0] == 'pups' && (!PUPS_DIRS.some(d => path.startsWith(d)) || path == '/pups/private/'))
      throw new Error(`/pups/ belongs to the server; only /pups/images/, /pups/pages/ and paths inside /pups/private/ may be declared: ${path}`)
    if (isPrivate(path) && PRIVATE_FORBIDDEN.some(f => e[f] != undefined))
      throw new Error(`Private well-known paths can't have ${PRIVATE_FORBIDDEN.join(', ')}: ${path}`)
    if (segments[0] == '.well-known') {
      if (path.endsWith('/') || segments.length != 2) throw new Error(`Only single files may be declared under /.well-known/: ${path}`)
      if (FORBIDDEN_WELL_KNOWN.has(segments[1]) || segments[1] == 'acme-challenge') throw new Error(`Forbidden well-known path: ${path}`)
    } else if (segments.some(s => s.startsWith('.'))) throw new Error(`Dot segments are only allowed for /.well-known/ files: ${path}`)
    if (e.url != undefined && (typeof e.url != 'string' || !/^https?:\/\//.test(e.url) || path.endsWith('/') != e.url.endsWith('/')))
      throw new Error(`Invalid url for well-known path ${path}`)
    const properties = strings(e.properties, 'properties')
    const linkProperties = strings(e.link_properties, 'link_properties')
    if ([...properties, ...linkProperties].some(p => p.startsWith(PUPS_PROP_PREFIX))) throw new Error(`PUPS properties can't be declared: ${path}`)
    return {
      path, url: e.url, rels: strings(e.rels, 'rels'), properties, linkProperties,
      singleRels: strings(e.single_rels, 'single_rels'), urlProperties: strings(e.url_properties, 'url_properties'),
      description: typeof e.description == 'string' && e.description.trim() ? e.description.trim().slice(0, 100) : undefined,
    }
  })
}

const num = (v: string | undefined, dflt: number) => {
  const n = Number(v)
  return v?.trim() && Number.isFinite(n) && n >= 0 ? n : dflt
}

let cache: { key: string; settings: Settings } | undefined

/** Derives the effective settings from the environment and the request URL. */
export function settings(env: Env, url: URL): Settings {
  const allowHttp = env.DEV_ALLOW_HTTP == 'true'
  const scheme = allowHttp ? url.protocol : 'https:'
  const ownerHost = (env.OWNER_HOST?.trim() || url.host).toLowerCase()
  const key = `${ownerHost}|${scheme}|${JSON.stringify(env, (k, v) => k == 'STORE' || k == 'FILES' ? undefined : v)}`
  if (cache?.key == key) return cache.settings

  const authHostVar = env.AUTH_HOST?.trim().toLowerCase()
  if (authHostVar && !env.OWNER_HOST?.trim()) throw new Error('AUTH_HOST requires OWNER_HOST')
  const subdomainMode = !!authHostVar && authHostVar != ownerHost
  const authHost = subdomainMode ? authHostVar! : ownerHost
  const ownerOrigin = `${scheme}//${ownerHost}`
  const issuer = `${scheme}//${authHost}`
  const storageBase = `${ownerOrigin}${STORAGE_PREFIX}`
  let publicBase = env.PUBLIC_BASE?.trim() || storageBase
  if (!publicBase.endsWith('/')) publicBase += '/'
  // A public R2 bucket would serve private files without PUPS (RFC-6 "Private areas").
  if (/^https?:\/\/[^/]*\.r2\.dev(?:[:/]|$)/i.test(publicBase))
    throw new Error('PUBLIC_BASE must not be a public R2 bucket (r2.dev): it would serve private files without a token')
  // One passkey works in both modes when the auth host is a subdomain of the owner's domain.
  const rpId = (subdomainMode && !authHost.endsWith(`.${ownerHost}`) ? authHost : ownerHost).replace(/:\d+$/, '')
  const s: Settings = {
    ownerHost, ownerOrigin, me: `${ownerOrigin}/`, authHost, issuer, subdomainMode, storageBase, publicBase,
    configUrl: `${ownerOrigin}${CONFIG_PATH}`,
    maxUploadBytes: num(env.MAX_UPLOAD_BYTES, 26214400),
    maxStorageBytes: num(env.MAX_STORAGE_BYTES, 0),
    writesPerMinute: num(env.WRITES_PER_MINUTE, 120),
    wellKnown: parseWellKnown(env.WELL_KNOWN_PATHS, ownerOrigin),
    postFallback: env.POST_FALLBACK == 'true',
    originFallback: env.ORIGIN_FALLBACK == 'true',
    allowHttp, rpId,
  }
  cache = { key, settings: s }
  return s
}

/** The single Durable Object that holds all state of this installation. */
export const store = (env: Env) => env.STORE.get(env.STORE.idFromName('owner'))
