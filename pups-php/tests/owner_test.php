<?php
// Setup, passkeys, the sign-in and server pages.

namespace Pups\Test;

test('setup: needs the setup secret, works once, then is gone', function () {
    $t = new T([], false);
    eq((new T(['setup_secret' => 'short'], false))->get('/pups/setup')->status, 503, 'secret too short');
    eq($t->get('/pups/apps')->status, 303, 'apps page redirects to setup');
    $page = $t->get('/pups/setup');
    eq($page->status, 200);
    contains($page->text, 'Setup secret');
    $res = $t->post('/pups/setup', ['step' => 'secret', 'secret' => 'wrong']);
    eq($res->status, 400);
    contains($res->text, 'Wrong setup secret');
    $res = $t->post('/pups/setup', ['step' => 'secret', 'secret' => SETUP_SECRET]);
    contains($res->text, 'Choose how you sign in');
    $token = hidden($res->text, 'setup');
    contains($t->post('/pups/setup', ['setup' => $token, 'new_password' => 'short', 'new_password2' => 'short'])->text, 'at least 12 characters');
    contains($t->post('/pups/setup', ['setup' => $token, 'new_password' => 'long enough password', 'new_password2' => 'different password'])->text, 'do not match');
    contains($t->post('/pups/setup', ['setup' => $token])->text, 'Register a passkey or choose a password');
    $res = $t->post('/pups/setup', ['setup' => $token, 'new_password' => 'long enough password', 'new_password2' => 'long enough password']);
    contains($res->text, 'Setup complete');
    eq($t->get('/pups/setup')->status, 404);
    eq($t->post('/pups/setup', ['setup' => $token, 'new_password' => 'another password!!', 'new_password2' => 'another password!!'])->status, 404);
    contains($t->post('/pups/apps', ['password' => 'long enough password'])->text, 'No app has access');
    eq($t->ctx->state->owner()['passkeys'], []);
});

test('setup: rate-limits wrong secrets', function () {
    $t = new T([], false);
    for ($i = 0; $i < 5; $i++)
        $t->post('/pups/setup', ['step' => 'secret', 'secret' => 'wrong']);
    contains($t->post('/pups/setup', ['step' => 'secret', 'secret' => SETUP_SECRET])->text, 'Too many failed attempts');
});

test('passkeys: register at setup, then confirm owner actions with them', function () {
    $t = new T([], false);
    $a = new Authenticator('alice.pups.test', ORIGIN);
    $page = $t->post('/pups/setup', ['step' => 'secret', 'secret' => SETUP_SECRET]);
    $options = pageJson($page->text, 'passkey-create-options');
    eq($options['rp']['id'], 'alice.pups.test');
    eq(array_column($options['pubKeyCredParams'], 'alg')[0], -7);
    $res = $t->post('/pups/setup', ['setup' => hidden($page->text, 'setup'), 'passkey_registration' => $a->create($options)]);
    contains($res->text, 'Setup complete');
    $owner = $t->ctx->state->owner();
    eq([count($owner['passkeys']), $owner['passwordHash'], $owner['passkeys'][0]['alg']], [1, null, -7]);

    // The apps page offers the passkey and accepts an assertion.
    $unlock = $t->get('/pups/apps');
    $get = pageJson($unlock->text, 'passkey-get-options');
    eq($get['allowCredentials'][0]['id'], $owner['passkeys'][0]['id']);
    notContains($unlock->text, 'name="password"', 'no password field without a password');
    $res = $t->post('/pups/apps', ['passkey' => $a->get($get)]);
    eq($res->status, 200);
    contains($res->text, 'No app has access');

    // The same challenge works only once; other origins and missing user verification fail.
    $assertion = $a->get($get);
    eq($t->post('/pups/apps', ['passkey' => $assertion])->status, 401);
    $get = pageJson($t->get('/pups/apps')->text, 'passkey-get-options');
    eq($t->post('/pups/apps', ['passkey' => $a->get($get, 'https://evil.example')])->status, 401);
    $get = pageJson($t->get('/pups/apps')->text, 'passkey-get-options');
    eq($t->post('/pups/apps', ['passkey' => $a->get($get, null, 0x01)])->status, 401);

    // A cloned authenticator (counter going backwards) fails.
    $get = pageJson($t->get('/pups/apps')->text, 'passkey-get-options');
    $a->counter = 0;
    eq($t->post('/pups/apps', ['passkey' => $a->get($get)])->status, 401);
    $t->ctx->state->loginSucceeded();

    // Approving an app with the passkey.
    $a->counter = 100;
    $c = $t->registerClient('app.example');
    $p = T::pkce();
    $page = $t->get(T::authorizeUrl($c, 'identify', $p['challenge']));
    $res = $t->post('/oauth/authorize', ['request' => hidden($page->text, 'request'), 'decision' => 'approve', 'scope' => 'identify',
        'passkey' => $a->get(pageJson($page->text, 'passkey-get-options'))]);
    eq($res->status, 303);
    eq($t->exchange($c, $res->location()['code'], $p['verifier'])->status, 200);
});

