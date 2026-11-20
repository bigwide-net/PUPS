import fs from 'fs';
import path from 'path';

export const SPEC_VERSION = '0.1';
/** Link relation of the configuration document in host-meta.json (placeholder, see RFC-6). */
export const PUPS_REL = 'https://bigwide.net/ns/personal-storage';
/** Ownership marker property on links that PUPS added for an app. */
export const PUPS_CLIENT_PROP = 'https://bigwide.net/ns/pups#client';
export const PUPS_PROP_PREFIX = 'https://bigwide.net/ns/pups#';
export const CONFIG_PATH = '/personal-storage.json';
/** Uploads live at the root of the owner's domain: storage path /appdata/x/a.json is https://<host>/appdata/x/a.json. */
export const STORAGE_PREFIX = '/';
export const HOST_META_PATH = '/.well-known/host-meta.json';

/**
 * A declared well-known path. `path`, `url`, `rels`, `properties` and `linkProperties` (the
 * properties apps may set on their links) are published in the configuration document; `singleRels` (rels that allow only one link) and `urlProperties`
 * (properties whose value must be the URL of one of the app's files) stay on the server.
 */
export interface WellKnownEntry {
    path: string;
    url?: string;
    rels: string[];
    properties: string[];
    linkProperties: string[];
    singleRels: string[];
    urlProperties: string[];
}

export interface PupsConfig {
    /** The owner's origin, e.g. `https://alice.pups.test`. */
    origin: string;
    /** Host of the owner's domain (with port only if it isn't the default one). */
    host: string;
    /** `https://alice.pups.test/`: the owner's identity, returned as `me`. */
    me: string;
    /** OAuth issuer. Same-domain mode only, so it is the origin. */
    issuer: string;
    storageBase: string;
    publicBase: string;
    configUrl: string;
    /** Port to listen on (on all interfaces: macOS lets unprivileged processes bind port 443 only there). */
    port: number;
    /** Accept connections from other machines. Default: loopback only. */
    allowRemote: boolean;
    /** Paths of the TLS certificate and key. Without them the server speaks plain HTTP. */
    tlsCert?: string;
    tlsKey?: string;
    /** The owner password, from the environment. */
    password: string;
    /** Holds `state.json` (grants, tokens, codes) and `files/` (uploads and host-meta.json). */
    dataDir: string;
    maxUploadBytes: number;
    wellKnown: WellKnownEntry[];
    /** Declare `post_endpoint`, so clients send writes through POST. */
    postFallback: boolean;
    /** Development: fetch client metadata documents from private addresses (e.g. app.pups.test → 127.0.0.1). */
    allowPrivateClients: boolean;
    /** Additional CA certificate (PEM file) to trust when fetching client metadata documents, e.g. mkcert's. */
    extraCa?: string;
}

/** Files under /.well-known/ that may never be declared as well-known paths. */
const FORBIDDEN_WELL_KNOWN = new Set([
    'host-meta', 'host-meta.json', 'webfinger', 'oauth-authorization-server', 'openid-configuration',
    'security.txt', 'change-password', 'oauth-protected-resource', 'did.json', 'nodeinfo',
    'apple-app-site-association', 'assetlinks.json', 'mta-sts.txt', 'openpgpkey', 'acme-challenge',
]);

const NS = 'https://bigwide.net/ns/';
/** The only well-known directories under the server's own /pups/: the site's profile images and pages, */
export const IMAGES_PATH = '/pups/images/';
export const PAGES_PATH = '/pups/pages/';
/** and paths inside the private area for files that extensions of RFC-6 define (RFC-6 "Private areas"). */
export const PRIVATE_PATH = '/pups/private/';

/** The list of well-known paths (RFC-6), all served at the domain root. */
const defaultWellKnown = (origin: string) => [
    { path: '/.well-known/following.opml' },
    { path: '/.well-known/about.md', properties: ['name', 'title', 'summary', 'theme-color', 'language'].map(p => NS + p) },
    { path: '/.well-known/contact.vcf' },
    { path: '/feed.json', rels: [`${NS}feed`] },
    { path: '/feed/', rels: [`${NS}feed`] },
    { path: IMAGES_PATH, properties: [`${NS}avatar`, `${NS}banner`], url_properties: [`${NS}avatar`, `${NS}banner`] },
    { path: PAGES_PATH, rels: [`${NS}webpup-pages`], link_properties: [`${NS}webpup-hidden`], properties: [`${NS}webpup-footer`], url_properties: [`${NS}webpup-footer`] },
].map(e => ({ ...e, url: origin + e.path }));

const strings = (v: unknown, what: string) => {
    if (v == undefined)
        return [];
    if (!Array.isArray(v) || v.some(x => typeof x != 'string'))
        throw new Error(`${what} must be an array of strings`);
    return v as string[];
};

