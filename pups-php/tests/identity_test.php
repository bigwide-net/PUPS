<?php
// Identity tokens (RFC-10): the scope, the token exchange, the JWK Set and the log on the apps page.

namespace Pups\Test;

use function Pups\coseToKey;
use function Pups\fromB64url;
use function Pups\isAudience;

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS = 'urn:ietf:params:oauth:token-type:access_token';

/** A token exchange request for https://polls.example.com; `fields` add to it or replace its fields (a list repeats a field). */
function identityExchange(T $t, array $client, string $subject, array $fields = []): Res
{
    return $t->post('/oauth/token', $fields + ['grant_type' => TOKEN_EXCHANGE, 'client_id' => $client['clientId'], 'subject_token' => $subject,
        'subject_token_type' => ACCESS, 'audience' => 'https://polls.example.com']);
}

function jwtPart(string $token, int $i): mixed
{
    return json_decode(fromB64url(explode('.', $token)[$i]) ?? '', true);
}

function identityKeys(T $t, string $prefix = ''): array
{
    return $t->get("$prefix/pups/jwks.json")->json()['keys'];
}

/** Whether the token's signature checks out with the published key of its kid, as a server that checks the token would do it. */
function identityVerifies(T $t, string $token): bool
{
    $kid = jwtPart($token, 0)['kid'];
    $jwk = array_values(array_filter(identityKeys($t), fn($k) => $k['kid'] === $kid))[0] ?? null;
    if (!$jwk)
        return false;
    [, $pem] = coseToKey([1 => 3, 3 => -257, -1 => fromB64url($jwk['n']), -2 => fromB64url($jwk['e'])]);
    [$h, $p, $sig] = explode('.', $token);
    return openssl_verify("$h.$p", fromB64url($sig), $pem, OPENSSL_ALGO_SHA256) === 1;
}

test('identity tokens: audiences are https origins without path, port 443, local names or IP addresses', function () {
    foreach (['https://polls.example.com', 'https://polls.example.com:8443', 'https://xn--bcher-kva.example', 'https://a.b'] as $a)
        ok(isAudience($a), "$a is an audience");
    foreach (['https://polls.example.com/', 'https://polls.example.com/vote', 'http://polls.example.com', 'https://Polls.example.com', 'https://polls.example.com:443',
        'https://polls.example.com:08443', 'https://polls.example.com:65536', 'https://polls.example.com:', 'https://polls.example.com?x', 'https://polls.example.com#x',
        'https://u@polls.example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://a.localhost', 'https://printer.local', 'https://intranet',
        'https://a.123', 'https://bücher.example', ' https://polls.example.com', "https://polls.example.com\n", ''] as $a)
        ok(!isAudience($a), json_encode($a) . ' is no audience');
});

test('identity tokens: are announced, with the key set', function () {
    $t = new T();
    $cfg = $t->get('/personal-storage.json')->json();
    eq([$cfg['scopes_supported'], $cfg['jwks_uri']], [['identify', 'write:/appdata/', 'identity-tokens'], ORIGIN . '/pups/jwks.json']);
    $m = $t->get('/.well-known/oauth-authorization-server')->json();
    eq([$m['jwks_uri'], $m['grant_types_supported'], in_array('identity-tokens', $m['scopes_supported'], true)],
        [ORIGIN . '/pups/jwks.json', ['authorization_code', 'refresh_token', TOKEN_EXCHANGE], true]);
    $r = $t->get('/pups/jwks.json');
    eq([$r->status, $r->header('access-control-allow-origin'), $r->header('cache-control'), $r->header('content-type')],
        [200, '*', 'public, max-age=600', 'application/json; charset=utf-8']);
    $keys = $r->json()['keys'];
    eq(count($keys), 1);
    eq(array_keys($keys[0]), ['kty', 'use', 'alg', 'kid', 'n', 'e']);
    eq([$keys[0]['kty'], $keys[0]['use'], $keys[0]['alg'], $keys[0]['e']], ['RSA', 'sig', 'RS256', 'AQAB']);
    ok(preg_match('/^\d{4}-\d{2}-\d{2}-[A-Za-z0-9_-]{8}$/D', $keys[0]['kid']), 'kid: date and random suffix');
    eq(strlen(fromB64url($keys[0]['n'])), 256, '2048 bits');
    eq(identityKeys($t), $keys, 'the same key next time');
    eq($t->req('HEAD', '/pups/jwks.json')->status, 200, 'HEAD');
    eq($t->req('OPTIONS', '/pups/jwks.json')->header('access-control-allow-origin'), '*', 'preflight');
    eq($t->req('PUT', '/pups/jwks.json', ['authorization' => 'Bearer x', 'content-type' => 'application/json'], '{}')->status, 405);

    // The private key is in the data directory, readable for PHP only, and nowhere in the storage.
    $file = "$t->dataDir/identity-key.json";
    eq(fileperms($file) & 0777, 0600, 'mode');
    contains(file_get_contents($file), 'PRIVATE KEY');
    eq(glob("$t->dataDir/files/*key*"), [], 'not in the storage');

    // A folder installation has the key set under its base.
    $f = new T(['base_path' => '/pups']);
    eq($f->get('/pups/personal-storage.json')->json()['jwks_uri'], ORIGIN . '/pups/pups/jwks.json');
    eq($f->get('/.well-known/oauth-authorization-server')->json()['jwks_uri'], ORIGIN . '/pups/pups/jwks.json');
    eq(count(identityKeys($f, '/pups')), 1);
    eq($f->get('/pups/jwks.json')->status, 404, 'outside the base');
});

