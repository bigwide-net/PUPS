import express from 'express';
import { HOST_META_PATH, PUPS_CLIENT_PROP, PUPS_PROP_PREFIX, PUPS_REL, PupsConfig } from '../lib/config';
import { Ctx } from '../lib/context';
import { HttpError, LIMITS, readBody } from '../lib/http';
import { log } from '../lib/log';
import { hasUnsafeChars } from 'pups-ui';
import { appdataPrefix, covers, isPrivate, pathFromPublicUrl, writePrefixes } from '../lib/paths';
import { Grant } from '../lib/state';
import { authenticate, requireScope } from './files';

/**
 * host-meta.json is the domain's index and the source of truth (RFC-6 "Editing
 * host-meta.json"): PUPS keeps no separate registry, never touches the owner's links, and
 * changes the file only with a read-modify-write that checks the file is unchanged.
 * It lives in the storage directory at .well-known/host-meta.json, so the owner can edit it.
 */

const MAX_LINKS = 1000;
const MAX_APPDATA_LINKS = 10;

/** Rels nobody may register through PUPS: discovery and identity relations. */
const RESERVED_RELS = new Set([
    PUPS_REL, 'http://webfinger.net/rel/profile-page', 'http://webfinger.net/rel/avatar', 'me', 'self', 'lrdd',
    'authorization_endpoint', 'token_endpoint', 'indieauth-metadata', 'micropub', 'openid', 'openid2.provider',
    'http://openid.net/specs/connect/1.0/issuer',
]);

export interface Link {
    rel: string;
    href?: string;
    type?: string;
    titles?: Record<string, string>;
    properties?: Record<string, string | null>;
    [k: string]: unknown;
}

interface HostMeta {
    links?: Link[];
    properties?: Record<string, string | null>;
    [k: string]: unknown;
}

export const defaultHostMeta = (c: PupsConfig): HostMeta => ({ links: [{ rel: PUPS_REL, type: 'application/json', href: c.configUrl }] });

/** The stored host-meta.json, if any. */
/** host-meta.json may be edited by hand; larger files are neither read nor changed. */
const MAX_HOST_META_BYTES = 1024 * 1024;

export function readHostMeta(ctx: Ctx): { text: string; etag: string } | undefined {
    const info = ctx.files.stat(HOST_META_PATH);
    if (info && info.size > MAX_HOST_META_BYTES)
        throw new HttpError(409, 'invalid_host_meta', `host-meta.json is larger than ${MAX_HOST_META_BYTES} bytes`);
    return info && { text: ctx.files.read(HOST_META_PATH)!.toString('utf8'), etag: info.etag };
}

function parse(text: string): HostMeta {
    const doc = JSON.parse(text);
    if (!doc || typeof doc != 'object' || Array.isArray(doc))
        throw new Error('host-meta.json is not a JSON object');
    if (doc.links != undefined && !Array.isArray(doc.links))
        throw new Error('links in host-meta.json is not an array');
    if (doc.properties != undefined && (typeof doc.properties != 'object' || Array.isArray(doc.properties)))
        throw new Error('properties in host-meta.json is not an object');
    return doc;
}

/** host-meta.json for the apps page: the stored document or the default, and why it can't be read, if it can't. */
export function ownerHostMeta(ctx: Ctx): { doc: HostMeta; stored: boolean; error?: string } {
    try {
        const stored = readHostMeta(ctx);
        return { doc: stored ? parse(stored.text) : defaultHostMeta(ctx.config), stored: !!stored };
    } catch (e: any) {
        return { doc: {}, stored: true, error: `host-meta.json can't be read: ${e.message}` };
    }
}

/**
 * Read-modify-write. `fn` changes the document and returns whether it changed. Everything
 * runs synchronously; just before writing, the file is checked once more, in case the owner
 * edited it in between.
 */
export function modifyHostMeta(ctx: Ctx, fn: (doc: HostMeta) => boolean, createIfMissing = true) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const stored = readHostMeta(ctx);
        if (!stored && !createIfMissing)
            return;
        let doc: HostMeta;
        try {
            doc = stored ? parse(stored.text) : defaultHostMeta(ctx.config);
        } catch (e: any) {
            throw new HttpError(409, 'invalid_host_meta', `host-meta.json can't be changed: ${e.message}`);
        }
        if (!fn(doc))
            return;
        if (ctx.files.stat(HOST_META_PATH)?.etag != stored?.etag)
            continue;
        ctx.files.write(HOST_META_PATH, JSON.stringify(doc, null, 2));
        log('host-meta.written', { links: doc.links?.length ?? 0, properties: Object.keys(doc.properties ?? {}).length });
        return;
    }
    throw new HttpError(409, 'conflict', 'host-meta.json changed concurrently; try again');
}

