<?php
/**
 * Sanitizing of untrusted values (client metadata documents, scopes, paths, host-meta.json),
 * following Downread's sanitizer: control characters, invisible characters and the specials
 * block are never shown as they are. Encoding for HTML is separate (h() in html.php) and
 * applies on top of this to every value written into a page.
 *
 * Works without mbstring: PCRE's /u mode does the UTF-8 handling. Values from requests may
 * be invalid UTF-8; every function here treats that as unsafe.
 */

namespace Pups;

/**
 * C0 and C1 control characters, invisible characters (Arabic letter mark, zero-width space,
 * direction marks, bidi embeddings, overrides and isolates, word joiners, BOM) and the
 * specials block. The zero-width non-joiner and joiner (U+200C, U+200D) are allowed: emoji
 * sequences and several scripts need them.
 */
const UNSAFE = '[\x{0000}-\x{001f}\x{007f}-\x{009f}\x{061c}\x{200b}\x{200e}\x{200f}\x{202a}-\x{202e}\x{2060}-\x{2069}\x{feff}\x{fff0}-\x{ffff}]';

/** Is a string valid UTF-8? */
function isUtf8(string $s): bool
{
    return preg_match('//u', $s) === 1;
}

/** Replaces invalid UTF-8 sequences with U+FFFD (which is in the specials block, so it counts as unsafe). */
function scrub(string $s): string
{
    return isUtf8($s) ? $s : htmlspecialchars_decode(htmlspecialchars($s, ENT_NOQUOTES | ENT_SUBSTITUTE, 'UTF-8'), ENT_NOQUOTES);
}

/** Does a value contain control, invisible or specials characters, or invalid UTF-8? */
function hasUnsafeChars(string $s): bool
{
    return preg_match('/' . UNSAFE . '/u', $s) !== 0;
}

/**
 * Self-declared text for display (e.g. client_name): line breaks and tabs become spaces,
 * unsafe characters are removed, whitespace is collapsed, and the result has at most `max`
 * characters (code points, so emoji aren't cut in half). Null if nothing is left.
 */
function sanitizeText(mixed $s, int $max): ?string
{
    if (!is_string($s) || !isUtf8($s))
        return null;
    $s = preg_replace('/[\t\n\r]+/', ' ', $s);
    $s = preg_replace('/' . UNSAFE . '/u', '', $s);
    $s = trim(preg_replace('/\s+/u', ' ', $s));
    $chars = preg_split('//u', $s, -1, PREG_SPLIT_NO_EMPTY);
    $text = count($chars) > $max ? rtrim(implode('', array_slice($chars, 0, $max - 1))) . '…' : $s;
    return $text === '' ? null : $text;
}

/**
 * Makes unsafe characters visible as `\u{…}`. For values that must be shown exactly, such as
 * paths, client IDs, rels and error messages: a spoofing attempt stays visible instead of
 * silently changing what the owner reads.
 */
function visible(string $s): string
{
    return preg_replace_callback('/' . UNSAFE . '/u', fn($m) => sprintf('\\u{%x}', codePoint($m[0])), scrub($s));
}

/** Escapes unsafe characters as `\uXXXX`, e.g. for log lines, so no value can control the terminal. */
function escapeUnsafe(string $s): string
{
    return preg_replace_callback('/' . UNSAFE . '/u', fn($m) => sprintf('\\u%04x', codePoint($m[0])), scrub($s));
}

/** The code point of a single UTF-8 character. */
function codePoint(string $c): int
{
    $b = array_values(unpack('C*', $c));
    return match (count($b)) {
        1 => $b[0],
        2 => (($b[0] & 0x1f) << 6) | ($b[1] & 0x3f),
        3 => (($b[0] & 0x0f) << 12) | (($b[1] & 0x3f) << 6) | ($b[2] & 0x3f),
        default => (($b[0] & 0x07) << 18) | (($b[1] & 0x3f) << 12) | (($b[2] & 0x3f) << 6) | ($b[3] & 0x3f),
    };
}

/**
 * A strict DNS host name: dot-separated labels of lowercase letters, digits and hyphens (IDNs
 * in their punycode form). Characters like `;`, `'` and `$` must never reach HTML, headers or paths.
 */
function isHostName(string $host): bool
{
    return strlen($host) <= 253 && preg_match('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/D', $host) === 1;
}

/** A URL from an untrusted document: a string of at most `max` characters without whitespace or unsafe characters. */
function isCleanUrlString(mixed $s, int $max = 2048): bool
{
    return is_string($s) && strlen($s) <= $max && preg_match('/\s/u', $s) === 0 && !hasUnsafeChars($s);
}

/** Origins allowed in a CSP source list: HTTPS with a strict host name, or a loopback address. */
function isCspOrigin(string $origin): bool
{
    return preg_match('/^(?:https:\/\/(?:[a-z0-9-]+\.)*[a-z0-9-]+|http:\/\/(?:127\.0\.0\.1|\[::1\]))(?::\d{1,5})?$/D', $origin) === 1;
}