test('identity tokens: need their own consent group, with confirmation, and come with a refresh token', function () {
    $t = new T();
    $app = $t->registerClient('reader.example');
    $page = $t->get(T::authorizeUrl($app, 'identify identity-tokens', T::pkce()['challenge']))->text;
    contains($page, '<input type="checkbox" name="scope" value="identity-tokens" checked> <span>Act as <strong>alice.pups.test</strong> on other sites');
    contains($page, 'It can prove to any site that it acts for you, whenever you use it there.');
    contains($page, 'name="password"');
    // The group comes after the path groups.
    $page = $t->get(T::authorizeUrl($app, 'identity-tokens write:/appdata/reader.example/', T::pkce()['challenge']))->text;
    ok(strpos($page, 'value="identity-tokens"') > strpos($page, 'value="write:/appdata/reader.example/"'), 'after the path groups');

    $tok = $t->connect($app, 'identify identity-tokens');
    eq([$tok['scope'], isset($tok['refresh_token'])], ['identify identity-tokens', true]);
    $tok = $t->connect($app, 'identity-tokens');
    ok(isset($tok['refresh_token']), 'alone too');
    // Without confirmation, nothing is granted.
    [$res] = $t->approve($app, 'identity-tokens', null, 'wrong password');
    eq($res->status, 401);
    // On the apps page, as on the consent screen.
    contains($t->post('/pups/apps', ['password' => PASSWORD])->text, '<li>Act as <strong>alice.pups.test</strong> on other sites');
});

test('identity tokens: are signed tokens for one audience, which the published key checks', function () {
    $t = new T();
    $app = $t->registerClient('reader.example');
    $tok = $t->connect($app, 'identify identity-tokens write:/appdata/reader.example/');
    $r = identityExchange($t, $app, $tok['access_token']);
    eq([$r->status, $r->header('cache-control'), $r->header('access-control-allow-origin')], [200, 'no-store', '*']);
    $body = $r->json();
    eq([$body['issued_token_type'], $body['token_type'], $body['expires_in']], ['urn:ietf:params:oauth:token-type:jwt', 'Bearer', 60]);
    $jwt = $body['access_token'];
    eq(jwtPart($jwt, 0), ['typ' => 'at+jwt', 'alg' => 'RS256', 'kid' => identityKeys($t)[0]['kid']]);
    $claims = jwtPart($jwt, 1);
    eq(array_keys($claims), ['iss', 'sub', 'aud', 'client_id', 'iat', 'exp', 'jti']);
    eq([$claims['iss'], $claims['sub'], $claims['aud'], $claims['client_id']], [ORIGIN, ORIGIN . '/', 'https://polls.example.com', $app['clientId']]);
    eq($claims['exp'] - $claims['iat'], 60);
    ok(abs($claims['iat'] - time()) < 5, 'iat is now');
    eq(strlen(fromB64url($claims['jti'])), 16, 'jti: 128 bits');
    ok(identityVerifies($t, $jwt), 'the published key checks the signature');
    ok(!identityVerifies($t, substr($jwt, 0, -4) . (substr($jwt, -4) === 'AAAA' ? 'BBBB' : 'AAAA')), 'not a changed signature');
    $again = identityExchange($t, $app, $tok['access_token'], ['audience' => 'https://polls.example.com:8443'])->json()['access_token'];
    ok(jwtPart($again, 1)['jti'] !== $claims['jti'], 'a new jti every time');
    eq(jwtPart($again, 1)['aud'], 'https://polls.example.com:8443');

    // A read token, for fetching personal feeds: scope read, 24 hours.
    $read = identityExchange($t, $app, $tok['access_token'], ['audience' => 'https://comments.example.org', 'scope' => 'read'])->json();
    eq([$read['issued_token_type'], $read['token_type'], $read['expires_in'], $read['scope']], ['urn:ietf:params:oauth:token-type:jwt', 'Bearer', 86400, 'read']);
    $rc = jwtPart($read['access_token'], 1);
    eq(array_keys($rc), ['iss', 'sub', 'aud', 'client_id', 'scope', 'iat', 'exp', 'jti']);
    eq([$rc['scope'], $rc['aud'], $rc['exp'] - $rc['iat']], ['read', 'https://comments.example.org', 86400]);
    ok(identityVerifies($t, $read['access_token']), 'the published key checks the read token');

    // Never accepted by the upload API.
    eq($t->put('/appdata/reader.example/x.json', $jwt, '{}')->status, 401);
    eq($t->put('/appdata/reader.example/x.json', $read['access_token'], '{}')->status, 401);
    eq($t->put('/appdata/reader.example/x.json', $tok['access_token'], '{}')->status, 201);
    eq($t->get('/appdata/reader.example/x.json', ['authorization' => "Bearer $jwt"])->status, 401);
});

