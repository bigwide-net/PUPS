<?php

namespace Pups;

const REQUEST_TTL = 15 * 60_000;

function redirectTo(string $redirectUri, array $params, int $status = 302): Response
{
    [$base, $query] = array_pad(explode('?', $redirectUri, 2), 2, '');
    $params = array_filter($params, fn($v) => $v !== null);
    // Parameters we set replace those of the same name in the redirect URI.
    $keep = array_filter(explode('&', $query), fn($p) => $p !== '' && !array_key_exists(urldecode(explode('=', $p)[0]), $params));
    $query = implode('&', [...$keep, http_build_query($params, '', '&', PHP_QUERY_RFC3986)]);
    return new Response($status, ['Location' => "$base?$query", 'Cache-Control' => 'no-store', 'Referrer-Policy' => 'no-referrer']);
}

const FEED_PATHS = ['/feed.json', '/feed/', '/.well-known/following.opml'];
/** The groups with path scopes, in the order of the consent screen. Their names are in texts.json (group.*). */
const PATH_GROUPS = ['appdata', 'feeds', 'profile', 'private'];

/** The consent screen's group of a scope (RFC-6 "Consent"): identity, appdata, feeds, profile or private. */
function scopeGroup(array $sc): string
{
    if ($sc['kind'] === 'identify')
        return 'identity';
    if (!$sc['wellKnown'])
        return 'appdata';
    if (isPrivate($sc['wellKnown']['path']))
        return 'private';
    return in_array($sc['wellKnown']['path'], FEED_PATHS, true) ? 'feeds' : 'profile';
}

/** A group's name. Private data is only read if the group has no write scope. */
function groupText(string $group, array $scopes): string
{
    return t($group === 'private' && !array_filter($scopes, fn($s) => $s['kind'] === 'write') ? 'group.privateRead' : "group.$group");
}

/** What a scope covers, for the details of its group. Private paths say whether the app may only read them. */
function scopeItem(array $sc): string
{
    $code = '<code>' . h(visible($sc['prefix'])) . '</code>';
    $e = $sc['wellKnown'];
    if (!$e)
        return t('scope.ownFolder', ['path' => $code]);
    $what = $sc['prefix'] === $e['path'] && $e['description'] ? t('scope.named', ['name' => h(visible($e['description'])), 'path' => $code])
        : (str_ends_with($sc['prefix'], '/') ? t('scope.filesUnder', ['path' => $code]) : $code);
    return isPrivate($e['path']) ? t($sc['kind'] === 'read' ? 'scope.read' : 'scope.readWrite', ['what' => $what]) : $what;
}

/** Scopes by their consent screen group, in the order of the scopes. */
function groupScopes(array $scopes): array
{
    $groups = [];
    foreach ($scopes as $str => $sc)
        $groups[scopeGroup($sc)][$str] = $sc;
    return $groups;
}

/** The collapsed details of a group of scopes: what they cover, and the rels and properties they allow. */
function groupDetails(array $scopes): string
{
    $list = fn(array $xs) => implode(', ', array_map(fn($x) => '<code>' . h(visible($x)) . '</code>', array_unique($xs)));
    // Rels and properties come with a scope for the whole declared path.
    $whole = array_values(array_filter($scopes, fn($s) => $s['wellKnown'] && $s['prefix'] === $s['wellKnown']['path']));
    $rels = array_merge([], ...array_map(fn($s) => $s['wellKnown']['rels'], $whole));
    $props = array_merge([], ...array_map(fn($s) => $s['wellKnown']['properties'], $whole));
    $private = array_filter($scopes, fn($s) => scopeGroup($s) === 'private');
    return "<details>\n<summary>" . t('details.summary') . "</summary>\n" . ($private ? '' : '<p>' . t('details.write') . "</p>\n") . "<ul>\n"
        . implode("\n", array_map(fn($s) => '<li>' . scopeItem($s) . '</li>', $scopes)) . "\n</ul>\n"
        . ($rels ? '<p>' . t('details.rels', ['list' => $list($rels)]) . "</p>\n" : '')
        . ($props ? '<p>' . t('details.properties', ['list' => $list($props)]) . "</p>\n" : '')
        . '</details>';
}