const owner = (l: Link) => l.properties?.[PUPS_CLIENT_PROP];
const hasControl = hasUnsafeChars;

/** An href from a request, in its canonical URL form (ASCII, percent-encoded), as stored in host-meta.json. */
function canonicalHref(href: unknown): string {
    try {
        if (typeof href == 'string' && href.length <= 2048 && !hasUnsafeChars(href) && /^https?:\/\//.test(href))
            return new URL(href).href;
    } catch {
    }
    throw new HttpError(400, 'invalid_request', 'href must be an http(s) URL without control or invisible characters');
}

function relOnClientHost(rel: string, clientHost: string): boolean {
    try {
        const u = new URL(rel);
        const h = u.host;
        return (u.protocol == 'https:' || u.protocol == 'http:') &&
            (h == clientHost || h == `www.${clientHost}` || clientHost.startsWith('www.') && h == clientHost.slice(4));
    } catch {
        return false;
    }
}

const noPrivate = (path: string | undefined) => {
    if (path && isPrivate(path))
        throw new HttpError(403, 'forbidden', "Private files can't be linked in host-meta.json");
};

/** Maps an href to a path inside the grant's scope, never a private file, or throws 403. */
function ownFile(href: unknown, grant: Grant, c: PupsConfig): string {
    if (typeof href != 'string' || href.length > 2048)
        throw new HttpError(400, 'invalid_request', 'href must be a URL');
    const path = pathFromPublicUrl(href, c);
    if (!path)
        throw new HttpError(403, 'insufficient_scope', 'href must be the public URL of a file on this server');
    noPrivate(path);
    requireScope(grant, path);
    return path;
}

const MAX_TITLES = 20;

/** `titles` of a request (RFC 7033: a language tag or "default" → a title), or undefined. */
function linkTitles(titles: unknown): Record<string, string> | undefined {
    if (titles == undefined)
        return undefined;
    const entries = titles && typeof titles == 'object' && !Array.isArray(titles) ? Object.entries(titles) : undefined;
    if (!entries || entries.length > MAX_TITLES || entries.some(([k, v]) =>
        !/^(default|[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*)$/.test(k) || typeof v != 'string' || !v || v.length > 255 || hasControl(v)))
        throw new HttpError(400, 'invalid_request', `titles must map at most ${MAX_TITLES} language tags or "default" to titles of at most 255 characters`);
    return entries.length ? Object.fromEntries(entries) as Record<string, string> : undefined;
}

/** `properties` of a request: only the declared link properties of the well-known path. */
function linkProperties(props: unknown, allowed: string[]): Record<string, string> {
    if (props == undefined)
        return {};
    const entries = props && typeof props == 'object' && !Array.isArray(props) ? Object.entries(props) : undefined;
    if (!entries)
        throw new HttpError(400, 'invalid_request', 'properties must be an object');
    for (const [k, v] of entries) {
        if (!allowed.includes(k))
            throw new HttpError(403, 'property_not_allowed', `The link property ${k.slice(0, 512)} is not allowed for this link`);
        if (typeof v != 'string' || !v || v.length > 2048 || hasControl(v))
            throw new HttpError(400, 'invalid_request', 'Link property values must be non-empty strings of at most 2048 characters without control or invisible characters');
    }
    return Object.fromEntries(entries) as Record<string, string>;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) == JSON.stringify(b);

function addLink(doc: HostMeta, body: any, grant: Grant, c: PupsConfig): boolean {
    const { rel, type } = body;
    const href = canonicalHref(body.href);
    if (type != undefined && (typeof type != 'string' || type.length > 255))
        throw new HttpError(400, 'invalid_request', 'type must be a media type of at most 255 characters');
    if (typeof rel != 'string' || !rel || rel.length > 512 || hasControl(rel))
        throw new HttpError(400, 'invalid_request', 'rel is required');
    if (type != undefined && (typeof type != 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(type)))
        throw new HttpError(400, 'invalid_request', 'type must be a media type');
    if (RESERVED_RELS.has(rel))
        throw new HttpError(403, 'rel_not_allowed', 'This link relation is reserved');
    const path = ownFile(href, grant, c);
    const links = doc.links ??= [];
    const prefix = appdataPrefix(grant.clientHost);
    const appdata = covers(prefix, path);
    const entry = appdata ? undefined : c.wellKnown.find(e => covers(e.path, path));
    if (appdata) {
        if (!relOnClientHost(rel, grant.clientHost))
            throw new HttpError(403, 'rel_not_allowed', `Links to the app's own data must use a URI rel on ${grant.clientHost}`);
    } else {
        if (!entry?.rels.includes(rel))
            throw new HttpError(403, 'rel_not_allowed', 'This rel is not allowed for this well-known path');
        if (entry.singleRels.includes(rel) && links.some(l => l.rel == rel && l.href != href))
            throw new HttpError(409, 'conflict', 'This rel allows only one link, and one exists already');
    }
    const titles = linkTitles(body.titles);
    const props = linkProperties(body.properties, entry?.linkProperties ?? []);
    const existing = links.find(l => l.rel == rel && l.href == href);
    if (existing) {
        // The app's own link takes the request's type, titles and properties; anyone else's stays.
        if (owner(existing) != grant.clientId) {
            if (body.titles != undefined || body.properties != undefined)
                throw new HttpError(409, 'conflict', "This link exists already and belongs to the owner or another app; it can't be changed");
            return false;
        }
        const changed: Link = { rel, href, ...type && { type }, ...titles && { titles }, properties: { ...props, [PUPS_CLIENT_PROP]: grant.clientId } };
        const { rel: _r, href: _h, type: _t, titles: _ti, properties: _p, ...rest } = existing;
        if (sameJson({ ...changed, ...rest }, existing))
            return false;
        Object.keys(existing).forEach(k => delete existing[k]);
        Object.assign(existing, changed, rest);
        return true;
    }
    if (links.length >= MAX_LINKS)
        throw new HttpError(413, 'limit_reached', `host-meta.json has ${MAX_LINKS} links already`);
    if (appdata && links.filter(l => owner(l) == grant.clientId && typeof l.href == 'string' &&
        covers(prefix, pathFromPublicUrl(l.href, c) ?? '')).length >= MAX_APPDATA_LINKS)
        throw new HttpError(413, 'limit_reached', `At most ${MAX_APPDATA_LINKS} links to an app's own data`);
    links.push({ rel, href, ...type && { type }, ...titles && { titles }, properties: { ...props, [PUPS_CLIENT_PROP]: grant.clientId } });
    return true;
}

/**
 * Puts the links of one rel into the order of `hrefs`, in the positions they occupy. `hrefs`
 * must name every link of the rel exactly once, the owner's and other apps' included.
 */
function orderLinks(doc: HostMeta, body: any, grant: Grant, c: PupsConfig): boolean {
    const { rel, hrefs } = body;
    if (typeof rel != 'string' || !rel || rel.length > 512 || hasControl(rel))
        throw new HttpError(400, 'invalid_request', 'rel is required');
    if (!Array.isArray(hrefs) || hrefs.length > MAX_LINKS)
        throw new HttpError(400, 'invalid_request', 'hrefs must be an array of URLs');
    const prefixes = writePrefixes(grant.scope);
    if (!c.wellKnown.some(e => e.rels.includes(rel) && prefixes.includes(e.path)) &&
        !(relOnClientHost(rel, grant.clientHost) && prefixes.includes(appdataPrefix(grant.clientHost))))
        throw new HttpError(403, 'rel_not_allowed', 'The granted scopes allow no links of this rel');
    const wanted = hrefs.map(canonicalHref);
    const links = doc.links ?? [];
    const slots = links.flatMap((l, i) => l.rel == rel ? [i] : []);
    const current = slots.map(i => links[i].href);
    if (new Set(wanted).size != wanted.length || wanted.length != current.length || wanted.some(h => !current.includes(h)))
        throw new HttpError(409, 'conflict', 'hrefs must list every link of this rel exactly once; reread host-meta.json');
    const ordered = wanted.map(h => links[slots[current.indexOf(h)]]);
    if (ordered.every((l, n) => l == links[slots[n]]))
        return false;
    slots.forEach((i, n) => links[i] = ordered[n]);
    return true;
}

function removeLink(doc: HostMeta, body: any, grant: Grant, c: PupsConfig): boolean {
    const { rel } = body;
    if (typeof rel != 'string' || rel.length > 512)
        throw new HttpError(400, 'invalid_request', 'rel and href are required');
    const href = canonicalHref(body.href);
    noPrivate(pathFromPublicUrl(href, c));
    const before = doc.links?.length;
    doc.links = doc.links?.filter(l => !(l.rel == rel && l.href == href && owner(l) == grant.clientId));
    return doc.links?.length != before;
}

function setProperty(doc: HostMeta, body: any, grant: Grant, c: PupsConfig): boolean {
    const { property, value } = body;
    if (typeof property != 'string' || !property || property.length > 512 || hasControl(property))
        throw new HttpError(400, 'invalid_request', 'property must be a URI of at most 512 characters');
    if (property.startsWith(PUPS_PROP_PREFIX))
        throw new HttpError(403, 'property_not_allowed', "PUPS's own properties can't be set");
    const prefixes = writePrefixes(grant.scope);
    const entries = c.wellKnown.filter(e => e.properties.includes(property) && prefixes.includes(e.path));
    if (!entries.length)
        throw new HttpError(403, 'property_not_allowed', 'This property is not allowed for the granted scopes');
    if (typeof value != 'string' || !value || value.length > 2048 || hasControl(value))
        throw new HttpError(400, 'invalid_request', 'value must be a non-empty string of at most 2048 characters without control or invisible characters');
    if (entries.some(e => e.urlProperties.includes(property)))
        ownFile(value, grant, c);
    const props = doc.properties ??= {};
    if (props[property] == value)
        return false;
    props[property] = value;
    return true;
}

/**
 * After a grant was revoked and the app has no other grant: remove its links to its own
 * data. Its well-known links stay (the files stay too) and become the owner's.
 * Properties are never removed.
 */
export function onGrantRevoked(clientId: string, ctx: Ctx) {
    if (ctx.state.clientHasGrant(clientId))
        return;
    try {
        modifyHostMeta(ctx, doc => {
            let changed = false;
            doc.links = doc.links?.filter(l => {
                if (owner(l) != clientId)
                    return true;
                changed = true;
                const path = typeof l.href == 'string' ? pathFromPublicUrl(l.href, ctx.config) : undefined;
                if (path?.startsWith('/appdata/'))
                    return false;
                delete l.properties![PUPS_CLIENT_PROP];
                if (!Object.keys(l.properties!).length)
                    delete l.properties;
                return true;
            });
            return changed;
        }, false);
    } catch (e) {
        // An invalid host-meta.json must not make revocation fail.
        console.error('host-meta.json cleanup failed', e);
    }
}

/** POST <host_meta_endpoint>: apps add links and set properties in host-meta.json. */
export function hostMetaRoutes(ctx: Ctx): express.Router {
    const router = express.Router();
    router.post('/pups/host-meta', async (req, res) => {
        const grant = authenticate(req, ctx);
        const raw = await readBody(req, 16 * 1024);
        let body: any;
        try {
            body = JSON.parse(raw!.toString('utf8'));
        } catch {
            throw new HttpError(400, 'invalid_request', 'The body must be a JSON object');
        }
        log('host-meta.request', { client: grant.clientId, grant: grant.id, body });
        switch (typeof body?.action == 'string' && body.action.length <= LIMITS.short ? body.action : undefined) {
            case 'add':
                modifyHostMeta(ctx, doc => addLink(doc, body, grant, ctx.config));
                return res.status(201).json({ ok: true });
            case 'remove':
                modifyHostMeta(ctx, doc => removeLink(doc, body, grant, ctx.config), false);
                return res.status(204).end();
            case 'set-property':
                modifyHostMeta(ctx, doc => setProperty(doc, body, grant, ctx.config));
                return res.status(201).json({ ok: true });
            case 'order':
                modifyHostMeta(ctx, doc => orderLinks(doc, body, grant, ctx.config));
                return res.status(204).end();
            default:
                throw new HttpError(400, 'invalid_request', 'action must be add, remove, set-property or order');
        }
    });
    return router;
}
