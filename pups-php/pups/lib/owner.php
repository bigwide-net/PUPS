<?php

namespace Pups;

const MIN_PASSWORD_LENGTH = 12;

/**
 * Verifies a fresh owner credential from a form: a passkey assertion (field `passkey`) or
 * the password (field `password`). The server runs in same-domain mode only, so it never
 * sets a cookie: every owner action carries one (RFC-6 "Deployment modes"). Failed attempts
 * are rate-limited: 5 per 15 minutes, then growing delays. Every attempt is logged.
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