/**
 * The permissions of the consent screen: identity, then one checkbox per group, which grants
 * all of the group's scopes. The paths, rels and properties are in a collapsed details element.
 */
function permissionGroups(array $scopes, Config $c): string
{
    $groups = groupScopes($scopes);
    $out = '<label><input type="checkbox" checked disabled> <span>' . t('group.identity', ['me' => '<strong>' . h($c->host) . '</strong>']) . '</span></label>'
        . (isset($groups['identity']) ? "\n" . '<input type="hidden" name="scope" value="identify">' : '');
    foreach (PATH_GROUPS as $group)
        if (isset($groups[$group]))
            $out .= "\n<div>\n" . '<label><input type="checkbox" name="scope" value="' . h(implode(' ', array_keys($groups[$group]))) . '" checked> <span>'
                . groupText($group, $groups[$group]) . "</span></label>\n" . groupDetails($groups[$group]) . "\n</div>";
    return $out;
}

/** A grant's permissions on the apps page, grouped as on the consent screen. */
function permissionList(string $scope, string $clientHost, Config $c): string
{
    $scopes = $unknown = [];
    foreach (explode(' ', $scope) as $str) {
        $sc = parseScope($str, $clientHost, $c);
        if ($sc)
            $scopes[$str] = $sc;
        else // E.g. a well-known path that was removed from the configuration.
            $unknown[] = '<li><code>' . h(visible($str)) . '</code></li>';
    }
    $groups = groupScopes($scopes);
    $items = isset($groups['identity']) ? ['<li>' . t('group.identity', ['me' => '<strong>' . h($c->host) . '</strong>']) . '</li>'] : [];
    foreach (PATH_GROUPS as $group)
        if (isset($groups[$group]))
            $items[] = '<li>' . groupText($group, $groups[$group]) . "\n" . groupDetails($groups[$group]) . '</li>';
    return "<ul>\n" . implode("\n", [...$items, ...$unknown]) . "\n</ul>";
}

/** The consent screen (RFC-6 "Consent"). In same-domain mode every approval needs a fresh confirmation. */
function consentPage(array $ar, array $scopes, Ctx $ctx, ?string $error = null, int $status = 200): Response
{
    $c = $ctx->config;
    $identifyOnly = !array_filter($scopes, fn($s) => $s['kind'] !== 'identify');
    $approvedBefore = $ctx->state->clientApproved($ar['clientId']);
    // Sanitized when the metadata document was read; again here, as it comes back from the signed form.
    $name = sanitizeText($ar['clientName'] ?? null, 100);
    $app = '<strong>' . h($ar['clientHost']) . '</strong>';
    $me = '<strong>' . h($c->host) . '</strong>';
    // A request with only read scopes doesn't write anything.
    $verb = t(array_filter($scopes, fn($s) => $s['kind'] === 'write') ? 'consent.verbWrite' : 'consent.verbAccess');
    $title = t($identifyOnly ? 'title.signIn' : 'title.allow', ['app' => $ar['clientHost'], 'me' => $c->host, 'verb' => $verb]);
    $loopback = loopbackWithoutPort($ar['redirectUri']);
    $redirectOrigin = preg_match('#^[a-z]+://[^/?\#]+#', $ar['redirectUri'], $m) ? $m[0] : '';
    $logo = $ar['logo'] ? '<img src="' . h($ar['logo']) . '" alt="" width="32" height="32"> ' : '';
    $body = '<h1>' . $logo . h($ar['clientHost']) . '</h1>
<p>' . t('consent.didYouMean', ['name' => $name ? '“<bdi>' . h($name) . '</bdi>”' : $app]) . '</p>
<p>' . ($identifyOnly ? t('consent.signIn', ['app' => $app, 'me' => $me]) : t('consent.wants', ['app' => $app, 'verb' => $verb, 'me' => $me])) . '</p>
' . ($approvedBefore ? '' : '<p role="note">' . t('consent.newApp', ['app' => $app]) . '</p>') . '
' . ($loopback ? '<p role="note">' . t('consent.loopback', ['address' => '<code>' . h(substr($redirectOrigin, 7)) . '</code>']) . '</p>' : '') . '
' . alert($error) . '
<form method="post" action="' . h($c->path('/oauth/authorize')) . '">
<input type="hidden" name="request" value="' . h(sign($ar, $ctx->state->secret())) . '">
' . ($identifyOnly ? '<p>' . t('consent.learnDomain', ['app' => $app, 'me' => $me]) . "</p>\n" . '<input type="hidden" name="scope" value="identify">' : "<fieldset>
<legend>" . t('consent.mayThen', ['app' => h($ar['clientHost'])]) . "</legend>
" . permissionGroups($scopes, $c) . "
</fieldset>
<p>" . t('consent.footer', ['appsPage' => h($c->path('/pups/apps'))]) . '</p>') . '
' . ownerConfirm($ctx) . '
<p>
<button type="submit" name="decision" value="approve">' . t('consent.approve') . '</button>
<button type="submit" name="decision" value="deny" data-skip-confirm>' . t('consent.deny') . '</button>
</p>
</form>';
    return page($c, $title, $body, ['formAction' => [$redirectOrigin], 'status' => $status]);
}

