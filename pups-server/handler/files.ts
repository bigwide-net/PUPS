import express from 'express';
import { STORAGE_PREFIX } from '../lib/config';
import { Ctx } from '../lib/context';
import { checkUploadType, checkUtf8, fileType, servedType } from '../lib/filetypes';
import { header, HttpError, LIMITS, query, readBody } from '../lib/http';
import { fp, log } from '../lib/log';
import { covers, isPrivate, parsePath, publicUrl, readPrefixes, writePrefixes } from '../lib/paths';
import { Grant } from '../lib/state';

const invalidToken = (message: string) =>
    new HttpError(401, 'invalid_token', message, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });

/** Authenticates the bearer token from the Authorization header (never from the URL or the body). */
export function authenticate(req: express.Request, ctx: Ctx): Grant {
    const auth = req.get('authorization') ?? '';
    const m = auth.length <= LIMITS.header ? /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i.exec(auth) : undefined;
    if (!m)
        throw invalidToken('A bearer token is required');
    const grant = ctx.state.authenticate(m[1]);
    if (!grant) {
        log('api.invalid-token', { token: fp(m[1]), url: req.originalUrl });
        throw invalidToken('The access token is invalid, expired or revoked');
    }
    return grant;
}

export function requirePath(raw: string, ctx: Ctx): string {
    const p = parsePath(raw, ctx.config);
    if ('error' in p)
        throw new HttpError(400, 'invalid_path', p.error);
    return p.path;
}

/** Requires a scope that covers the path: a write scope, or for reading private files also a read scope. */
export function requireScope(grant: Grant, path: string, read = false) {
    if (!(read ? readPrefixes : writePrefixes)(grant.scope).some(prefix => covers(prefix, path)))
        throw new HttpError(403, 'insufficient_scope', 'The path is outside the granted scope', {
            'WWW-Authenticate': 'Bearer error="insufficient_scope"',
        });
}

/**
 * Every response for a private path, errors included, carries `Cache-Control: no-store` and
 * `Vary: Authorization` (RFC-6 "Private areas"). Returns the normalized path if it is private.
 */
function markPrivate(res: express.Response, rawPath: string, ctx: Ctx): string | undefined {
    const p = parsePath(rawPath, ctx.config);
    if (!('path' in p) || !isPrivate(p.path))
        return;
    res.vary('Authorization').set('Cache-Control', 'no-store');
    return p.path;
}

