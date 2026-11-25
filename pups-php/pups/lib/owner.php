<?php

namespace Pups;

const MIN_PASSWORD_LENGTH = 12;

/** The header in which owner.js sends its page session, or `new`, and gets the renewed one. */
const PAGE_HEADER = 'PUPS-Session';
/** A page session ends after this time without use, and this long after the confirmation (RFC-6 "Deployment modes"). */
const PAGE_IDLE_MS = 15 * 60_000;
const PAGE_MAX_MS = 3600_000;

/** Derived from the owner's password and passkeys, so that changing them ends every page session. */
function credentialsVersion(Ctx $ctx): string
{
    $owner = $ctx->state->owner();
    return substr(b64url(hash('sha256', implode(' ', [$owner['passwordHash'] ?? '', ...array_column($owner['passkeys'] ?? [], 'id')]), true)), 0, 16);
}

/**
 * The time of the confirmation that started the request's page session, if it has a valid one: a signed value
 * `{t: 'page', start, v, exp}`, not stored. owner.js keeps it in memory only.
 */
function pageSession(Request $req, Ctx $ctx): ?int
{
    $token = $req->header(PAGE_HEADER);
    if ($token === null || $token === 'new' || strlen($token) > 1024)
        return null;
    $p = verify($token, $ctx->state->secret(), $ctx->now());
    return ($p['t'] ?? null) === 'page' && is_int($p['start'] ?? null) && $p['start'] + PAGE_MAX_MS > $ctx->now()
        && ($p['v'] ?? null) === credentialsVersion($ctx) ? $p['start'] : null;
}

/** The renewed page session of a confirmation at `start`, now or when the session began. */
function pageSessionToken(Ctx $ctx, int $start): string
{
    return sign(['t' => 'page', 'start' => $start, 'v' => credentialsVersion($ctx), 'exp' => min($ctx->now() + PAGE_IDLE_MS, $start + PAGE_MAX_MS)], $ctx->state->secret());
}

/**
 * Verifies a fresh owner credential from a form: a passkey assertion (field `passkey`) or
 * the password (field `password`), which is not accepted while the owner has a passkey. The
 * server runs in same-domain mode only, so it never sets a cookie: a page session (above) is
 * enough for viewing, every change carries a credential (RFC-6 "Deployment modes"). Failed
 * attempts are rate-limited: 5 per 15 minutes, then growing delays. Every attempt is logged.
 * Returns null on success, otherwise an error message.
 */
function verifyCredential(array $form, Ctx $ctx, string $action, array $details = []): ?string
{
    $state = $ctx->state;
    if ($delay = $state->loginDelay()) {
        Log::event('login.blocked', ['action' => $action] + $details + ['retryInSeconds' => (int) ceil($delay / 1000)]);
        return 'Too many failed attempts. Try again in ' . (int) ceil($delay / 60_000) . ' minute(s).';
    }
    $owner = $state->owner();
    if (!$owner)
        return 'No owner is set up.';
    $passkey = field($form, 'passkey', Limits::SIGNED);
    $password = field($form, 'password', Limits::PASSWORD);
    if ($passkey !== null) {
        $method = 'passkey';
        try {
            verifyPasskeyAssertion($passkey, $ctx->config, $state);
            $reason = null;
        } catch (\RuntimeException $e) {
            $reason = $e->getMessage();
        }
    } elseif ($password !== null && $owner['passkeys']) {
        // The password is kept for the day the passkeys are lost and removed (RFC-6 "Owner authentication").
        Log::event('login.failed', ['action' => $action] + $details + ['reason' => 'password while a passkey exists']);
        return 'Confirm with your passkey. The password works only while you have no passkey.';
    } elseif ($password !== null) {
        $method = 'password';
        $reason = $owner['passwordHash'] && verifyPassword($password, $owner['passwordHash']) ? null : 'wrong password';
    } else {
        Log::event('login.failed', ['action' => $action] + $details + ['reason' => 'no credential']);
        return 'Please confirm with your passkey or password.';
    }
    if ($reason !== null) {
        $failures = $state->loginFailed();
        Log::event('login.failed', ['action' => $action, 'method' => $method] + $details + ['reason' => $reason, 'recentFailures' => $failures]);
        return 'The confirmation failed.';
    }
    $state->loginSucceeded();
    Log::event('login.ok', ['action' => $action, 'method' => $method] + $details);
    return null;
}

function checkNewPassword(?string $password, ?string $repeat): ?string
{
    if ($password === null || (int) preg_match_all('/./su', $password) < MIN_PASSWORD_LENGTH)
        return 'The password must have at least ' . MIN_PASSWORD_LENGTH . ' characters.';
    return $password === $repeat ? null : 'The passwords do not match.';
}