/** GET /oauth/authorize: validates the request and shows the consent screen. */
function authorize(Request $req, Ctx $ctx): Response
{
    $c = $ctx->config;
    if (!$ctx->state->owner())
        return errorPage($c, 'Not set up', 'This server has no owner yet.', 503);
    $q = $req->query();
    $clientId = field($q, 'client_id', Limits::URL);
    $redirectUri = field($q, 'redirect_uri', Limits::URL);
    $state = field($q, 'state', Limits::STATE);
    $scope = field($q, 'scope', Limits::SCOPE);
    // Invalid clients and redirect URIs get an error page, never a redirect (no open redirector).
    if ($clientId === null)
        return errorPage($c, 'Invalid request', 'client_id is missing.');
    try {
        $client = $ctx->clients->load($clientId);
    } catch (ClientError $e) {
        return errorPage($c, 'Invalid app', $e->getMessage());
    }
    if ($redirectUri === null || !redirectUriAllowed($client, $redirectUri))
        return errorPage($c, 'Invalid redirect URI', "redirect_uri is not listed in the app's client metadata document.");

    $fail = function (string $error, string $description) use ($clientId, $redirectUri, $state, $c) {
        Log::event('authorize.rejected', ['clientId' => $clientId, 'error' => $error, 'description' => $description]);
        return redirectTo($redirectUri, ['error' => $error, 'error_description' => $description, 'state' => $state, 'iss' => $c->issuer]);
    };
    if (field($q, 'response_type') !== 'code')
        return $fail('unsupported_response_type', 'response_type must be code');
    $codeChallenge = field($q, 'code_challenge');
    if ($codeChallenge === null || field($q, 'code_challenge_method') !== 'S256')
        return $fail('invalid_request', 'PKCE with S256 is required');
    if (!preg_match('/^[A-Za-z0-9_-]{43}$/D', $codeChallenge))
        return $fail('invalid_request', 'Invalid code_challenge');
    $scopes = parseScopes($scope ?? '', $client['clientHost'], $c);
    if (!$scopes)
        return $fail('invalid_scope', "Only identify, the app's own directory, declared well-known paths and read scopes for declared private paths can be requested");

    Log::event('authorize.request', ['clientId' => $clientId, 'clientHost' => $client['clientHost'], 'clientName' => $client['name'],
        'redirectUri' => $redirectUri, 'scope' => $scope, 'state' => $state]);
    return consentPage([
        'clientId' => $clientId, 'clientHost' => $client['clientHost'], 'clientName' => $client['name'], 'logo' => $client['logo'],
        'redirectUri' => $redirectUri, 'state' => $state, 'codeChallenge' => $codeChallenge, 'scope' => implode(' ', array_keys($scopes)),
        'nonce' => randomToken(16), 'exp' => $ctx->now() + REQUEST_TTL,
    ], $scopes, $ctx);
}