const etagList = (v: string) => v.split(',').map(x => x.trim().replace(/^W\//, '')).filter(Boolean);
const etagMatches = (header: string, etag: string) => etagList(header).some(x => x == '*' || x == etag);

/**
 * PUT or DELETE of a file (RFC-6 "Upload API"). `rawPath` is percent-encoded and relative
 * to storage_base, starting with `/`. Shared by the direct API and the POST fallback.
 */
async function write(req: express.Request, res: express.Response, method: string, rawPath: string, ctx: Ctx) {
    const { config, files } = ctx;
    const priv = markPrivate(res, rawPath, ctx);
    const grant = authenticate(req, ctx);
    const path = requirePath(rawPath, ctx);
    requireScope(grant, path);
    const ifMatch = header(req, 'if-match'), ifNoneMatch = header(req, 'if-none-match');

    if (method == 'DELETE') {
        const existing = files.stat(path);
        if (!existing)
            throw new HttpError(404, 'not_found', 'The file does not exist');
        if (ifMatch && !etagMatches(ifMatch, existing.etag))
            throw new HttpError(412, 'precondition_failed', 'The file has changed');
        files.delete(path);
        log('file.deleted', { client: grant.clientId, grant: grant.id, path, ifMatch, etag: existing.etag });
        return res.status(204).end();
    }

    // Check the type and the size before storing a single byte.
    const type = checkUploadType(path, header(req, 'content-type'));
    const tooLarge = new HttpError(413, 'too_large', `Files may be at most ${config.maxUploadBytes} bytes`);
    if (Number(req.get('content-length')) > config.maxUploadBytes)
        throw tooLarge;
    const body = await readBody(req, config.maxUploadBytes);
    if (!body)
        throw tooLarge;
    checkUtf8(type, body);

    // From here on everything is synchronous, so no other request can change the file
    // between the precondition check and the write.
    const existing = files.stat(path);
    if (ifNoneMatch && (ifNoneMatch.trim() == '*' ? existing : existing && etagMatches(ifNoneMatch, existing.etag)))
        throw new HttpError(412, 'precondition_failed', 'The file already exists');
    if (ifMatch && (!existing || !etagMatches(ifMatch, existing.etag)))
        throw new HttpError(412, 'precondition_failed', existing ? 'The file has changed' : 'The file does not exist');
    const etag = files.write(path, body);
    log(existing ? 'file.replaced' : 'file.created', {
        client: grant.clientId, grant: grant.id, path, bytes: body.length, contentType: req.get('content-type'),
        // Private files have no public URL.
        ifMatch, ifNoneMatch, oldEtag: existing?.etag, etag, ...!priv && { url: publicUrl(path, config) },
    });
    res.status(existing ? 200 : 201).set({ ETag: etag, ...!existing && { Location: config.storageBase + rawPath.slice(1) } }).end();
}

/**
 * Public or fresh read of an uploaded file. `rawPath` is percent-encoded and starts with `/`.
 * A read with a token is a fresh read (RFC-6 "Fresh reads"): any valid token, whatever its
 * scopes, makes caches pass the request on; an invalid one gets 401, never a public read.
 * Private files (RFC-6 "Private areas") need a token whose scope covers them; the token is
 * checked before the file is looked up, so the answer never tells whether it exists.
 */
function serve(req: express.Request, res: express.Response, next: express.NextFunction, rawPath: string, ctx: Ctx) {
    res.vary('Authorization');
    const priv = markPrivate(res, rawPath, ctx);
    // Only a Bearer token makes a fresh read; Basic credentials of a password-protected site are ignored.
    const fresh = /^Bearer\s/i.test(req.get('authorization') ?? '');
    if (priv && !fresh)
        throw new HttpError(401, 'invalid_token', 'Private files can only be read with a bearer token', { 'WWW-Authenticate': 'Bearer' });
    const grant = fresh ? authenticate(req, ctx) : undefined;
    if (priv)
        requireScope(grant!, priv, true);
    // Uploads never contain JavaScript; refusing service worker scripts is defence in depth.
    if (req.get('service-worker')?.toLowerCase() == 'script')
        throw new HttpError(403, 'forbidden', 'Uploaded files can never be service workers');
    const p = parsePath(rawPath, ctx.config);
    const type = 'path' in p ? fileType(p.path) : undefined;
    const info = type && 'path' in p ? ctx.files.stat(p.path) : undefined;
    if (!type || !info)
        throw new HttpError(404, 'not_found', 'Not found');
    // The headers that make sure an upload is always treated as data (RFC-6 "Serving files").
    res.set({
        'Content-Type': servedType(type),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
        'Cache-Control': fresh ? 'private, no-store' : 'no-cache',
        ETag: info.etag,
    });
    // sendFile answers conditional and range requests, using the ETag set above.
    res.sendFile(info.abs, { etag: false, cacheControl: false, lastModified: true, dotfiles: 'allow' }, err => err && next(err));
}

/** The path of a request, still percent-encoded and without query (Express doesn't normalize it). */
const rawPathOf = (req: express.Request) => req.originalUrl.split('?')[0];

export function fileRoutes(ctx: Ctx): express.Router {
    const { config } = ctx;
    const router = express.Router();

    // POST fallback for hosts that block PUT and DELETE (only when configured).
    if (config.postFallback)
        router.post('/pups/post', async (req, res) => {
            const method = query(req, 'method'), path = query(req, 'path', LIMITS.rawPath);
            if (method != 'PUT' && method != 'DELETE')
                throw new HttpError(400, 'invalid_request', 'method must be PUT or DELETE');
            if (!path)
                throw new HttpError(400, 'invalid_path', 'path is required');
            // `path` was percent-decoded once by the query parser; re-encode it so that it is decoded exactly once.
            return write(req, res, method, path.split('/').map(encodeURIComponent).join('/'), ctx);
        });

    // Declared well-known paths whose public URL differs from their storage path.
    const mounts = config.wellKnown.filter(e => e.url && e.url != config.origin + e.path)
        .map(e => ({ urlPath: e.url!.slice(config.origin.length), path: e.path }));

    // The upload API and public reads at storage_base, the domain root. The server's own
    // routes come first; scopes keep every write inside /appdata/<app>/ and the declared
    // well-known paths, so uploads can never shadow them.
    router.all(/.*/, async (req, res, next) => {
        const rawPath = rawPathOf(req).slice(STORAGE_PREFIX.length - 1);
        switch (req.method) {
            case 'PUT':
            case 'DELETE':
                return write(req, res, req.method, rawPath, ctx);
            case 'GET':
            case 'HEAD': {
                const m = mounts.find(m => covers(m.urlPath, rawPath));
                return serve(req, res, next, m ? m.path + rawPath.slice(m.urlPath.length) : rawPath, ctx);
            }
            default:
                next();
        }
    });
    return router;
}
