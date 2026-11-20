<?php

namespace Pups;

/**
 * First-run setup (with the setup secret from config.php), the environment checks, the
 * server page (checks and log) and the probe endpoint the checks call.
 */

function notFoundPage(Config $c): Response
{
    return errorPage($c, 'Not found', 'This page does not exist.', 404);
}

function setupEndpoint(Request $req, Ctx $ctx): Response
{
    $c = $ctx->config;
    return htmlErrors($c, function () use ($req, $ctx, $c) {
        // After setup the page is unreachable.
        if ($ctx->state->owner())
            return notFoundPage($c);
        if (strlen($c->setupSecret) < MIN_SETUP_SECRET)
            return errorPage($c, 'Setup not possible', "Set 'setup_secret' in config.php to a random value of at least " . MIN_SETUP_SECRET
                . ' characters first. You enter it on this page once, to prove that you installed this server.', 503);
        if ($req->method === 'GET' || $req->method === 'HEAD')
            return secretForm($ctx);
        if ($req->method !== 'POST')
            return errorPage($c, 'Method not allowed', 'Use GET or POST.', 405);
        $form = $req->form();
        $state = $ctx->state;

        if (field($form, 'step') === 'secret') {
            if ($delay = $state->loginDelay())
                return secretForm($ctx, 'Too many failed attempts. Try again in ' . (int) ceil($delay / 60_000) . ' minute(s).');
            if (!safeEqual(field($form, 'secret', Limits::PASSWORD) ?? '', $c->setupSecret)) {
                $state->loginFailed();
                Log::event('setup.secret-wrong');
                return secretForm($ctx, 'Wrong setup secret.');
            }
            $state->loginSucceeded();
            Log::event('setup.secret-ok');
            return credentialForm($ctx, sign(['t' => 'setup', 'nonce' => randomToken(16), 'exp' => $ctx->now() + 30 * 60_000], $state->secret()));
        }

        $token = field($form, 'setup', Limits::SIGNED);
        $st = verify($token, $state->secret(), $ctx->now());
        if (!$st || ($st['t'] ?? null) !== 'setup')
            return secretForm($ctx, 'The setup session has expired. Enter the setup secret again.');
        $registration = field($form, 'passkey_registration', Limits::SIGNED);
        $password = field($form, 'new_password', Limits::PASSWORD);
        $passkey = null;
        if ($registration !== null)
            try {
                $passkey = verifyPasskeyRegistration($registration, $c, $state);
            } catch (\RuntimeException $e) {
                return credentialForm($ctx, $token, "The passkey could not be registered: {$e->getMessage()}");
            }
        if ($password !== null && ($pwError = checkNewPassword($password, field($form, 'new_password2', Limits::PASSWORD))))
            return credentialForm($ctx, $token, $pwError);
        if (!$passkey && $password === null)
            return credentialForm($ctx, $token, 'Register a passkey or choose a password.');
        if (!$state->useNonce($st['nonce'], $st['exp']) || !$state->createOwner($password === null ? null : hashPassword($password), $passkey))
            return notFoundPage($c);
        Log::event('setup.complete', ['passkey' => (bool) $passkey, 'password' => $password !== null]);
        $wellKnown = installWellKnownRouting($c);
        return page($c, 'Setup complete', '<h1>Setup complete</h1>
<p>You are the owner of this Personal Upload Server. Apps can now find it from your domain, <strong>' . h($c->host) . '</strong>.</p>
' . status($wellKnown) . '
<p role="note">Your login now proves that you are <strong>' . h($c->host) . '</strong>. Anyone who gets it can sign in as you to every app
that uses “sign in with your domain”, not just change your files.' . ($passkey ? '' : ' Consider adding a passkey.') . '</p>
' . sameDomainWarning($c) . '
<h2>Checks</h2>
' . checksHtml(environmentChecks($ctx)) . '
<p><a href="' . h($c->path('/pups/apps')) . '">Manage your apps</a></p>', ['nav' => nav($c, '')]);
    });
}

function secretForm(Ctx $ctx, ?string $error = null): Response
{
    $c = $ctx->config;
    return page($c, 'Set up', '<h1>Set up your Personal Upload Server</h1>
<h2>Checks</h2>
' . checksHtml(environmentChecks($ctx)) . '
<h2>Setup secret</h2>
<p>Enter the setup secret from <code>config.php</code>. It works only until the setup is complete.</p>
' . alert($error) . '
<form method="post">
<input type="hidden" name="step" value="secret">
<label>Setup secret <input type="password" name="secret" autocomplete="off" required></label>
<p><button type="submit">Continue</button></p>
</form>', ['status' => $error ? 400 : 200]);
}

function credentialForm(Ctx $ctx, string $token, ?string $error = null): Response
{
    $c = $ctx->config;
    return page($c, 'Set up', '<h1>Choose how you sign in</h1>
<p>Passkeys are preferred: an abused passkey prompt works once, a stolen password until you change it. A password is a fallback.</p>
' . alert($error) . '
<form method="post">
<input type="hidden" name="setup" value="' . h($token) . '">
<input type="hidden" name="passkey_registration" value="">
<fieldset>
<legend>Passkey</legend>
<p><button type="button" data-passkey-create>Register a passkey and finish</button></p>
<p>A password entered below is saved as a fallback.</p>
</fieldset>
' . newPasswordFields('Password', false) . '
<p><button type="submit">Finish with the password only</button></p>
' . jsonScript('passkey-create-options', passkeyCreateOptions($c, $ctx->state)) . '
</form>', ['status' => $error ? 400 : 200]);
}

// --- Checks --------------------------------------------------------------------------------------

/** The path of the domain's document root, if PHP knows it. */
function documentRoot(): ?string
{
    $root = $_SERVER['DOCUMENT_ROOT'] ?? '';
    return $root !== '' && is_dir($root) ? rtrim($root, '/\\') : null;
}

/** The .htaccess that sends /.well-known/ to PUPS when it is installed in a folder. */
function wellKnownHtaccess(Config $c): string
{
    return "# Written by PUPS (Personal Upload Server): /.well-known/ requests go to PUPS in $c->basePath/,\n"
        . "# except files that exist here and the folders hosting providers use to prove domain control.\n"
        . "<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteCond %{REQUEST_URI} !^/\\.well-known/(acme-challenge|pki-validation)/\n"
        . "RewriteCond %{REQUEST_FILENAME} !-f\nRewriteRule ^ $c->basePath/index.php [L]\n</IfModule>\n";
}

/**
 * In a folder installation, writes /.well-known/.htaccess in the document root (if there is
 * none yet), so that host-meta.json and the well-known files reach PUPS. Returns a message.
 */
function installWellKnownRouting(Config $c): ?string
{
    $root = documentRoot();
    if ($c->basePath === '' || !$root)
        return null;
    $file = "$root/.well-known/.htaccess";
    if (is_file($file))
        return null;
    if (!is_dir("$root/.well-known"))
        @mkdir("$root/.well-known", 0755);
    if (@file_put_contents($file, wellKnownHtaccess($c)) === false)
        return null;
    Log::event('setup.well-known-htaccess-written', ['file' => $file]);
    return "Created $file, which sends /.well-known/ requests to PUPS.";
}

/** Requests one of our own URLs, for the checks. Returns the response, or the error message. */
function selfRequest(Config $c, string $method, string $url, array $headers = []): array|string
{
    try {
        // The extra CA too: locally, the server's own certificate comes from mkcert.
        return httpRequest($method, $url, $headers, '', ['timeout' => 4, 'maxBytes' => 65536, 'extraCa' => $c->extraCa]);
    } catch (\Throwable $e) {
        return $e->getMessage();
    }
}

/**
 * Checks the hosting environment. Each check is [level ('ok', 'warn' or 'fail'), title, detail].
 * The PUT/DELETE probe also decides post_endpoint, unless config.php sets post_fallback.
 */
function environmentChecks(Ctx $ctx): array
{
    $c = $ctx->config;
    $out = [];
    $out[] = PHP_VERSION_ID >= 80100 ? ['ok', 'PHP ' . PHP_VERSION, ''] : ['fail', 'PHP ' . PHP_VERSION, 'PUPS needs PHP 8.1 or later.'];
    $out[] = extension_loaded('openssl') ? ['ok', 'openssl extension', '']
        : ['fail', 'openssl extension', 'Needed to fetch client metadata documents and to check passkeys.'];
    $out[] = function_exists('sodium_crypto_sign_verify_detached') ? ['ok', 'sodium extension', 'Ed25519 passkeys are supported.']
        : ['ok', 'sodium extension', 'Not installed, so Ed25519 passkeys are not offered. Nothing to do: all common passkeys use ES256.'];
    $https = ($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['HTTPS'] ?? '') === '1' || ($_SERVER['REQUEST_SCHEME'] ?? '') === 'https'
        || strtolower($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https' || ($_SERVER['SERVER_PORT'] ?? '') === '443';
    $out[] = str_starts_with($c->origin, 'https:')
        ? ($https || PHP_SAPI === 'cli' ? ['ok', 'HTTPS', ''] : ['warn', 'HTTPS', 'This request did not seem to arrive over HTTPS. Enable HTTPS (a free certificate) at your hosting provider.'])
        : ['warn', 'HTTPS', "The origin is $c->origin. Apps require HTTPS; plain HTTP is for local tests only."];

    $root = documentRoot();
    $dataReal = realpath($c->dataDir) ?: $c->dataDir;
    $inRoot = $root && str_starts_with($dataReal . '/', (realpath($root) ?: $root) . '/');
    $out[] = is_writable($c->dataDir) ? ['ok', 'Data directory', $dataReal . ($inRoot ? ' (inside the web root, protected by .htaccess; outside is better if your host allows it)' : '')]
        : ['fail', 'Data directory', "$dataReal is not writable for PHP."];
    if ($inRoot) {
        $url = $c->origin . substr($dataReal, strlen(realpath($root) ?: $root)) . '/state.json';
        $r = selfRequest($c, 'GET', $url);
        if (is_array($r) && $r['status'] === 200 && str_contains((string) $r['body'], '"secret"'))
            $out[] = ['fail', 'Data directory', "$url can be downloaded! Move the data directory out of the web root ('data_dir' in config.php)."];
    }

    $probe = "$c->base/pups/probe";
    $r = selfRequest($c, 'POST', $probe, ['Authorization' => 'Bearer pups-probe']);
    if (is_string($r))
        $out[] = ['warn', 'Self-test', "This server could not reach itself at $probe ($r), so the next checks were skipped."];
    else {
        $body = json_decode((string) $r['body'], true);
        $out[] = ($body['authorization'] ?? false) === true ? ['ok', 'Authorization header', '']
            : ['fail', 'Authorization header', 'The Authorization header does not reach PHP, so apps can\'t authenticate. Make sure .htaccess is used (AllowOverride) and mod_rewrite is on.'];
        $blocked = [];
        foreach (['PUT', 'DELETE'] as $m) {
            $rm = selfRequest($c, $m, $probe);
            if (!is_array($rm) || (json_decode((string) $rm['body'], true)['method'] ?? null) !== $m)
                $blocked[] = $m;
        }
        if ($c->postFallbackDetected) {
            writeAtomic("$c->dataDir/detected.json", json_encode(['post_fallback' => (bool) $blocked, 'checkedAt' => gmdate('c')]), 0644);
            if ((bool) $blocked !== $c->postFallback)
                Log::event('setup.post-fallback-detected', ['blocked' => implode(',', $blocked) ?: null, 'postFallback' => (bool) $blocked]);
        }
        $out[] = !$blocked ? ['ok', 'PUT and DELETE', ''] : ['warn', 'PUT and DELETE', implode(' and ', $blocked) . ' are blocked by the web server. '
            . ($c->postFallbackDetected ? 'Apps are told to send writes through POST (post_endpoint) instead.' : "config.php sets 'post_fallback'.")];
        $hm = selfRequest($c, 'GET', $c->origin . HOST_META_PATH);
        $ok = is_array($hm) && $hm['status'] === 200 && str_contains((string) $hm['body'], $c->configUrl);
        $cors = is_array($hm) && ($hm['headers']['access-control-allow-origin'] ?? null) === '*';
        $out[] = $ok && $cors ? ['ok', 'Discovery', $c->origin . HOST_META_PATH . ' points to PUPS.']
            : ['fail', 'Discovery', $c->origin . HOST_META_PATH . ($ok ? ' is not served by PUPS (no CORS header): remove the static file, so that PUPS can serve and edit it.'
                : ' does not point to PUPS' . (is_array($hm) ? " (HTTP {$hm['status']})" : " ($hm)") . '.'
                . ($c->basePath !== '' ? " Put this into .well-known/.htaccess in your domain's document root:<pre>" . h(wellKnownHtaccess($c)) . '</pre>' : ''))];
    }
    if ($c->postFallback) {
        $post = iniBytes(ini_get('post_max_size') ?: '0');
        if ($post && $post < $c->maxUploadBytes)
            $out[] = ['warn', 'Upload size', "Writes go through POST, and PHP's post_max_size is " . ini_get('post_max_size') . ', so files can have at most that size.'];
    }
    if ($c->mentions || $c->comments) {
        // Webmentions are checked after the response; how early the client is let go depends on the server.
        $early = function_exists('fastcgi_finish_request') ? 'fastcgi_finish_request' : (function_exists('litespeed_finish_request') ? 'litespeed_finish_request' : null);
        $out[] = $early ? ['ok', 'Mentions and comments', "Checked after the response is sent ($early)."]
            : ['ok', 'Mentions and comments', 'Checked after the response is sent. This server can\'t end responses early (no PHP-FPM), so senders may wait a few seconds for the connection to close.'];
        if (!function_exists('idn_to_ascii'))
            $out[] = ['ok', 'intl extension', 'Not installed, so handles with non-ASCII host names (e.g. @müller.example) are not recognized.'];
    }
    return $out;
}

function checksHtml(array $checks): string
{
    $label = ['ok' => '✓ OK', 'warn' => '! Warning', 'fail' => '✗ Problem'];
    return "<table>\n<thead><tr><th scope=\"col\">Check</th><th scope=\"col\">Result</th><th scope=\"col\">Details</th></tr></thead>\n<tbody>\n"
        . implode("\n", array_map(fn($x) => '<tr data-check="' . $x[0] . '"><th scope="row">' . h($x[1]) . '</th><td>' . $label[$x[0]] . '</td><td>'
            // Details may contain <pre> blocks built with h(); everything else is plain text.
            . (str_contains($x[2], '<pre>') ? $x[2] : h($x[2])) . '</td></tr>', $checks)) . "\n</tbody>\n</table>";
}

/** The server page: checks and the end of the log. */
function serverEndpoint(Request $req, Ctx $ctx): Response
{
    $c = $ctx->config;
    return htmlErrors($c, function () use ($req, $ctx, $c) {
        $g = guardOwner($req, $ctx, 'Server', 'Confirm that you are the owner of <strong>' . h($c->host) . '</strong> to see the checks and the log.', '/pups/server', 'view server page');
        if ($g instanceof Response)
            return $g;
        $wellKnown = installWellKnownRouting($c);
        return page($c, 'Server', '<h1>Server</h1>
' . status($wellKnown) . '
<p>PUPS ' . VERSION . ' (RFC-6 ' . SPEC_VERSION . ') on PHP ' . PHP_VERSION . '. Data: <code>' . h(realpath($c->dataDir) ?: $c->dataDir) . '</code></p>
<h2>Checks</h2>
' . checksHtml(environmentChecks($ctx)) . '
<h2>Log</h2>
<p>The last 300 entries of <code>' . h(Log::file($c->dataDir)) . '</code>, newest last. Passwords and tokens are never logged; tokens appear as the first 8 characters of their hash.</p>
<pre>' . h(implode("\n", Log::tail(300))) . '</pre>
<form method="post">
' . ownerConfirm($ctx) . '
<p><button type="submit" name="show" value="1">Reload</button></p>
</form>', ['nav' => nav($c, '/pups/server')]);
    });
}

/** /pups/probe: tells the checks which method and whether the Authorization header arrived. */
function probeEndpoint(Request $req): Response
{
    return json(['pups' => 'probe', 'method' => $req->method, 'authorization' => $req->header('authorization') === 'Bearer pups-probe'], 200, NO_STORE);
}