test('identity tokens: are refused without the scope, for another app, a bad audience or extra parameters, and after revocation', function () {
    $t = new T();
    $app = $t->registerClient('reader.example');
    $writer = $t->registerClient('writer.example');
    $plain = $t->connect($writer, 'write:/appdata/writer.example/');
    eq(identityExchange($t, $writer, $plain['access_token'])->json()['error'], 'invalid_scope');
    $tok = $t->connect($app, 'identity-tokens');
    eq(identityExchange($t, $writer, $tok['access_token'])->json()['error'], 'invalid_grant', 'another app');
    eq(identityExchange($t, $app, 'nonsense')->json()['error'], 'invalid_grant');
    eq(identityExchange($t, $app, $tok['refresh_token'])->json()['error'], 'invalid_grant', 'a refresh token');
    foreach (['https://polls.example.com/', 'https://polls.example.com/vote', 'http://polls.example.com', 'https://127.0.0.1', 'https://localhost',
        'https://user@polls.example.com', 'https://polls.example.com?x=1', 'https://polls.example.com#x'] as $audience)
        eq(identityExchange($t, $app, $tok['access_token'], ['audience' => $audience])->json()['error'], 'invalid_target', $audience);
    eq(identityExchange($t, $app, $tok['access_token'], ['audience' => ['https://a.example', 'https://b.example']])->json()['error'], 'invalid_target', 'two audiences');
    eq(identityExchange($t, $app, $tok['access_token'], ['audience' => []])->json()['error'], 'invalid_target', 'no audience');
    foreach ([['resource' => 'https://polls.example.com'], ['actor_token' => 'x'], ['actor_token_type' => ACCESS], ['requested_token_type' => ACCESS]] as $extra)
        eq(identityExchange($t, $app, $tok['access_token'], $extra)->json()['error'], 'invalid_request', json_encode($extra));
    foreach (['identify', 'read write', 'write', ['read', 'read']] as $scope)
        eq(identityExchange($t, $app, $tok['access_token'], ['scope' => $scope])->json()['error'], 'invalid_scope', json_encode($scope));
    eq(identityExchange($t, $app, $tok['access_token'], ['requested_token_type' => 'urn:ietf:params:oauth:token-type:jwt'])->status, 200);
    eq(identityExchange($t, $app, $tok['access_token'], ['subject_token_type' => []])->json()['error'], 'invalid_request', 'no subject_token_type');
    eq(identityExchange($t, $app, '')->json()['error'], 'invalid_request', 'no subject_token');

    // After an hour the access token has expired; a refreshed one works.
    $t->offset += 3601_000;
    eq(identityExchange($t, $app, $tok['access_token'])->json()['error'], 'invalid_grant', 'expired');
    $tok = $t->refresh($app, $tok['refresh_token'])->json();
    eq(identityExchange($t, $app, $tok['access_token'])->status, 200);
    $t->post('/oauth/revoke', ['token' => $tok['refresh_token'], 'client_id' => $app['clientId']]);
    eq(identityExchange($t, $app, $tok['access_token'])->json()['error'], 'invalid_grant', 'revoked');
    // Removed on the apps page.
    $tok = $t->connect($app, 'identity-tokens');
    $t->post('/pups/apps', ['revoke' => $t->ctx->state->activeGrants()[0]['id'], 'password' => PASSWORD]);
    eq(identityExchange($t, $app, $tok['access_token'])->json()['error'], 'invalid_grant', 'removed');
});

