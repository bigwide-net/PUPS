import express from 'express';
import { hashToken } from './crypto';
import { escapeUnsafe } from 'pups-ui';

/**
 * Transparent logging for a prototype server: one line per request, plus one line per
 * event (logins, authorizations, tokens, uploads, revocations). Passwords and tokens are
 * never logged; tokens appear as a fingerprint, the first 8 characters of their SHA-256
 * hash, which is also the start of their key in state.json. Silent in tests.
 */

const quiet = process.env.NODE_ENV == 'test';
/** Longer values are cut in the log. */
const MAX_VALUE_CHARS = 4096;

/**
 * Plain printable ASCII is written as it is; everything else is JSON-quoted, with control,
 * invisible and specials characters escaped, so that values from requests and fetched
 * documents can't inject lines or terminal escape sequences.
 */
const format = (v: unknown) => {
    let s = typeof v == 'string' ? v : JSON.stringify(v) ?? String(v);
    if (s.length > MAX_VALUE_CHARS)
        s = `${s.slice(0, MAX_VALUE_CHARS)}…(${s.length - MAX_VALUE_CHARS} more characters)`;
    return /^[\x21\x23-\x3c\x3e-\x7e]+$/.test(s) ? s : escapeUnsafe(JSON.stringify(s));
};

/** Logs an event: `<time> <event> key=value …`. Undefined values are left out. */
export function log(event: string, details: Record<string, unknown> = {}) {
    if (quiet)
        return;
    const pairs = Object.entries(details).filter(([, v]) => v != undefined).map(([k, v]) => `${escapeUnsafe(k)}=${format(v)}`);
    console.log([new Date().toISOString(), event, ...pairs].join(' '));
}

/** A token's fingerprint: the first 8 characters of its hash, as in state.json. */
export const fp = (token: string | undefined) => token && hashToken(token).slice(0, 8);

/** Records why a request failed, for the request log line. */
export const noteError = (res: express.Response, code: string, message: string) => {
    res.locals.error = `${code}: ${message}`;
};

/** Logs every request when it is finished: method, URL, status, duration, size and the error, if any. */
export const requestLog: express.RequestHandler = (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => log('http', {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - start,
        in: req.get('content-length'),
        out: res.get('content-length'),
        error: res.locals.error,
        ua: req.get('user-agent'),
    }));
    next();
};
