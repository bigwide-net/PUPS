import express from 'express';
import { noteError } from './log';

/** An error that becomes a JSON response `{"error", "message"}` (RFC-6 "Errors"). */
export class HttpError extends Error {
    status: number;
    code: string;
    headers: Record<string, string>;
    constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.headers = headers;
    }
}

export const methodNotAllowed = (allow: string) =>
    new HttpError(405, 'method_not_allowed', 'Method not allowed', { Allow: allow });

export const EXPOSE_HEADERS = 'ETag, Location, WWW-Authenticate';

/** Paths that are never CORS-enabled: the authorization endpoint and the owner pages. */
const OWNER_PAGES = new Set(['/', '/oauth/authorize', '/pups/apps']);

/**
 * CORS for everything but the owner pages (RFC-6 "CORS"): every response carries the
 * headers, errors included, and preflights are answered here. The wildcard is safe because
 * authentication uses bearer tokens, never cookies.
 */
export const corsMiddleware: express.RequestHandler = (req, res, next) => {
    if (OWNER_PAGES.has(req.path))
        return next();
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': EXPOSE_HEADERS });
    if (req.method != 'OPTIONS')
        return next();
    res.status(204).set({
        'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match',
        'Access-Control-Max-Age': '86400',
    }).end();
};

/** Turns thrown errors into JSON error responses. */
export const errorMiddleware: express.ErrorRequestHandler = (err, _req, res, _next) => {
    if (res.headersSent)
        return;
    if (err instanceof HttpError) {
        noteError(res, err.code, err.message);
        return res.status(err.status).set(err.headers).json({ error: err.code, message: err.message });
    }
    noteError(res, err?.type ?? 'server_error', err?.message ?? String(err));
    // Errors of express' body parsers.
    if (err?.type == 'entity.too.large')
        return res.status(413).json({ error: 'too_large', message: 'The request body is too large' });
    if (err?.status == 400 && err.type)
        return res.status(400).json({ error: 'invalid_request', message: 'The request body could not be parsed' });
    console.error(err);
    res.status(500).json({ error: 'server_error', message: 'Internal server error' });
};

/** Reads a request body up to `max` bytes. Resolves to null if the body is larger. */
export function readBody(req: express.Request, max: number): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > max) {
                req.removeAllListeners('data');
                req.resume();
                return resolve(null);
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(size > max ? null : Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/**
 * Size limits, in characters, for every string read from a request. Values over a limit are
 * rejected, never truncated, so nothing is silently changed.
 */
export const LIMITS = {
    /** client_id, redirect_uri, hrefs and other URLs. */
    url: 2048,
    /** The whole scope parameter (at most 20 scopes, see paths.ts). */
    scope: 2048,
    /** OAuth state, echoed back to the app. */
    state: 1024,
    /** Authorization codes, access and refresh tokens (ours have 43 characters). */
    token: 256,
    password: 1024,
    /** The signed authorization request in the consent form. */
    signedRequest: 16384,
    /** Request headers we read: Authorization, If-Match, If-None-Match, Content-Type. */
    header: 1024,
    /** A request path or the POST fallback's path parameter, before percent-decoding. */
    rawPath: 2048,
    /** Repeated form fields (scope checkboxes, grant IDs on the apps page). */
    repeated: 1000,
    /** Everything else: grant_type, decision, action, method, IDs. */
    short: 256,
} as const;

const tooLong = (name: string, max: number) => new HttpError(400, 'invalid_request', `${name} is longer than ${max} characters`);

/** A string value with a size limit. Throws 400 if it is longer. */
export function limited(value: unknown, name: string, max: number): string | undefined {
    if (typeof value != 'string' || !value)
        return;
    if (value.length > max)
        throw tooLong(name, max);
    return value;
}

/** The value of a form field that must appear at most once, at most `max` characters long. */
export const field = (body: any, name: string, max: number = LIMITS.short) => limited(body?.[name], name, max);

/** All values of a repeated form field: at most LIMITS.repeated values of at most `max` characters. */
export function fields(body: any, name: string, max: number = LIMITS.short): string[] {
    const v = body?.[name];
    const all: unknown[] = Array.isArray(v) ? v : [v];
    if (all.length > LIMITS.repeated)
        throw new HttpError(400, 'invalid_request', `More than ${LIMITS.repeated} values for ${name}`);
    return all.map(x => limited(x, name, max)).filter(x => x != undefined);
}

/** A query parameter that appears at most once, at most `max` characters long. */
export const query = (req: express.Request, name: string, max: number = LIMITS.short) => limited(req.query[name], name, max);

/** A request header, at most `max` characters long. */
export const header = (req: express.Request, name: string, max: number = LIMITS.header) => limited(req.get(name), name, max);