test('sign-in page: change the password, add and remove passkeys', function () {
    $t = new T();
    eq($t->post('/pups/sign-in', ['password' => 'wrong'])->status, 401);
    $page = $t->post('/pups/sign-in', ['password' => PASSWORD]);
    contains($page->text, 'You have no passkey');
    $res = $t->post('/pups/sign-in', ['password' => PASSWORD, 'new_password' => 'my new password', 'new_password2' => 'my new password']);
    contains($res->text, 'Your password was changed');
    eq($t->post('/pups/apps', ['password' => PASSWORD])->status, 401, 'old password');
    $t->ctx->state->loginSucceeded();

    $a = new Authenticator('alice.pups.test', ORIGIN);
    $page = $t->post('/pups/sign-in', ['password' => 'my new password']);
    $res = $t->post('/pups/sign-in', ['password' => 'my new password', 'passkey_registration' => $a->create(pageJson($page->text, 'passkey-create-options'))]);
    contains($res->text, 'The passkey was added');
    $id = $t->ctx->state->owner()['passkeys'][0]['id'];
    // The page offers the passkey options once, for both forms.
    eq(substr_count($res->text, 'id="passkey-get-options"'), 1);
    $res = $t->post('/pups/sign-in', ['passkey' => $a->get(pageJson($res->text, 'passkey-get-options')), 'remove_passkey' => $id]);
    contains($res->text, 'The passkey was removed');
    eq($t->ctx->state->owner()['passkeys'], []);
});

test('sign-in page: the only passkey of an owner without password cannot be removed', function () {
    $t = new T([], false);
    $a = new Authenticator('alice.pups.test', ORIGIN);
    $page = $t->post('/pups/setup', ['step' => 'secret', 'secret' => SETUP_SECRET]);
    $t->post('/pups/setup', ['setup' => hidden($page->text, 'setup'), 'passkey_registration' => $a->create(pageJson($page->text, 'passkey-create-options'))]);
    $id = $t->ctx->state->owner()['passkeys'][0]['id'];
    $get = pageJson($t->get('/pups/sign-in')->text, 'passkey-get-options');
    contains($t->post('/pups/sign-in', ['passkey' => $a->get($get), 'remove_passkey' => $id])->text, 'only way to sign in');
    eq(count($t->ctx->state->owner()['passkeys']), 1);
});

test('owner login: rate-limited after 5 failures, and every attempt is logged without the password', function () {
    $t = new T();
    for ($i = 0; $i < 5; $i++)
        eq($t->post('/pups/apps', ['password' => "wrong-$i"])->status, 401);
    contains($t->post('/pups/apps', ['password' => PASSWORD])->text, 'Too many failed attempts');
    $log = implode("\n", \Pups\Log::$lines);
    contains($log, 'login.failed action="view apps page" method=password reason="wrong password"');
    contains($log, 'login.blocked');
    notContains($log, 'wrong-1');
    $t->offset = 2 * 60_000;
    eq($t->post('/pups/apps', ['password' => PASSWORD])->status, 200);
});

test('server page: shows checks and the log after confirmation', function () {
    $t = new T();
    \Pups\Log::$file = "$t->dataDir/pups.log";
    file_put_contents(\Pups\Log::$file, "2026-01-01T00:00:00.000Z file.created path=/appdata/x/<b>.json\n");
    eq($t->get('/pups/server')->status, 200);
    notContains($t->get('/pups/server')->text, 'file.created');
    $res = $t->post('/pups/server', ['password' => PASSWORD]);
    \Pups\Log::$file = null;
    contains($res->text, 'PHP ' . PHP_VERSION);
    contains($res->text, 'file.created path=/appdata/x/&lt;b&gt;.json');
    contains($res->text, 'data-check="ok"');
});

test('owner pages: no CORS, no cookies, strict CSP, assets served', function () {
    $t = new T();
    foreach (['/', '/pups/apps', '/pups/sign-in', '/pups/server'] as $p) {
        $res = $t->get($p);
        eq([$p, $res->header('access-control-allow-origin'), $res->header('set-cookie')], [$p, null, null]);
        contains($res->header('content-security-policy'), "script-src 'self'");
    }
    $res = $t->req('OPTIONS', '/pups/apps');
    eq([$res->status, $res->header('access-control-allow-origin')], [405, null], 'no preflight for owner pages');
    $css = $t->get('/pups/assets/owner.css');
    eq([$css->status, $css->header('content-type')], [200, 'text/css; charset=utf-8']);
    contains($t->get('/pups/assets/owner.js')->text, 'navigator.credentials');
});
