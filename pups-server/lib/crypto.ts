import crypto from 'crypto';

/** A random token, by default with 256 bits of entropy. */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('base64url');

/** Tokens and codes are stored only as SHA-256 hashes. */
export const hashToken = sha256;

/** The PKCE S256 transformation. */
export const s256 = sha256;

/** Constant-time comparison of two strings (compares their hashes, so lengths don't leak). */
export const safeEqual = (a: string, b: string) =>
    crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());

const hmac = (payload: string, secret: string) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

/** Signs a JSON value: `base64url(json).base64url(hmac)`. */
export function sign(value: object, secret: string): string {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${hmac(payload, secret)}`;
}

/** Verifies a value from `sign()` and checks its `exp` (ms since epoch). */
export function verify<T extends { exp: number }>(token: string | undefined, secret: string): T | undefined {
    if (token && token.length > 65536)
        return;
    const [payload, mac, extra] = token?.split('.') ?? [];
    if (!payload || !mac || extra != undefined || !safeEqual(mac, hmac(payload, secret)))
        return;
    try {
        const value = JSON.parse(Buffer.from(payload, 'base64url').toString()) as T;
        return value.exp > Date.now() ? value : undefined;
    } catch {
        return;
    }
}
