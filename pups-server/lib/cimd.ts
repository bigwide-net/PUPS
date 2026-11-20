import dns from 'dns';
import fs from 'fs';
import https from 'https';
import net from 'net';
import tls from 'tls';
import { PupsConfig } from './config';
import { log } from './log';
import { isCleanUrlString, isHostName, sanitizeText } from 'pups-ui';

/** A validated client metadata document (RFC-6 "Client identity"). */
export interface Client {
    clientId: string;
    /** The host of client_id: the only verified fact about the app. */
    clientHost: string;
    name?: string;
    uri?: string;
    logo?: string;
    redirectUris: string[];
}

export class ClientError extends Error {}

/** What a fetch of a client metadata document returns. Tests replace the fetch. */
export interface FetchedDoc {
    status: number;
    cacheControl?: string;
    /** Undefined if the body was larger than 64 KB. */
    body?: string;
}
export type FetchDoc = (url: string) => Promise<FetchedDoc>;

const MAX_DOC_BYTES = 64 * 1024;
const FETCH_TIMEOUT = 5000;
const MAX_CACHE_MS = 24 * 3600_000;
const MAX_REDIRECT_URIS = 20;
/** client_name may have this many characters; at most 100 are shown. */
const MAX_NAME_CHARS = 1000;

// --- SSRF protection ----------------------------------------------------------------------

const nonPublic = new net.BlockList();
for (const [net4, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const)
    nonPublic.addSubnet(net4, prefix, 'ipv4');
// No rule for IPv4-mapped addresses (::ffff:0:0/96): BlockList applies such rules to IPv4 addresses too.
for (const [net6, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
    ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const)
    nonPublic.addSubnet(net6, prefix, 'ipv6');

export function isPublicAddress(address: string, family: number): boolean {
    const mapped = /^::ffff:(.*)$/i.exec(address)?.[1];
    if (family == 6 && mapped)
        return net.isIPv4(mapped) && isPublicAddress(mapped, 4);
    return !nonPublic.check(address, family == 6 ? 'ipv6' : 'ipv4');
}

/**
 * A DNS lookup that refuses names resolving to non-public addresses. The connection uses
 * the address checked here, so DNS rebinding can't get around it.
 */
const safeLookup = (allowPrivate: boolean): net.LookupFunction => (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        const cb = callback as any;
        if (err)
            return cb(err);
        const list = addresses as dns.LookupAddress[];
        if (!allowPrivate && list.some(a => !isPublicAddress(a.address, a.family)))
            return cb(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: 'EPRIVATE' }));
        if (options.all)
            cb(null, list);
        else
            cb(null, list[0].address, list[0].family);
    });
};

/** Fetches a client metadata document over HTTPS: 5 s timeout, 64 KB limit, no redirects, public addresses only. */
export function httpsFetchDoc(config: PupsConfig): FetchDoc {
    const ca = config.extraCa ? [...tls.rootCertificates, fs.readFileSync(config.extraCa, 'utf8')] : undefined;
    return url => new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: { accept: 'application/json', 'user-agent': 'pups-server/0.1' },
            lookup: safeLookup(config.allowPrivateClients),
            timeout: FETCH_TIMEOUT,
            ca,
        }, res => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_DOC_BYTES)
                    return req.destroy(), resolve({ status: res.statusCode ?? 0 });
                chunks.push(chunk);
            });
            res.on('end', () => resolve({
                status: res.statusCode ?? 0, cacheControl: res.headers['cache-control'], body: Buffer.concat(chunks).toString('utf8'),
            }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

// --- Validation ---------------------------------------------------------------------------

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Validates a client_id URL. It must already be in canonical form. */
export function parseClientId(clientId: string, config: PupsConfig): URL {
    let u: URL;
    try {
        u = new URL(clientId);
    } catch {
        throw new ClientError('client_id is not a URL');
    }
    if (u.protocol != 'https:')
        throw new ClientError('client_id must be an HTTPS URL');
    if (u.username || u.password || u.port || u.search || u.hash || clientId.includes('?') || clientId.includes('#'))
        throw new ClientError('client_id must not contain user info, a port, a query or a fragment');
    if (u.pathname == '/')
        throw new ClientError('client_id must have a path');
    // The canonical serialization catches uppercase hosts, dot segments and other variants.
    if (u.href != clientId)
        throw new ClientError('client_id is not in canonical form (lowercase host, normalized path)');
    const host = u.hostname;
    if (IPV4.test(host) || host.startsWith('[') || !host.includes('.') || host == 'localhost' || host.endsWith('.localhost'))
        throw new ClientError('client_id must be on a domain name');
    if (!isHostName(host))
        throw new ClientError('The host of client_id may contain only letters, digits, hyphens and dots (IDNs in punycode)');
    if (u.host == config.host)
        throw new ClientError("client_id can't be on this server's own host");
    return u;
}

/** client_uri and logo_uri must be on the client host, with or without a leading `www.`. */
export function onClientHost(url: string, clientHost: string): boolean {
    if (!isCleanUrlString(url))
        return false;
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return false;
    }
    if (u.protocol != 'https:' || u.username || u.password)
        return false;
    const h = u.host;
    return h == clientHost || h == `www.${clientHost}` || clientHost.startsWith('www.') && h == clientHost.slice(4);
}

const isLoopback = (u: URL) => u.protocol == 'http:' && (u.hostname == '127.0.0.1' || u.hostname == '[::1]');

function validRedirectUri(r: unknown): r is string {
    if (!isCleanUrlString(r))
        return false;
    try {
        const u = new URL(r);
        return !u.hash && (u.protocol == 'https:' && isHostName(u.hostname) || isLoopback(u));
    } catch {
        return false;
    }
}

/** Validates a fetched client metadata document. */
export function validateMetadata(doc: any, clientId: string): Client {
    const clientHost = new URL(clientId).host;
    if (!doc || typeof doc != 'object' || Array.isArray(doc))
        throw new ClientError('The client metadata document is not a JSON object');
    if (doc.client_id !== clientId)
        throw new ClientError('client_id in the client metadata document does not match its URL');
    const redirectUris = doc.redirect_uris;
    if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.length > MAX_REDIRECT_URIS || !redirectUris.every(validRedirectUri))
        throw new ClientError(`redirect_uris must be a non-empty array of at most ${MAX_REDIRECT_URIS} HTTPS URLs with a DNS host name, or loopback (http://127.0.0.1, http://[::1]) URLs, without whitespace or control characters, each at most 2048 characters`);
    for (const f of ['client_uri', 'logo_uri'])
        if (doc[f] != undefined && (typeof doc[f] != 'string' || !onClientHost(doc[f], clientHost)))
            throw new ClientError(`${f} must be on the client host ${clientHost} (optionally with or without www.)`);
    if (doc.client_name != undefined && (typeof doc.client_name != 'string' || doc.client_name.length > MAX_NAME_CHARS))
        throw new ClientError(`client_name must be a string of at most ${MAX_NAME_CHARS} characters`);
    if (doc.token_endpoint_auth_method != undefined && doc.token_endpoint_auth_method != 'none')
        throw new ClientError('Only public clients (token_endpoint_auth_method "none") are supported');
    // The name is self-declared text: sanitized for display. URLs are stored in their canonical (ASCII) form.
    return {
        clientId, clientHost, redirectUris,
        name: sanitizeText(doc.client_name, 100),
        uri: doc.client_uri && new URL(doc.client_uri).href, logo: doc.logo_uri && new URL(doc.logo_uri).href,
    };
}

