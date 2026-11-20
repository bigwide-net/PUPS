<?php

namespace Pups;

function b64url(string $bytes): string
{
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

/** Decodes base64url. Null if the input isn't base64url. */
function fromB64url(string $s): ?string
{
    if (!preg_match('/^[A-Za-z0-9_-]*$/D', $s))
        return null;
    $bytes = base64_decode(strtr($s, '-_', '+/'), true);
    return $bytes === false ? null : $bytes;
}

/** A random token, by default with 256 bits of entropy. */
function randomToken(int $bytes = 32): string
{
    return b64url(random_bytes($bytes));
}

function sha256(string $data): string
{
    return b64url(hash('sha256', $data, true));
}

/** Tokens and codes are stored only as SHA-256 hashes. */
function hashToken(string $token): string
{
    return sha256($token);
}

/** The PKCE S256 transformation. */
function s256(string $verifier): string
{
    return sha256($verifier);
}

/** Constant-time comparison of two strings (compares their hashes, so lengths don't leak). */
function safeEqual(string $a, string $b): bool
{
    return hash_equals(hash('sha256', $a), hash('sha256', $b));
}

function hmac(string $payload, string $secret): string
{
    return b64url(hash_hmac('sha256', $payload, $secret, true));
}

/** Signs a JSON value: `base64url(json).base64url(hmac)`. */
function sign(array $value, string $secret): string
{
    $payload = b64url(json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
    return $payload . '.' . hmac($payload, $secret);
}

/** Verifies a value from sign() and checks its `exp` (ms since epoch). Null if invalid or expired. */
function verify(?string $token, string $secret, int $now): ?array
{
    if ($token === null || strlen($token) > 65536)
        return null;
    $parts = explode('.', $token);
    if (count($parts) !== 2 || $parts[0] === '' || !safeEqual($parts[1], hmac($parts[0], $secret)))
        return null;
    $value = json_decode(fromB64url($parts[0]) ?? '', true);
    return is_array($value) && is_int($value['exp'] ?? null) && $value['exp'] > $now ? $value : null;
}

/**
 * Hashes a new owner password: Argon2id if this PHP has it, else bcrypt. The password is
 * pre-hashed with SHA-256, because bcrypt ignores everything after 72 bytes.
 */
function hashPassword(string $password): string
{
    return password_hash(preHash($password), defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT);
}

function verifyPassword(string $password, string $hash): bool
{
    return password_verify(preHash($password), $hash);
}

function preHash(string $password): string
{
    return base64_encode(hash('sha256', $password, true));
}
