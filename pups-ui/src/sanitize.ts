/**
 * Sanitizing of untrusted values (client metadata documents, scopes, paths, host-meta.json),
 * following Downread's sanitizer: control characters, invisible characters and the specials
 * block are never shown as they are. Encoding for HTML is separate (`escapeHtml()` in html.ts) and
 * applies on top of this to every value written into a page.
 */

/**
 * C0 and C1 control characters, invisible characters (Arabic letter mark, zero-width space,
 * direction marks, bidi embeddings, overrides and isolates, word joiners, BOM) and the
 * specials block. The zero-width non-joiner and joiner (U+200C, U+200D) are allowed: emoji
 * sequences and several scripts need them.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufff0-\uffff]/
const UNSAFE_ALL = new RegExp(UNSAFE.source, 'g')

/** Does a value contain control, invisible or specials characters? */
export const hasUnsafeChars = (s: string) => UNSAFE.test(s)

/**
 * Self-declared text for display (e.g. client_name): line breaks and tabs become spaces,
 * unsafe characters are removed, whitespace is collapsed, and the result has at most `max`
 * characters (code points, so emoji aren't cut in half). Undefined if nothing is left.
 */
export function sanitizeText(s: unknown, max: number): string | undefined {
  if (typeof s != 'string') return
  const chars = [...s.replace(/[\t\n\r]+/g, ' ').replace(UNSAFE_ALL, '').replace(/\s+/g, ' ').trim()]
  const text = chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : chars.join('')
  return text || undefined
}

/**
 * Makes unsafe characters visible as `\u{…}`. For values that must be shown exactly, such as
 * paths, client IDs, rels and error messages: a spoofing attempt stays visible instead of
 * silently changing what the owner reads.
 */
export const visible = (s: string) => s.replace(UNSAFE_ALL, c => `\\u{${c.codePointAt(0)!.toString(16)}}`)

/** Escapes unsafe characters as `\uXXXX`, e.g. for log lines, so no value can control the terminal. */
export const escapeUnsafe = (s: string) => s.replace(UNSAFE_ALL, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/**
 * A strict DNS host name: dot-separated labels of lowercase letters, digits and hyphens (IDNs
 * in their punycode form, as the URL parser returns them). The URL parser also accepts
 * characters like `;`, `'` and `$` in host names, which must never reach HTML, headers or paths.
 */
export const isHostName = (host: string) =>
  host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)

/** A URL from an untrusted document: a string of at most `max` characters without whitespace or unsafe characters. */
export const isCleanUrlString = (s: unknown, max = 2048): s is string =>
  typeof s == 'string' && s.length <= max && !/\s/.test(s) && !hasUnsafeChars(s)

/** Origins allowed in a CSP source list: HTTPS with a strict host name, or a loopback address. */
export const isCspOrigin = (origin: string) =>
  /^(?:https:\/\/(?:[a-z0-9-]+\.)*[a-z0-9-]+|http:\/\/(?:127\.0\.0\.1|\[::1\]))(?::\d{1,5})?$/.test(origin)
