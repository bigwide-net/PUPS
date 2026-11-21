<?php

namespace Pups;

/**
 * The owner's management pages: apps (grants, host-meta.json), sign-in (passkeys and
 * password) and server (checks and log). Same-domain mode has no sessions: viewing a page
 * and every change carry a fresh passkey assertion or the password.
 */

function nav(Config $c, string $current): string
{
    $item = fn(string $p, string $label) => '<li><a href="' . h($c->path($p)) . '"' . ($p === $current ? ' aria-current="page"' : '') . ">$label</a></li>";
    return "<nav aria-label=\"Owner pages\">\n<ul>\n" . $item('/pups/apps', 'Apps') . "\n" . $item('/pups/homepage', 'Homepage') . "\n" . $item('/pups/sign-in', 'Passkeys and password')
        . "\n" . $item('/pups/server', 'Server') . "\n</ul>\n</nav>";
}

function sameDomainWarning(Config $c): string
{
    return '<p role="note">These pages share the origin of your website. Any other web application on <strong>' . h($c->host) . '</strong>,
such as a CMS, wiki or comment form, puts your login at risk, and with it every app where you sign in with your domain.
Keep PUPS on a domain or subdomain that serves only static files.</p>';
}

/** The page asking for confirmation before anything is shown. */
function unlockPage(Ctx $ctx, string $title, string $intro, string $current, ?string $error = null): Response
{
    return page($ctx->config, $title, '<h1>' . h($title) . '</h1>
<p>' . $intro . '</p>
' . alert($error) . '
<form method="post">
' . ownerConfirm($ctx) . '
<p><button type="submit" name="show" value="1">Continue</button></p>
</form>', ['nav' => nav($ctx->config, $current), 'status' => $error ? 401 : 200]);
}

/**
 * Common start of the management pages. Returns [form] after a successful confirmation, or a
 * response: the unlock page (GET or failed confirmation) or the redirect to setup.
 */
function guardOwner(Request $req, Ctx $ctx, string $title, string $intro, string $current, string $action): array|Response
{
    if (!$ctx->state->owner())
        return seeOther($ctx->config->path('/pups/setup'));
    if ($req->method === 'GET' || $req->method === 'HEAD')
        return unlockPage($ctx, $title, $intro, $current);
    if ($req->method !== 'POST')
        return errorPage($ctx->config, 'Method not allowed', 'Use GET or POST.', 405);
    $form = $req->form();
    $err = verifyCredential($form, $ctx, $action);
    // A failed confirmation shows nothing but the unlock page again.
    return $err ? unlockPage($ctx, $title, $intro, $current, $err) : [$form];
}

// --- Apps ------------------------------------------------------------------------------------

function appsEndpoint(Request $req, Ctx $ctx): Response
{
    $c = $ctx->config;
    return htmlErrors($c, function () use ($req, $ctx, $c) {
        $form = $req->isForm() ? $req->form() : [];
        $revoke = field($form, 'revoke') ?? field($form, 'revoke_delete');
        $action = $revoke !== null ? 'remove app' : (isset($form['remove_link']) ? 'remove link' : (isset($form['remove_property']) ? 'remove property' : 'view apps page'));
        $g = guardOwner($req, $ctx, 'Your apps', 'Confirm that you are the owner of <strong>' . h($c->host) . '</strong> to see the apps that can write to it.', '/pups/apps', $action);
        if ($g instanceof Response)
            return $g;
        $message = null;
        if ($revoke !== null) {
            $grant = $ctx->state->revokeGrant($revoke);
            if (!$grant)
                $message = 'The app had already been removed.';
            else {
                $deleteFiles = field($form, 'revoke_delete') !== null;
                onGrantRevoked($grant['clientId'], $ctx);
                $message = "{$grant['clientHost']} can no longer write to your domain.";
                if ($deleteFiles)
                    $message .= ' Deleted ' . $ctx->files->locked(fn() => $ctx->files->deleteDir(appdataPrefix($grant['clientHost']))) . ' of its files.';
                Log::event('grant.revoked-by-owner', ['client' => $grant['clientId'], 'grant' => $grant['id'], 'scope' => $grant['scope'], 'deleteFiles' => $deleteFiles]);
            }
        } elseif (isset($form['remove_link'])) {
            $link = json_decode(field($form, 'remove_link', Limits::SIGNED) ?? '', true);
            if (!is_array($link) || count($link) !== 2 || !array_is_list($link) || array_filter($link, fn($x) => !is_string($x)))
                return appsPage($ctx, null, 'Invalid link.');
            [$rel, $href] = $link;
            modifyHostMeta($ctx, function (object $doc) use ($rel, $href) {
                $before = count($doc->links ?? []);
                $doc->links = array_values(array_filter($doc->links ?? [], fn($l) => !(is_object($l) && ($l->rel ?? null) === $rel && ($l->href ?? '') === $href)));
                return count($doc->links) !== $before;
            }, false);
            Log::event('host-meta.link-removed-by-owner', ['rel' => $rel, 'href' => $href]);
            $message = 'The link was removed.';
        } elseif (isset($form['remove_property'])) {
            $prop = field($form, 'remove_property', 512) ?? '';
            modifyHostMeta($ctx, function (object $doc) use ($prop) {
                if (!isset($doc->properties) || !property_exists($doc->properties, $prop))
                    return false;
                unset($doc->properties->{$prop});
                return true;
            }, false);
            Log::event('host-meta.property-removed-by-owner', ['property' => $prop]);
            $message = 'The property was removed.';
        }
        return appsPage($ctx, $message);
    });
}

function grantRow(array $g, Config $c): string
{
    $name = sanitizeText($g['clientName'] ?? null, 100);
    $hasFiles = in_array('write:' . appdataPrefix($g['clientHost']), explode(' ', $g['scope']), true);
    return '<tr>
<th scope="row">' . h($g['clientHost']) . ($name ? '<br><small>“<bdi>' . h($name) . '</bdi>” (self-declared)</small>' : '') . '<br><small><code>' . h(visible($g['clientId'])) . '</code></small></th>
<td>' . permissionList($g['scope'], $g['clientHost'], $c) . '</td>
<td>' . timeHtml($g['createdAt']) . '</td>
<td>' . timeHtml($g['lastUsedAt']) . '</td>
<td>
<button type="submit" name="revoke" value="' . h($g['id']) . '">Remove</button>
' . ($hasFiles ? '<button type="submit" name="revoke_delete" value="' . h($g['id']) . '">Remove and delete its files</button>' : '') . '
</td>
</tr>';
}

function appsPage(Ctx $ctx, ?string $message = null, ?string $error = null): Response
{
    $c = $ctx->config;
    $grants = $ctx->state->activeGrants();
    $hm = currentHostMeta($ctx);
    $links = is_array($hm['doc']->links ?? null) ? array_filter($hm['doc']->links, 'is_object') : [];
    $props = isset($hm['doc']->properties) && is_object($hm['doc']->properties) ? (array) $hm['doc']->properties : [];
    $str = fn($v) => is_string($v) ? $v : json_encode($v, JSON_FLAGS);

    $appsTable = $grants ? '<table>
<thead><tr><th scope="col">App</th><th scope="col">Permissions</th><th scope="col">Approved</th><th scope="col">Last used</th><th scope="col">Actions</th></tr></thead>
<tbody>
' . implode("\n", array_map(fn($g) => grantRow($g, $c), $grants)) . '
</tbody>
</table>' : '<p>No app has access to your domain.</p>';

    $linksTable = $links ? '<table>
<caption>Links</caption>
<thead><tr><th scope="col">Relation</th><th scope="col">Target</th><th scope="col">Actions</th></tr></thead>
<tbody>
' . implode("\n", array_map(fn($l) => '<tr>
<td><code>' . h(visible($str($l->rel ?? ''))) . '</code></td>
<td><code>' . h(visible($str($l->href ?? ''))) . '</code></td>
<td><button type="submit" name="remove_link" value="' . h(json_encode([$str($l->rel ?? ''), $str($l->href ?? '')], JSON_FLAGS)) . '">Remove</button></td>
</tr>', $links)) . '
</tbody>
</table>' : '';

    $propsTable = $props ? '<table>
<caption>Properties</caption>
<thead><tr><th scope="col">Property</th><th scope="col">Value</th><th scope="col">Actions</th></tr></thead>
<tbody>
' . implode("\n", array_map(fn($k, $v) => '<tr>
<td><code>' . h(visible((string) $k)) . '</code></td>
<td>' . h(visible($str($v))) . '</td>
<td><button type="submit" name="remove_property" value="' . h((string) $k) . '">Remove</button></td>
</tr>', array_keys($props), $props)) . '
</tbody>
</table>' : '';

    $used = $ctx->files->used();
    return page($c, 'Your apps', '<h1>Apps that can write to ' . h($c->host) . '</h1>
' . status($message) . '
' . alert($error) . '
' . sameDomainWarning($c) . '
<form method="post">
' . ownerConfirm($ctx, 'Confirm changes') . '
<p><button type="submit" name="show" value="1">Reload</button></p>
<section aria-labelledby="apps-heading">
<h2 id="apps-heading">Apps</h2>
<p>Removing an app ends its access at once. The files it stored stay published, unless you delete them too.</p>
' . $appsTable . '
</section>
<section aria-labelledby="host-meta-heading">
<h2 id="host-meta-heading">Discovery file</h2>
<p>Apps can announce their files in <a href="' . h($c->origin . HOST_META_PATH) . '">host-meta.json</a>.</p>
' . alert($hm['error']) . '
' . ($hm['stored'] ? '' : '<p>The file has not been stored yet; a default that points to this server is served.</p>') . '
' . $linksTable . '
' . $propsTable . '
</section>
</form>
' . inboxSection($ctx) . '
<p>Storage used: ' . sprintf('%.1f', $used / 1048576) . ' MiB' . ($c->maxStorageBytes ? ' of ' . sprintf('%.0f', $c->maxStorageBytes / 1048576) . ' MiB' : '') . '.</p>',
        ['nav' => nav($c, '/pups/apps')]);
}

/** What the built-in receiver has put into the inbox, which the owner reads in their reader (RFC-12). */
function inboxSection(Ctx $ctx): string
{
    $c = $ctx->config;
    if (!$c->mentions && !$c->comments)
        return '';
    try {
        $items = inboxItems($ctx);
        $count = fn(array $types) => count(array_filter($items, fn($i) => in_array($i['_inbox']['type'] ?? null, $types, true)));
        $state = '<p>' . implode(', ', array_filter([
            $c->mentions ? $count(['mention', 'reply']) . ' mentions and replies' : null,
            $c->comments ? $count(['submission']) . ' comments waiting for you' : null,
        ])) . ' (at most ' . MAX_INBOX_ITEMS . ' items, ' . MAX_ITEMS_PER_HOST . ' per site).'
            . (queueLength($ctx) ? ' ' . queueLength($ctx) . ' webmentions are still being checked.' : '') . '</p>';
    } catch (ForeignInbox $e) {
        $state = alert($e->getMessage());
    }
    return '<section aria-labelledby="inbox-heading">
<h2 id="inbox-heading">Inbox</h2>
<p>This server receives ' . implode(' and ', array_filter([$c->mentions ? 'mentions of <strong>@' . h(ownerHost($c)) . '</strong>' : null,
        $c->comments ? 'comments on your feeds' : null])) . ' and puts them into your private inbox, <code>' . h(INBOX_PATH) . '</code>.
