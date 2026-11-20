<?php

namespace Pups;

/**
 * HTML of the owner pages: plain semantic markup without classes or inline styles. The look
 * comes from assets/owner.css, the passkey ceremonies from assets/owner.js (see the comment
 * in owner.css for the structure). Every value written into a page goes through h(); values
 * from untrusted sources are sanitized first (sanitize.php).
 */

/** Encodes text for HTML element content and double-quoted attributes. Invalid UTF-8 becomes U+FFFD. */
function h(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
}

/**
 * A text from texts.json, shared with the TypeScript implementations (a copy from pups-ui, see
 * scripts/sync-ui.sh), with its {placeholders} replaced. The values are inserted as they are:
 * escaped HTML for HTML texts, plain text for title.* texts.
 */
function t(string $key, array $vars = []): string
{
    static $texts = null;
    $texts ??= json_decode(file_get_contents(__DIR__ . '/texts.json'), true, 4, JSON_THROW_ON_ERROR);
    return preg_replace_callback('/\{(\w+)\}/', fn($m) => $vars[$m[1]] ?? $m[0], $texts[$key]);
}

/**
 * An owner page. Owner pages can't be framed, run only owner.js, and set no cookie.
 * Options: `nav` (the navigation of the management pages), `formAction` (origins a form may
 * submit to; the consent form redirects to the app), `status`.
 */
function page(Config $c, string $title, string $body, array $opts = []): Response
{
    // Only plain origins may enter the CSP header, so no value can add a directive.
    $formAction = implode(' ', array_merge(["'self'"], array_filter($opts['formAction'] ?? [], fn($o) => isCspOrigin($o))));
    $assets = h($c->path('/pups/assets'));
    $nav = $opts['nav'] ?? '';
    return new Response($opts['status'] ?? 200, [
        'Content-Type' => 'text/html; charset=utf-8',
        'Cache-Control' => 'no-store',
        'X-Frame-Options' => 'DENY',
        'X-Content-Type-Options' => 'nosniff',
        'Referrer-Policy' => 'no-referrer',
        'Content-Security-Policy' => "default-src 'none'; script-src 'self'; style-src 'self'; img-src https: data:; "
            . "form-action $formAction; frame-ancestors 'none'; base-uri 'none'",
    ], '<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>' . h($title) . '</title>
<link rel="stylesheet" href="' . $assets . '/owner.css?v=' . assetVersion('owner.css') . '">
</head>
<body>
<header>
<p>Personal Upload Server for <strong>' . h($c->host) . '</strong></p>
' . $nav . '
</header>
<main>
' . $body . '
</main>
<script src="' . $assets . '/owner.js?v=' . assetVersion('owner.js') . '" defer></script>
</body>
</html>
');
}

function alert(?string $message): string
{
    return $message ? '<p role="alert">' . h(visible($message)) . '</p>' : '';
}

function status(?string $message): string
{
    return $message ? '<p role="status">' . h(visible($message)) . '</p>' : '';
}

function errorPage(Config $c, string $title, string $message, int $code = 400): Response
{
    return page($c, $title, '<h1>' . h($title) . "</h1>\n" . alert($message), ['status' => $code])->noteError($title, $message);
}

/** Embeds JSON for owner.js. */
function jsonScript(string $id, mixed $value): string
{
    return '<script type="application/json" id="' . h($id) . '">' . json_encode($value, JSON_FLAGS | JSON_HEX_TAG | JSON_HEX_AMP) . '</script>';
}

/**
 * The fieldset in which the owner confirms an action with a passkey or the password. With a
 * passkey, owner.js asks for it when the form is submitted with an empty password field.
 */
function confirmFields(?array $passkeyOptions, bool $hasPassword, ?string $legend = null, ?string $passwordLabel = null, bool $withOptions = true): string
{
    $hint = t($passkeyOptions && $hasPassword ? 'confirm.passkeyOrPassword' : ($passkeyOptions ? 'confirm.passkey' : 'confirm.password'));
    return '<fieldset data-confirm>
<legend>' . ($legend === null ? t('confirm.legend') : h($legend)) . '</legend>
<p>' . $hint . '</p>
<input type="hidden" name="passkey" value="">
' . ($hasPassword ? '<label>' . ($passwordLabel === null ? t('confirm.passwordLabel') : h($passwordLabel)) . ' <input type="password" name="password" autocomplete="current-password"></label>' : '') . '
' . ($passkeyOptions && $withOptions ? jsonScript('passkey-get-options', $passkeyOptions) : '') . '
</fieldset>';
}

/**
 * confirmFields() for the owner of this installation. A page with two forms passes
 * `withOptions` false for the second: owner.js finds the passkey options by their ID.
 */
function ownerConfirm(Ctx $ctx, ?string $legend = null, ?string $passwordLabel = null, bool $withOptions = true): string
{
    $options = passkeyGetOptions($ctx->config, $ctx->state, !$withOptions);
    return confirmFields($options, (bool) ($ctx->state->owner()['passwordHash'] ?? null), $legend, $passwordLabel, $withOptions);
}

/** A timestamp (ms) for tables. */
function timeHtml(?int $ms): string
{
    if (!$ms)
        return 'never';
    $t = intdiv($ms, 1000);
    return '<time datetime="' . gmdate('Y-m-d\TH:i:s\Z', $t) . '">' . gmdate('Y-m-d H:i', $t) . ' UTC</time>';
}

/** Runs an owner-page handler; request errors (e.g. oversized values) become an HTML error page instead of JSON. */
function htmlErrors(Config $c, callable $handler): Response
{
    try {
        return $handler();
    } catch (HttpError $e) {
        return errorPage($c, 'Invalid request', $e->getMessage(), $e->status);
    }
}

/** A 303 redirect to one of the server's own pages. */
function seeOther(string $location): Response
{
    return new Response(303, ['Location' => $location, 'Cache-Control' => 'no-store']);
}

/** Changes with the asset's content, so that browsers fetch it again after an update. */
function assetVersion(string $name): string
{
    return substr(hash_file('sha256', dirname(__DIR__) . "/assets/$name"), 0, 12);
}
