<?php

namespace Pups;

/**
 * Identity tokens (RFC-10): an app with the scope `identity-tokens` exchanges its access token at the token endpoint
 * (RFC 8693) for a token that says that the owner acts, through the app, at one other site: a JWT as in RFC 9068,
 * signed with RS256 and valid for a minute. The server makes its RSA key pair on first use and keeps it in
 * data/identity-key.json, outside the storage, where nothing serves it; the public key is the JWK Set at
 * /pups/jwks.json. Every issued token is logged in data/identity-log.json for 30 days, and the apps page shows where
 * each app acted as the owner. Without the openssl extension the server offers none of this (Config::$identityTokens).
 * The servers in TypeScript share the same rules in pups-ui's identity-tokens.ts.
 */

const IDENTITY_SCOPE = 'identity-tokens';
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';
/** Seconds: RFC-10 recommends 60, and allows at most 300. */
const IDENTITY_TOKEN_TTL = 60;
/** Seconds that a read token lives, for fetching personal feeds (RFC-10 "Read tokens": at most 86,400, recommended). */
const READ_TOKEN_TTL = 86_400;
/** Identity tokens per grant and minute; more get 429. */
const IDENTITY_TOKENS_PER_MINUTE = 60;
/** How long the log of issued tokens is kept (RFC-10 "Log": at least 30 days). */
const IDENTITY_LOG_MS = 30 * 24 * 3600_000;
/** Seconds that verifiers may cache the JWK Set (RFC-10: at most 3600). */
const JWKS_MAX_AGE = 600;
/** Where the JWK Set is, relative to the base. No app can write there: well-known paths can't be in /pups/ (config.php). */
const JWKS_PATH = '/pups/jwks.json';

/**
 * Whether `value` is an audience that RFC-10 allows: exactly one https origin as the URL parser writes it (lowercase
 * host in ASCII form, a port only if it isn't 443), without path, `/`, query, user info or fragment, and not a local
 * name or an IP address. Stricter than the URL parser in one way: the labels of the host are letters, digits and
 * inner hyphens only.
 */
function isAudience(string $value): bool
{
    $label = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
    if (strlen($value) > Limits::URL || !preg_match("#^https://((?:$label\\.)+$label)(?::(0|[1-9][0-9]{0,4}))?$#D", $value, $m))
        return false;
    $port = $m[2] ?? '';
    // A host whose last label is a number is an IPv4 address to the URL parser.
    return $port !== '443' && (int) $port <= 65535 && !preg_match('/\.(local|localhost)$|(^|\.)([0-9]+|0x[0-9a-f]*)$/D', $m[1]);
}

/**
 * Checks a token exchange request (RFC-10 "Token exchange"), apart from the subject token, which the caller looks up:
 * an access token as subject, no `resource`, `actor_token` or other `requested_token_type` than a JWT, one audience, and
 * no `scope` but `read`, which asks for a read token. Returns ['subjectToken', 'audience', 'read'] or ['error', 'description'].
 */
function exchangeRequest(array $form): array
{
    $fail = fn(string $error, string $description) => ['error' => $error, 'description' => $description];
    $subjectToken = field($form, 'subject_token', Limits::TOKEN);
    if ($subjectToken === null)
        return $fail('invalid_request', 'subject_token is required');
    if (field($form, 'subject_token_type', Limits::URL) !== ACCESS_TOKEN_TYPE)
        return $fail('invalid_request', 'subject_token_type must be ' . ACCESS_TOKEN_TYPE);
    foreach (['resource', 'actor_token', 'actor_token_type'] as $name)
        if (isset($form[$name]))
            return $fail('invalid_request', "$name is not supported");
    $scopes = (array) ($form['scope'] ?? []);
    if (count($scopes) > 1 || $scopes && $scopes[0] !== 'read')
        return $fail('invalid_scope', 'scope may only be read, for a read token');
    if (isset($form['requested_token_type']) && field($form, 'requested_token_type', Limits::URL) !== JWT_TOKEN_TYPE)
        return $fail('invalid_request', 'requested_token_type must be ' . JWT_TOKEN_TYPE);
    $audiences = $form['audience'] ?? [];
    if (count($audiences) !== 1 || !isAudience($audiences[0]))
        return $fail('invalid_target', 'audience must be one https origin, such as https://polls.example.com, without a path');
    return ['subjectToken' => $subjectToken, 'audience' => $audiences[0], 'read' => (bool) $scopes];
}

// --- The key ---------------------------------------------------------------------------------------

function identityKeyFile(Config $c): string
{
    return "$c->dataDir/identity-key.json";
}

/**
 * The key that signs identity tokens: ['kid', 'createdAt', 'pem' (the private key), 'n', 'e' (the public key, base64url)],
 * made on first use; with `replace`, a new one in place of it, at once (RFC-10 "Compromise"). It is made under the
 * state lock, so that parallel requests don't make two, and stored with mode 0600.
 */
