import { Store } from './state'
import { Files } from './storage'

/** Environment variables and secrets of the Edge Script (see README). */
export const ENV_KEYS = [
  'OWNER_HOST', 'AUTH_HOST', 'PUBLIC_BASE', 'MAX_UPLOAD_BYTES', 'MAX_STORAGE_BYTES', 'WRITES_PER_MINUTE', 'WELL_KNOWN_PATHS',
  'POST_FALLBACK', 'ORIGIN_URL', 'DEV_ALLOW_HTTP', 'BOOTSTRAP_SECRET', 'RECOVERY_SECRET', 'STORAGE_ZONE', 'STORAGE_HOST', 'STORAGE_ACCESS_KEY', 'DOH_URL',
  'MENTIONS', 'COMMENTS', 'WEBPUP_OWNER_LINK',
] as const

export interface Env {
  /** The storage zone, created from STORAGE_* by envFrom(). */
  files?: Files
  STORAGE_ZONE?: string
  /** Host of the storage zone's primary region, e.g. storage.bunnycdn.com or de.storage.bunnycdn.com. */
  STORAGE_HOST?: string
  /** The storage zone's password (secret). */
  STORAGE_ACCESS_KEY?: string
  /** DNS-over-HTTPS resolver (JSON API) for the SSRF check of client metadata fetches; "off" disables the check. */
  DOH_URL?: string
  OWNER_HOST?: string
  AUTH_HOST?: string
  PUBLIC_BASE?: string
  MAX_UPLOAD_BYTES?: string
  MAX_STORAGE_BYTES?: string
  WRITES_PER_MINUTE?: string
  WELL_KNOWN_PATHS?: string
  POST_FALLBACK?: string
  /** An existing website behind this server: unknown paths and missing declared files are fetched from here. */
  ORIGIN_URL?: string
  DEV_ALLOW_HTTP?: string
  BOOTSTRAP_SECRET?: string
  /** Set only to recover a lost login (/pups/recover); each value works once. */
  RECOVERY_SECRET?: string
  MENTIONS?: string
  COMMENTS?: string
  WEBPUP_OWNER_LINK?: string
  /** Runs work after the response (Bunny.v1.waitUntil, passed in by main.ts). */
  waitUntil?: (work: Promise<unknown>) => void
}

export const SPEC_VERSION = '0.1'
/** The configuration document's `implementation` (RFC-6); the version is package.json's (a test checks it). */
export const IMPLEMENTATION = { name: 'pups-bunny', version: '0.1.0' }
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
  /** ORIGIN_URL without a trailing slash, or undefined. */
  originUrl?: string
  allowHttp: boolean
  /** WebAuthn relying party ID. */
  rpId: string
  /** Receive mentions of the owner (RFC-11) at /pups/mention and put them into the inbox. */
  mentions: boolean
  /** Receive comments on the owner's feeds (RFC-4) at /pups/comments and put them into the inbox. */
  comments: boolean
  /** With webpup as the homepage: end the page with a link to the owner pages. */
  webpupOwnerLink: boolean
}

/** Files under /.well-known/ that may never be declared as well-known paths. */
const FORBIDDEN_WELL_KNOWN = new Set([
  'host-meta', 'host-meta.json', 'webfinger', 'oauth-authorization-server', 'openid-configuration',
  'security.txt', 'change-password', 'oauth-protected-resource', 'did.json', 'nodeinfo',
  'apple-app-site-association', 'assetlinks.json', 'mta-sts.txt', 'openpgpkey',
])

const NS = 'https://bigwide.net/ns/'
/**
 * The only well-known directories under the server's own /pups/: the site's profile images and
 * pages, and paths inside the private area /pups/private/.
 */
const PUPS_DIRS = ['/pups/images/', '/pups/pages/', '/pups/private/']
const PRIVATE_DIR = '/pups/private/'
/** Fields a private entry can't have: private files are never linked and have no public URL. */
const PUBLIC_FIELDS = ['url', 'rels', 'properties', 'link_properties', 'url_properties', 'single_rels']