/** Parses and validates PUPS_WELL_KNOWN_PATHS. Throws on configuration errors. */
export function parseWellKnown(json: string | undefined, origin: string): WellKnownEntry[] {
    const raw = json?.trim() ? JSON.parse(json) : defaultWellKnown(origin);
    if (!Array.isArray(raw))
        throw new Error('PUPS_WELL_KNOWN_PATHS must be a JSON array');
    return raw.map((e: any): WellKnownEntry => {
        const p = e?.path;
        if (typeof p != 'string' || !/^\/(?:[A-Za-z0-9\-._~]+\/)*[A-Za-z0-9\-._~]*$/.test(p) || p == '/')
            throw new Error(`Invalid well-known path: ${JSON.stringify(p)}`);
        const segments = p.split('/').slice(1).filter(Boolean);
        if (segments.some(s => s == '.' || s == '..'))
            throw new Error(`Invalid well-known path: ${p}`);
        if (segments[0] == 'appdata')
            throw new Error(`Well-known paths can't be under /appdata/: ${p}`);
        // Storage is at the domain root, next to the server's own endpoints. /pups/images/, /pups/pages/ and
        // paths inside /pups/private/ are free for uploads.
        const isPrivate = p.startsWith(PRIVATE_PATH) && p != PRIVATE_PATH;
        if (segments[0] == 'oauth' || segments[0] == 'pups' && !p.startsWith(IMAGES_PATH) && !p.startsWith(PAGES_PATH) && !isPrivate || p == CONFIG_PATH)
            throw new Error(`Well-known paths can't overlap the server's endpoints (/oauth/, /pups/ except ${IMAGES_PATH}, ${PAGES_PATH} and paths inside ${PRIVATE_PATH}, ${CONFIG_PATH}): ${p}`);
        if (segments[0] == '.well-known') {
            if (p.endsWith('/') || segments.length != 2)
                throw new Error(`Only single files may be declared under /.well-known/: ${p}`);
            if (FORBIDDEN_WELL_KNOWN.has(segments[1]))
                throw new Error(`Forbidden well-known path: ${p}`);
        } else if (segments.some(s => s.startsWith('.')))
            throw new Error(`Dot segments are only allowed for /.well-known/ files: ${p}`);
        if (e.url != undefined && (typeof e.url != 'string' || !e.url.startsWith(origin + '/') || p.endsWith('/') != e.url.endsWith('/')))
            throw new Error(`The url of well-known path ${p} must be on ${origin} and end with / exactly if the path does`);
        const properties = strings(e.properties, 'properties');
        const linkProperties = strings(e.link_properties, 'link_properties');
        if ([...properties, ...linkProperties].some(x => x.startsWith(PUPS_PROP_PREFIX)))
            throw new Error(`PUPS properties can't be declared: ${p}`);
        const entry = {
            path: p, url: e.url, rels: strings(e.rels, 'rels'), properties, linkProperties,
            singleRels: strings(e.single_rels, 'single_rels'), urlProperties: strings(e.url_properties, 'url_properties'),
        };
        // Private files are never linked and have no public URL.
        if (isPrivate && (entry.url != undefined || [entry.rels, properties, linkProperties, entry.singleRels, entry.urlProperties].some(x => x.length)))
            throw new Error(`Private paths have no url, rels, properties, link_properties or url_properties: ${p}`);
        return entry;
    });
}

const int = (value: string | undefined, fallback: number) => {
    const parsed = parseInt(value ?? '', 10);
    return parsed > 0 ? parsed : fallback;
};

/** Reads the configuration from the environment (see .env.example). Throws on errors. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PupsConfig {
    const url = new URL(env.PUPS_ORIGIN || 'https://alice.pups.test');
    if (url.protocol != 'https:' && url.protocol != 'http:' || url.pathname != '/' || url.search || url.hash || url.username)
        throw new Error('PUPS_ORIGIN must be an origin like https://alice.pups.test, without path');
    const origin = url.origin;
    const password = env.PUPS_PASSWORD ?? '';
    if (password.length < 8)
        throw new Error('PUPS_PASSWORD must be set, with at least 8 characters');
    const tlsCert = env.PUPS_TLS_CERT || undefined, tlsKey = env.PUPS_TLS_KEY || undefined;
    if (!tlsCert != !tlsKey)
        throw new Error('Set both PUPS_TLS_CERT and PUPS_TLS_KEY, or neither');
    const extraCa = env.PUPS_EXTRA_CA || undefined;
    for (const file of [tlsCert, tlsKey, extraCa])
        if (file && !fs.existsSync(file))
            throw new Error(`File not found: ${file}`);
    const storageBase = `${origin}${STORAGE_PREFIX}`;
    let publicBase = env.PUPS_PUBLIC_BASE || storageBase;
    if (!publicBase.endsWith('/'))
        publicBase += '/';
    return {
        origin, host: url.host, me: `${origin}/`, issuer: origin, storageBase, publicBase,
        configUrl: `${origin}${CONFIG_PATH}`,
        port: int(env.PUPS_PORT, int(url.port, tlsCert ? 443 : 8080)),
        allowRemote: env.PUPS_ALLOW_REMOTE == 'true',
        tlsCert, tlsKey, password,
        dataDir: path.resolve(env.PUPS_DATA_DIR || 'data'),
        maxUploadBytes: int(env.PUPS_MAX_UPLOAD_BYTES, 26214400),
        wellKnown: parseWellKnown(env.PUPS_WELL_KNOWN_PATHS, origin),
        postFallback: env.PUPS_POST_FALLBACK == 'true',
        allowPrivateClients: env.PUPS_ALLOW_PRIVATE_CLIENTS == 'true',
        extraCa,
    };
}