/** POST /oauth/authorize: the owner's decision. */
function decide(Request $req, Ctx $ctx): Response
{
    $c = $ctx->config;
    $form = $req->form();
    $ar = verify(field($form, 'request', Limits::SIGNED), $ctx->state->secret(), $ctx->now());
    if (!$ar || !isset($ar['clientId'], $ar['redirectUri'], $ar['scope'], $ar['clientHost'], $ar['nonce']))
        return errorPage($c, 'Request expired', 'This authorization request is invalid or has expired. Please start again from the app.');
    $deny = function () use ($ar, $c) {
        Log::event('authorize.denied', ['clientId' => $ar['clientId'], 'requested' => $ar['scope']]);
        return redirectTo($ar['redirectUri'], ['error' => 'access_denied', 'state' => $ar['state'] ?? null, 'iss' => $c->issuer], 303);
    };
    if (field($form, 'decision') !== 'approve')
        return $deny();
    $scopes = parseScopes($ar['scope'], $ar['clientHost'], $c);
    // A group's checkbox carries all of its scopes, separated by spaces.
    $chosen = array_merge([], ...array_map(fn($v) => explode(' ', $v), fields($form, 'scope', Limits::SCOPE)));
    $granted = array_values(array_filter(array_keys($scopes ?? []), fn($k) => in_array($k, $chosen, true)));
    // Dropping every scope counts as denial.
    if (!$granted)
        return $deny();
    $err = verifyCredential($form, $ctx, 'approve app', ['clientId' => $ar['clientId']]);
    if ($err)
        return consentPage($ar, $scopes, $ctx, $err, 401);
    if (!$ctx->state->useNonce($ar['nonce'], $ar['exp']))
        return errorPage($c, 'Already answered', 'This authorization request was already approved.');
    $code = $ctx->state->createCode([
        'clientId' => $ar['clientId'], 'clientHost' => $ar['clientHost'], 'clientName' => $ar['clientName'] ?? null,
        'redirectUri' => $ar['redirectUri'], 'codeChallenge' => $ar['codeChallenge'], 'scope' => implode(' ', $granted),
    ]);
    Log::event('authorize.approved', ['clientId' => $ar['clientId'], 'requested' => $ar['scope'], 'granted' => implode(' ', $granted),
        'code' => fp($code), 'redirectUri' => $ar['redirectUri']]);
    return redirectTo($ar['redirectUri'], ['code' => $code, 'state' => $ar['state'] ?? null, 'iss' => $c->issuer], 303);
}

const NO_STORE = ['Cache-Control' => 'no-store', 'Pragma' => 'no-cache'];

function oauthError(string $error, string $description, int $status = 400): Response
{
    return json(['error' => $error, 'error_description' => $description], $status, NO_STORE)->noteError($error, $description);
}

function tokenForm(Request $req): array
{
    if ($req->method !== 'POST')
        throw methodNotAllowed('POST, OPTIONS');
    if (!$req->isForm())
        throw new HttpError(400, 'invalid_request', 'The body must be application/x-www-form-urlencoded');
    return $req->form();
}