function cacheMs(cacheControl: string | undefined): number {
    if (!cacheControl || /no-store|no-cache|private/i.test(cacheControl))
        return 0;
    const m = /max-age=(\d+)/i.exec(cacheControl);
    return m ? Math.min(Number(m[1]) * 1000, MAX_CACHE_MS) : 0;
}

/** Loads client metadata documents, with an in-memory cache that follows Cache-Control (at most 24 hours). */
export class ClientLoader {
    private cache = new Map<string, { doc: unknown; expiresAt: number }>();
    private config: PupsConfig;
    private fetchDoc: FetchDoc;

    constructor(config: PupsConfig, fetchDoc: FetchDoc = httpsFetchDoc(config)) {
        this.config = config;
        this.fetchDoc = fetchDoc;
    }

    async load(clientId: string): Promise<Client> {
        parseClientId(clientId, this.config);
        const cached = this.cache.get(clientId);
        if (cached && cached.expiresAt > Date.now()) {
            log('cimd.cached', { clientId, expires: new Date(cached.expiresAt).toISOString() });
            return validateMetadata(cached.doc, clientId);
        }

        let res: FetchedDoc;
        try {
            res = await this.fetchDoc(clientId);
        } catch (e: any) {
            log('cimd.fetch-failed', { clientId, error: e?.message ?? String(e) });
            throw new ClientError(`The client metadata document at ${clientId} could not be fetched: ${e?.message ?? e}`);
        }
        log('cimd.fetched', { clientId, status: res.status, cacheControl: res.cacheControl, body: res.body });
        if (res.status >= 300 && res.status < 400)
            throw new ClientError('The client metadata document must be served without redirects');
        if (res.status != 200)
            throw new ClientError(`Fetching the client metadata document returned HTTP ${res.status}`);
        if (res.body == undefined)
            throw new ClientError('The client metadata document is larger than 64 KB');
        let doc: unknown;
        try {
            doc = JSON.parse(res.body);
        } catch {
            throw new ClientError('The client metadata document is not valid JSON');
        }
        let client: Client;
        try {
            client = validateMetadata(doc, clientId);
        } catch (e: any) {
            log('cimd.invalid', { clientId, error: e.message });
            throw e;
        }
        const ttl = cacheMs(res.cacheControl);
        if (ttl)
            this.cache.set(clientId, { doc, expiresAt: Date.now() + ttl });
        return client;
    }
}

/** Exact match; for loopback redirect URIs the port is ignored (RFC 8252). */
export function redirectUriAllowed(client: Client, redirectUri: string): boolean {
    if (client.redirectUris.includes(redirectUri))
        return true;
    let req: URL;
    try {
        req = new URL(redirectUri);
    } catch {
        return false;
    }
    if (!isLoopback(req) || req.href != redirectUri)
        return false;
    req.port = '';
    return client.redirectUris.some(r => {
        const reg = new URL(r);
        if (!isLoopback(reg))
            return false;
        reg.port = '';
        return reg.href == req.href;
    });
}