/** The list of well-known paths (RFC-6), served at the domain root, with the consent screen's wording. */
const DEFAULT_WELL_KNOWN = (origin: string) => [
  { path: '/.well-known/following.opml', description: 'the list of people you follow' },
  { path: '/.well-known/about.md', properties: ['name', 'title', 'summary', 'theme-color', 'language'].map(p => NS + p), description: 'your profile' },
  { path: '/.well-known/contact.vcf', description: 'your contact details' },
  { path: '/feed.json', rels: [`${NS}feed`], description: 'your feed' },
  { path: '/feed/', rels: [`${NS}feed`], description: 'the files of your feed, and your other feeds' },
  { path: '/pups/images/', properties: [`${NS}avatar`, `${NS}banner`], url_properties: [`${NS}avatar`, `${NS}banner`], description: "your site's profile images" },
  { path: '/pups/pages/', rels: [`${NS}webpup-pages`], link_properties: [`${NS}webpup-hidden`, `${NS}webpup-homepage`], properties: [`${NS}webpup-footer`], url_properties: [`${NS}webpup-footer`], description: "your site's pages" },
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
    if (segments[0] == 'pups' && (!PUPS_DIRS.some(d => path.startsWith(d)) || path == PRIVATE_DIR))
      throw new Error(`/pups/ belongs to the server; only /pups/images/, /pups/pages/ and paths inside ${PRIVATE_DIR} may be declared: ${path}`)
    if (path.startsWith(PRIVATE_DIR) && PUBLIC_FIELDS.some(k => e[k] != undefined))
      throw new Error(`Private paths can't have ${PUBLIC_FIELDS.join(', ')}: ${path}`)
    if (segments[0] == '_pups') throw new Error(`/_pups/ holds the server's own state: ${path}`)
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

/** The inbox of RFC-12, which the built-in receiver writes: a private path, so it has nothing but the path. */
export const INBOX_WELL_KNOWN: WellKnownEntry = {
  path: '/pups/private/inbox.json', rels: [], properties: [], linkProperties: [], singleRels: [], urlProperties: [], description: 'your inbox',
}

/** A boolean variable: "true" or "false", or the default if it is empty. */
const bool = (v: string | undefined, dflt: boolean) => v?.trim() ? v.trim() == 'true' : dflt

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
  const key = `${ownerHost}|${scheme}|${JSON.stringify(env, (k, v) => k == 'files' ? undefined : v)}`
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
  // One passkey works in both modes when the auth host is a subdomain of the owner's domain.
  const rpId = (subdomainMode && !authHost.endsWith(`.${ownerHost}`) ? authHost : ownerHost).replace(/:\d+$/, '')
  const mentions = bool(env.MENTIONS, true), comments = bool(env.COMMENTS, true)
  const wellKnown = parseWellKnown(env.WELL_KNOWN_PATHS, ownerOrigin)
  // The receiver writes the inbox, so readers must be able to ask for it.
  if ((mentions || comments) && !wellKnown.some(e => e.path == INBOX_WELL_KNOWN.path)) wellKnown.push(INBOX_WELL_KNOWN)
  const s: Settings = {
    ownerHost, ownerOrigin, me: `${ownerOrigin}/`, authHost, issuer, subdomainMode, storageBase, publicBase,
    configUrl: `${ownerOrigin}${CONFIG_PATH}`,
    maxUploadBytes: num(env.MAX_UPLOAD_BYTES, 26214400),
    maxStorageBytes: num(env.MAX_STORAGE_BYTES, 0),
    writesPerMinute: num(env.WRITES_PER_MINUTE, 120),
    wellKnown,
    postFallback: env.POST_FALLBACK == 'true',
    originUrl: env.ORIGIN_URL?.trim().replace(/\/+$/, '') || undefined,
    allowHttp, rpId, mentions, comments,
    webpupOwnerLink: bool(env.WEBPUP_OWNER_LINK, true),
  }
  cache = { key, settings: s }
  return s
}

/** Reads the environment: Deno.env on Bunny (and in Deno), process.env in Node. */
export function envFrom(get: (key: string) => string | undefined): Env {
  const env: Env = Object.fromEntries(ENV_KEYS.map(k => [k, get(k)]).filter(([, v]) => v != undefined))
  if (env.STORAGE_ZONE && env.STORAGE_ACCESS_KEY)
    env.files = new Files(env.STORAGE_HOST?.trim() || 'storage.bunnycdn.com', env.STORAGE_ZONE.trim(), env.STORAGE_ACCESS_KEY.trim())
  return env
}

const stores = new WeakMap<Files, Store>()

/** The state of this installation, in the storage zone. */
export function store(env: Env): Store {
  const files = env.files!
  let s = stores.get(files)
  if (!s) stores.set(files, s = new Store(files))
  return s
}