/** POST /oauth/token: code exchange and refresh (RFC-6 "Tokens"). */
function token(Request $req, Ctx $ctx): Response
{
    $f = tokenForm($req);
    $c = $ctx->config;
    $state = $ctx->state;
    $clientId = field($f, 'client_id', Limits::URL);
    if ($clientId === null)
        return oauthError('invalid_request', 'client_id is required');
    $send = fn(array $t, string $scope) => json([
        'access_token' => $t['access'],
        'token_type' => 'Bearer',
        'expires_in' => ACCESS_TTL / 1000,
        ...($t['refresh'] !== null ? ['refresh_token' => $t['refresh']] : []),
        'scope' => $scope,
        'me' => $c->me,
    ], 200, NO_STORE);

    switch (field($f, 'grant_type')) {
        case 'authorization_code':
            $code = field($f, 'code', Limits::TOKEN);
            $redirectUri = field($f, 'redirect_uri', Limits::URL);
            $verifier = field($f, 'code_verifier', 128);
            if ($code === null || $redirectUri === null || $verifier === null)
                return oauthError('invalid_request', 'code, redirect_uri and code_verifier are required');
            if (!preg_match('/^[A-Za-z0-9\-._~]{43,128}$/D', $verifier))
                return oauthError('invalid_grant', 'Invalid code_verifier');
            $r = $state->redeemCode($code, $clientId, $redirectUri, s256($verifier));
            if (!$r['ok']) {
                Log::event('token.code-rejected', ['clientId' => $clientId, 'code' => fp($code), 'reason' => $r['description']]);
                return oauthError('invalid_grant', $r['description']);
            }
            Log::event('token.issued', ['clientId' => $clientId, 'grant' => $r['grant']['id'], 'scope' => $r['grant']['scope'], 'code' => fp($code),
                'access' => fp($r['tokens']['access']), 'refresh' => fp($r['tokens']['refresh'])]);
            return $send($r['tokens'], $r['grant']['scope']);
        case 'refresh_token':
            $refresh = field($f, 'refresh_token', Limits::TOKEN);
            if ($refresh === null)
                return oauthError('invalid_request', 'refresh_token is required');
            $requested = field($f, 'scope', Limits::SCOPE);
            $r = $state->refresh($refresh, $clientId);
            if (!$r['ok']) {
                Log::event($r['revoked'] ? 'token.refresh-reuse-grant-revoked' : 'token.refresh-rejected',
                    ['clientId' => $clientId, 'refresh' => fp($refresh), 'grant' => $r['revoked']['id'] ?? null, 'reason' => $r['reason']]);
                if ($r['revoked'])
                    onGrantRevoked($r['revoked']['clientId'], $ctx);
                return oauthError('invalid_grant', $r['revoked'] ? 'The refresh token was already used; the grant is revoked'
                    : 'Invalid, expired or revoked refresh token');
            }
            $grantScopes = explode(' ', $r['grant']['scope']);
            if ($requested !== null && array_diff(array_filter(explode(' ', $requested)), $grantScopes))
                return oauthError('invalid_scope', "The scope can't grow through a refresh");
            Log::event($r['graceRetry'] ? 'token.refreshed-grace-retry' : 'token.refreshed', ['clientId' => $clientId, 'grant' => $r['grant']['id'],
                'old' => fp($refresh), 'access' => fp($r['tokens']['access']), 'refresh' => fp($r['tokens']['refresh'])]);
            return $send($r['tokens'], $r['grant']['scope']);
        default:
            return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    }
}

/** POST /oauth/revoke (RFC 7009). */
function revoke(Request $req, Ctx $ctx): Response
{
    $f = tokenForm($req);
    $t = field($f, 'token', Limits::TOKEN);
    $clientId = field($f, 'client_id', Limits::URL);
    if ($t === null || $clientId === null)
        return oauthError('invalid_request', 'token and client_id are required');
    $revoked = $ctx->state->revokeToken($t, $clientId);
    Log::event('token.revoke', ['clientId' => $clientId, 'token' => fp($t), 'grantRevoked' => $revoked['id'] ?? false]);
    if ($revoked)
        onGrantRevoked($revoked['clientId'], $ctx);
    // Unknown tokens get 200 too.
    return new Response(200, NO_STORE);
}