Your feed reader shows it, if it supports inboxes and you allow it to read your private data.</p>
' . $state . '
</section>';
}

// --- Passkeys and password ---------------------------------------------------------------------

function newPasswordFields(string $legend, bool $required): string
{
    $r = $required ? ' required' : '';
    $min = MIN_PASSWORD_LENGTH;
    return "<fieldset>
<legend>" . h($legend) . "</legend>
<label>New password (at least $min characters)
<input type=\"password\" name=\"new_password\" autocomplete=\"new-password\" minlength=\"$min\"$r></label>
<label>Repeat the new password
<input type=\"password\" name=\"new_password2\" autocomplete=\"new-password\" minlength=\"$min\"$r></label>
</fieldset>";
}

function signInEndpoint(Request $req, Ctx $ctx): Response
{
    $c = $ctx->config;
    return htmlErrors($c, function () use ($req, $ctx, $c) {
        $form = $req->isForm() ? $req->form() : [];
        $action = field($form, 'new_password', Limits::PASSWORD) !== null ? 'change password'
            : (field($form, 'remove_passkey') !== null ? 'remove passkey'
            : (field($form, 'passkey_registration', Limits::SIGNED) !== null ? 'add passkey' : 'view sign-in page'));
        // Checked before the confirmation, so a typo doesn't count as a failed login.
        if ($action === 'change password' && ($invalid = checkNewPassword(field($form, 'new_password', Limits::PASSWORD), field($form, 'new_password2', Limits::PASSWORD))))
            return signInPage($ctx, null, $invalid);
        $g = guardOwner($req, $ctx, 'Passkeys and password', 'Confirm that you are the owner of <strong>' . h($c->host) . '</strong> to change how you sign in.', '/pups/sign-in', $action);
        if ($g instanceof Response)
            return $g;
        $owner = $ctx->state->owner();
        if ($action === 'change password') {
            $ctx->state->setPassword(hashPassword(field($form, 'new_password', Limits::PASSWORD)));
            Log::event('owner.password-changed');
            return signInPage($ctx, $owner['passwordHash'] ? 'Your password was changed.' : 'Your password was set.');
        }
        if ($action === 'add passkey') {
            try {
                $passkey = verifyPasskeyRegistration(field($form, 'passkey_registration', Limits::SIGNED) ?? '', $c, $ctx->state);
            } catch (\RuntimeException $e) {
                return signInPage($ctx, null, "The passkey could not be registered: {$e->getMessage()}");
            }
            $ctx->state->addPasskey($passkey);
            Log::event('owner.passkey-added', ['passkey' => substr($passkey['id'], 0, 8), 'alg' => $passkey['alg']]);
            return signInPage($ctx, 'The passkey was added.');
        }
        if ($action === 'remove passkey') {
            $id = field($form, 'remove_passkey', Limits::SHORT) ?? '';
            if (count($owner['passkeys']) === 1 && !$owner['passwordHash'])
                return signInPage($ctx, null, 'This is your only way to sign in. Set a password or add another passkey first.');
            $removed = $ctx->state->removePasskey($id);
            Log::event('owner.passkey-removed', ['passkey' => substr($id, 0, 8), 'removed' => $removed]);
            return signInPage($ctx, $removed ? 'The passkey was removed.' : 'The passkey had already been removed.');
        }
        return signInPage($ctx);
    });
}