function signingKey(Ctx $ctx, bool $replace = false): array
{
    $file = identityKeyFile($ctx->config);
    $read = function () use ($file) {
        $k = json_decode(@file_get_contents($file) ?: 'null', true);
        return is_array($k) && is_string($k['kid'] ?? null) && is_string($k['pem'] ?? null) ? $k : null;
    };
    return (!$replace ? $read() : null) ?? $ctx->state->locked(function () use ($ctx, $file, $replace, $read) {
        if (!$replace && ($k = $read()))
            return $k;
        $pair = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_RSA, 'private_key_bits' => 2048, 'digest_alg' => 'sha256']);
        if (!$pair || !openssl_pkey_export($pair, $pem))
            throw new \RuntimeException('Cannot make the signing key: ' . openssl_error_string());
        $rsa = openssl_pkey_get_details($pair)['rsa'];
        $now = $ctx->now();
        $k = ['kid' => gmdate('Y-m-d', intdiv($now, 1000)) . '-' . randomToken(6), 'createdAt' => $now, 'pem' => $pem,
            'n' => b64url($rsa['n']), 'e' => b64url($rsa['e'])];
        writeAtomic($file, json_encode($k, JSON_FLAGS | JSON_PRETTY_PRINT), 0600);
        Log::event($replace ? 'identity.key-replaced' : 'identity.key-created', ['kid' => $k['kid']]);
        return $k;
    });
}

/** The JWK Set (RFC 7517) with the public key. */
function jwkSet(array $key): array
{
    return ['keys' => [['kty' => 'RSA', 'use' => 'sig', 'alg' => 'RS256', 'kid' => $key['kid'], 'n' => $key['n'], 'e' => $key['e']]]];
}

/**
 * Signs an identity token (RFC-10 "The token"), valid for IDENTITY_TOKEN_TTL seconds; with `read`, a read token, with
 * `"scope": "read"`, valid for READ_TOKEN_TTL seconds. `claims`: iss, sub, aud, client_id.
 */
function signIdentityToken(array $key, array $claims, int $now, bool $read = false): string
{
    $part = fn(array $v) => b64url(json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
    $iat = intdiv($now, 1000);
    $input = $part(['typ' => 'at+jwt', 'alg' => 'RS256', 'kid' => $key['kid']]) . '.'
        . $part($claims + ($read ? ['scope' => 'read'] : []) + ['iat' => $iat, 'exp' => $iat + ($read ? READ_TOKEN_TTL : IDENTITY_TOKEN_TTL), 'jti' => randomToken(16)]);
    if (!openssl_sign($input, $signature, $key['pem'], OPENSSL_ALGO_SHA256))
        throw new \RuntimeException('Cannot sign the identity token: ' . openssl_error_string());
    return "$input." . b64url($signature);
}

// --- The log ---------------------------------------------------------------------------------------

function identityLogFile(Config $c): string
{
    return "$c->dataDir/identity-log.json";
}

/** The issued identity tokens of the last 30 days, oldest first: ['at', 'grant', 'clientId', 'audience'], and 'read' for a read token. */
function identityLog(Ctx $ctx): array
{
    $log = json_decode(@file_get_contents(identityLogFile($ctx->config)) ?: '[]', true);
    $since = $ctx->now() - IDENTITY_LOG_MS;
    return array_values(array_filter(is_array($log) ? $log : [], fn($e) => is_array($e) && is_int($e['at'] ?? null) && $e['at'] > $since
        && is_string($e['grant'] ?? null) && is_string($e['audience'] ?? null)));
}

/**
 * Logs an identity token of the grant for the audience (`read`: a read token), under the state lock. False, and nothing
 * logged, if the grant had IDENTITY_TOKENS_PER_MINUTE tokens in the last minute.
 */
function logIdentityToken(Ctx $ctx, array $grant, string $audience, bool $read = false): bool
{
    return $ctx->state->locked(function () use ($ctx, $grant, $audience, $read) {
        $now = $ctx->now();
        $log = identityLog($ctx);
        if (count(array_filter($log, fn($e) => $e['grant'] === $grant['id'] && $e['at'] > $now - 60_000)) >= IDENTITY_TOKENS_PER_MINUTE)
            return false;
        $log[] = ['at' => $now, 'grant' => $grant['id'], 'clientId' => $grant['clientId'], 'audience' => $audience] + ($read ? ['read' => true] : []);
        writeAtomic(identityLogFile($ctx->config), json_encode($log, JSON_FLAGS), 0600);
        return true;
    });
}

/**
 * Where the grant's app acted as the owner: per audience, how often ('reads' of them read tokens) and when it last did
 * ('audience', 'count', 'reads', 'last'), the latest first.
 */
function identityUses(array $log, string $grantId): array
{
    $uses = [];
    foreach ($log as $e)
        if ($e['grant'] === $grantId) {
            $u = $uses[$e['audience']] ?? ['audience' => $e['audience'], 'count' => 0, 'reads' => 0, 'last' => 0];
            $uses[$e['audience']] = ['audience' => $e['audience'], 'count' => $u['count'] + 1, 'reads' => $u['reads'] + (($e['read'] ?? false) === true ? 1 : 0),
                'last' => max($u['last'], $e['at'])];
        }
    usort($uses, fn($a, $b) => $b['last'] <=> $a['last']);
    return $uses;
}