test('identity tokens: are limited per minute, logged on the apps page, and the owner can replace the key', function () {
    $t = new T();
    $app = $t->registerClient('reader.example');
    $other = $t->registerClient('other.example');
    // The apps page lists the newest grant first.
    $otherTok = $t->connect($other, 'identity-tokens');
    $tok = $t->connect($app, 'identity-tokens');
    for ($i = 0; $i < 59; $i++)
        eq(identityExchange($t, $app, $tok['access_token'], ['audience' => 'https://groups.example.com'] + ($i < 2 ? ['scope' => 'read'] : []))->status, 200);
    $last = identityExchange($t, $app, $tok['access_token'])->json()['access_token'];
    $limited = identityExchange($t, $app, $tok['access_token']);
    eq([$limited->status, $limited->json()['error'], $limited->header('retry-after')], [429, 'slow_down', '60']);
    eq(identityExchange($t, $other, $otherTok['access_token'])->status, 200, 'per grant');
    $t->offset += 61_000;
    eq(identityExchange($t, $app, $tok['access_token'], ['audience' => 'https://groups.example.com'])->status, 200, 'a minute later');

    $html = $t->post('/pups/apps', ['password' => PASSWORD])->text;
    contains($html, 'Acted as you on other sites in the last 30 days:');
    contains($html, '<li><code>polls.example.com</code>: once, last <time');
    contains($html, '<li><code>groups.example.com</code>: 60 times (2 times for reading), last <time');
    // groups.example.com was the latest.
    ok(strpos($html, 'groups.example.com</code>') < strpos($html, 'polls.example.com</code>: once'), 'the latest first');
    eq(substr_count($html, 'polls.example.com</code>: once'), 2, 'each app its own');
    $kid = identityKeys($t)[0]['kid'];
    contains($html, "<code>$kid</code>");
    contains($html, '<button type="submit" name="replace_signing_key" value="1">Replace the signing key</button>');

    // Replacing the key needs a fresh confirmation.
    $html = $t->post('/pups/apps', ['replace_signing_key' => '1', 'password' => 'wrong'])->text;
    eq(identityKeys($t)[0]['kid'], $kid, 'not replaced');
    $html = $t->post('/pups/apps', ['replace_signing_key' => '1', 'password' => PASSWORD])->text;
    $keys = identityKeys($t);
    eq([count($keys), $keys[0]['kid'] === $kid], [1, false]);
    contains($html, "The signing key was replaced; the new one is {$keys[0]['kid']}.");
    ok(!identityVerifies($t, $last), 'the old key checks nothing');
    ok(identityVerifies($t, identityExchange($t, $app, $tok['access_token'])->json()['access_token']), 'the new key signs');

    // The log is kept for 30 days.
    $t->offset += 31 * 24 * 3600_000;
    $html = $t->post('/pups/apps', ['password' => PASSWORD])->text;
    notContains($html, 'Acted as you on other sites');
    contains($html, 'reader.example');
});

test('identity tokens: without the openssl extension, the server offers none', function () {
    $t = new T();
    $t->config->identityTokens = false;
    $cfg = $t->get('/personal-storage.json')->json();
    eq([$cfg['scopes_supported'], isset($cfg['jwks_uri'])], [['identify', 'write:/appdata/'], false]);
    $m = $t->get('/.well-known/oauth-authorization-server')->json();
    eq([isset($m['jwks_uri']), $m['grant_types_supported'], in_array('identity-tokens', $m['scopes_supported'], true)], [false, ['authorization_code', 'refresh_token'], false]);
    eq($t->get('/pups/jwks.json')->status, 404);
    $app = $t->registerClient('reader.example');
    $res = $t->get(T::authorizeUrl($app, 'identify identity-tokens', T::pkce()['challenge']));
    eq([$res->status, $res->location()['error']], [302, 'invalid_scope']);
    $tok = $t->connect($app, 'write:/appdata/reader.example/');
    eq(identityExchange($t, $app, $tok['access_token'])->json()['error'], 'unsupported_grant_type');
    $html = $t->post('/pups/apps', ['password' => PASSWORD, 'replace_signing_key' => '1'])->text;
    notContains($html, 'Signing key');
    ok(!is_file("$t->dataDir/identity-key.json"), 'no key made');
});