function signInPage(Ctx $ctx, ?string $message = null, ?string $error = null): Response
{
    $c = $ctx->config;
    $owner = $ctx->state->owner();
    $hasPassword = (bool) $owner['passwordHash'];
    $rows = implode("\n", array_map(fn($p) => '<tr>
<th scope="row"><code>' . h(substr($p['id'], 0, 12)) . '…</code></th>
<td>' . ['-7' => 'ES256', '-8' => 'Ed25519', '-257' => 'RS256'][(string) $p['alg']] . '</td>
<td>' . timeHtml($p['createdAt'] ?? null) . '</td>
<td>' . timeHtml($p['lastUsedAt'] ?? null) . '</td>
<td><button type="submit" name="remove_passkey" value="' . h($p['id']) . '">Remove</button></td>
</tr>', $owner['passkeys']));
    $confirm = fn(bool $first) => ownerConfirm($ctx, 'Confirm that it is you', $hasPassword ? 'Current password' : 'Password', $first);
    return page($c, 'Passkeys and password', '<h1>Passkeys and password</h1>
' . status($message) . '
' . alert($error) . '
<p>Passkeys are preferred: an abused passkey prompt works once, a stolen password until you change it.</p>
<form method="post">
<section aria-labelledby="passkeys-heading">
<h2 id="passkeys-heading">Passkeys</h2>
' . ($rows ? '<table>
<thead><tr><th scope="col">Passkey</th><th scope="col">Type</th><th scope="col">Added</th><th scope="col">Last used</th><th scope="col">Actions</th></tr></thead>
<tbody>
' . $rows . '
</tbody>
</table>' : '<p>You have no passkey.</p>') . '
<input type="hidden" name="passkey_registration" value="">
<p><button type="button" data-passkey-create>Add a passkey</button></p>
' . jsonScript('passkey-create-options', passkeyCreateOptions($c, $ctx->state, $owner['passkeys'])) . '
</section>
' . $confirm(true) . '
</form>
<form method="post">
<section aria-labelledby="password-heading">
<h2 id="password-heading">' . ($hasPassword ? 'Change your password' : 'Set a password') . '</h2>
' . ($hasPassword ? '' : '<p>You sign in with a passkey. A password is a fallback for devices without it.</p>') . '
' . newPasswordFields('New password', true) . '
' . $confirm(false) . '
<p><button type="submit">' . ($hasPassword ? 'Change password' : 'Set password') . '</button></p>
</section>
</form>', ['nav' => nav($c, '/pups/sign-in'), 'status' => $error ? 400 : 200]);
}
