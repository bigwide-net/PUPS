const enc = new TextEncoder()

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

/** A random token with 256 bits of entropy. */
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)))

export const sha256 = async (s: string | Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', typeof s == 'string' ? enc.encode(s) : s))

/** Tokens are stored only as SHA-256 hashes. */
export const hashToken = async (token: string) => b64url(await sha256(token))

/** The PKCE S256 transformation. */
export const s256 = async (verifier: string) => b64url(await sha256(verifier))

export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b)
  if (x.byteLength != y.byteLength) return false
  return crypto.subtle.timingSafeEqual(x, y)
}

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])

/** Signs a JSON value: `base64url(json).base64url(hmac)`. */
export async function sign(value: object, secret: string): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(value)))
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload))
  return `${payload}.${b64url(mac)}`
}

/** Verifies a value from `sign()` and checks its `exp` (ms since epoch). */
export async function verify<T extends { exp: number }>(token: string | null | undefined, secret: string): Promise<T | null> {
  if (token && token.length > 65536) return null
  const [payload, mac, extra] = token?.split('.') ?? []
  if (!payload || !mac || extra != undefined) return null
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(mac), enc.encode(payload))
    if (!ok) return null
    const value = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as T
    return value.exp > Date.now() ? value : null
  } catch {
    return null
  }
}

// Workers allow at most 100,000 PBKDF2 iterations.
const PBKDF2_ITERATIONS = 100000

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256))
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, PBKDF2_ITERATIONS))}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iter, salt, hash] = stored.split('$')
  if (alg != 'pbkdf2-sha256') return false
  return timingSafeEqual(b64url(await pbkdf2(password, fromB64url(salt), Number(iter))), hash)
}
