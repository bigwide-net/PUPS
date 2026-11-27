import { PupsConfig, WellKnownEntry } from './config';
import { hasUnsafeChars, IDENTITY_SCOPE, isPrivate } from 'pups-ui';

export const MAX_PATH_BYTES = 512;
/** At most this many scopes in one request. */
export const MAX_SCOPES = 20;

const isDeclaredWellKnownFile = (path: string, c: PupsConfig) =>
    path.startsWith('/.well-known/') && c.wellKnown.some(e => e.path == path);

/**
 * Validates a storage path (RFC-6 "Paths"). `raw` is percent-encoded and starts with `/`.
 * Returns the decoded, normalized path, or an error message.
 */
export function parsePath(raw: string, c: PupsConfig): { path: string } | { error: string } {
    if (raw.length > 3 * MAX_PATH_BYTES)
        return { error: `The path is longer than ${MAX_PATH_BYTES} bytes` };
    let path: string;
    try {
        path = decodeURIComponent(raw);
    } catch {
        return { error: 'The path is not valid percent-encoded UTF-8' };
    }
    if (!path.startsWith('/'))
        return { error: 'The path must start with /' };
    if (Buffer.byteLength(path) > MAX_PATH_BYTES)
        return { error: `The path is longer than ${MAX_PATH_BYTES} bytes` };
    if (path.endsWith('/'))
        return { error: 'The path ends with /' };
    // Bidi controls and other invisible characters too: they can disguise a file name (`gpj.exe`).
    if (/[\\:]/.test(path) || hasUnsafeChars(path))
        return { error: 'The path contains a backslash, colon, or a control or invisible character' };
    const segments = path.slice(1).split('/');
    for (const seg of segments) {
        if (!seg)
            return { error: 'The path has an empty segment' };
        if (seg == '.' || seg == '..')
            return { error: 'The path has a dot segment' };
        if (seg.endsWith('.') || seg.endsWith(' '))
            return { error: 'A path segment ends with a dot or a space' };
    }
    if (segments.some(seg => seg.startsWith('.')) && !isDeclaredWellKnownFile(path, c))
        return { error: 'A path segment starts with a dot' };
    return { path };
}

/** A parsed scope. `identity-tokens` lets the app act as the owner on other sites (RFC-10). */
export type Scope = { kind: 'identify' } | { kind: 'identity-tokens' } | { kind: 'write' | 'read'; prefix: string; wellKnown?: WellKnownEntry };

const SCOPE_SYNTAX = /^(write|read):(\/(?:[A-Za-z0-9\-._~\/]|%[0-9A-Fa-f]{2})*)$/;

/** The app's own directory. */
export const appdataPrefix = (clientHost: string) => `/appdata/${clientHost}/`;

export { isPrivate } from 'pups-ui';

/**
 * Parses one scope string for a client (RFC-6 "Scopes"). Returns undefined if the scope is
 * invalid: only `identify`, `identity-tokens` (RFC-10), the app's own directory, declared
 * well-known paths, and `read:` for declared paths in /pups/private/ exist.
 */
export function parseScope(scope: string, clientHost: string, c: PupsConfig): Scope | undefined {
    if (scope == 'identify')
        return { kind: 'identify' };
    if (scope == IDENTITY_SCOPE)
        return { kind: 'identity-tokens' };
    const m = SCOPE_SYNTAX.exec(scope);
    if (!m)
        return;
    const kind = m[1] as 'write' | 'read';
    let prefix: string;
    try {
        prefix = decodeURIComponent(m[2]);
    } catch {
        return;
    }
    if (kind == 'write' && prefix == appdataPrefix(clientHost))
        return { kind, prefix };
    // Validate the prefix like a path (a directory prefix without its trailing slash).
    const asPath = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    if (!asPath || 'error' in parsePath(encodeURI(asPath), c))
        return;
    const wellKnown = c.wellKnown.find(e => e.path.endsWith('/') ? prefix.startsWith(e.path) : prefix == e.path);
    // Public files need no read scope: `read:` exists only for private paths.
    if (wellKnown && (kind == 'write' || isPrivate(wellKnown.path)))
        return { kind, prefix, wellKnown };
}

/** Parses a space-separated scope string. Returns undefined if any scope is invalid or none is given. */
export function parseScopes(scope: string, clientHost: string, c: PupsConfig): Map<string, Scope> | undefined {
    const out = new Map<string, Scope>();
    const items = scope.split(' ').filter(Boolean);
    if (items.length > MAX_SCOPES)
        return;
    for (const item of items) {
        const parsed = parseScope(item, clientHost, c);
        if (!parsed)
            return;
        out.set(item, parsed);
    }
    return out.size ? out : undefined;
}

/** Does a write scope prefix cover a normalized path? Compares segment by segment. */
export const covers = (prefix: string, path: string) => prefix.endsWith('/') ? path.startsWith(prefix) : path == prefix;

/** Write prefixes of a granted scope string. The granted scope was validated when it was granted. */
export const writePrefixes = (scope: string) =>
    scope.split(' ').filter(x => x.startsWith('write:')).map(x => decodeURIComponent(x.slice(6)));

/** Prefixes that allow reading private files: every write prefix, and the `read:` prefixes. */
export const readPrefixes = (scope: string) =>
    [...writePrefixes(scope), ...scope.split(' ').filter(x => x.startsWith('read:')).map(x => decodeURIComponent(x.slice(5)))];

/**
 * Does a scope need step-up confirmation? Everything but `identify` and the app's own directory does,
 * `identity-tokens` always (RFC-10 "Scope and consent").
 */
export const needsStepUp = (scope: Scope, clientHost: string) =>
    scope.kind == 'identity-tokens' || scope.kind != 'identify' && scope.prefix != appdataPrefix(clientHost);

/** The public URL of a stored file (RFC-6 "Public URLs"). */
export function publicUrl(path: string, c: PupsConfig): string {
    const e = c.wellKnown.find(e => e.url && covers(e.path, path));
    return e ? e.url + path.slice(e.path.length) : c.publicBase + path.slice(1);
}

/** Maps a public URL back to a normalized storage path, or undefined. */
export function pathFromPublicUrl(url: string, c: PupsConfig): string | undefined {
    let raw: string | undefined;
    for (const e of c.wellKnown)
        if (e.url && (e.path.endsWith('/') ? url.startsWith(e.url) : url == e.url))
            raw = e.path + url.slice(e.url.length);
    if (raw == undefined && url.startsWith(c.publicBase))
        raw = '/' + url.slice(c.publicBase.length);
    if (raw == undefined || /[?#]/.test(raw))
        return;
    const parsed = parsePath(raw, c);
    return 'path' in parsed ? parsed.path : undefined;
}
