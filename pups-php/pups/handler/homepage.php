<?php
/**
 * The homepage of the domain: webpup (the single-page website of a PUPS domain), installed by the
 * owner at /pups/homepage from the copy in webpup/ (scripts/sync-webpup.sh), and served at / and
 * /p/*. Without a homepage, / forwards to the owner pages at /pups/. Only for installations at
 * the domain root: webpup loads its files and the feeds from there.
 */

namespace Pups;

/** The line webpup's index.html carries; it tells webpup's index.html from the owner's own. */
const WEBPUP_GENERATOR = '<meta name="generator" content="webpup">';
/** The site property that tells apps the URL of a post's page (RFC-6 "Site properties", RFC-7 items). */
const POST_URL_TEMPLATE_PROP = 'https://bigwide.net/ns/post-url-template';
/** webpup's files besides index.html, the themes and the config, served as they are. */
const WEBPUP_ASSETS = ['/webpups.js' => 'text/javascript', '/webpup.css' => 'text/css', '/theme.css' => 'text/css'];

/** The copy of webpup that comes with PUPS. */
function webpupSource(): string
{
    return dirname(__DIR__) . '/webpup';
}

/** What the domain root has: 'webpup', 'own' (another index.html), or null (nothing, or a folder installation). */
function homepageKind(Config $c): ?string
{
    if ($c->basePath !== '' || $c->siteDir === null)
        return null;
    $index = @file_get_contents("$c->siteDir/index.html");
    return $index === false ? null : (str_contains($index, WEBPUP_GENERATOR) ? 'webpup' : 'own');
}

/** The themes that come with webpup: [id => [title, description]]. */
function webpupThemes(): array
{
    $list = json_decode(@file_get_contents(webpupSource() . '/webpup-themes/index.json') ?: '{}', true)['themes'] ?? [];
    $out = [];
    foreach (is_array($list) ? $list : [] as $t)
        if (is_string($t['id'] ?? null) && preg_match('/^[a-z0-9-]+$/D', $t['id']) && is_string($t['title'] ?? null))
            $out[$t['id']] = [$t['title'], is_string($t['description'] ?? null) ? $t['description'] : ''];
    return $out;
}

/** The first line of a theme.css written by PUPS, which names the theme. */
function themeMarker(Config $c, string $id): string
{
    return "/* webpup theme: $id. Installed by PUPS; choose another one at " . $c->base . "/pups/homepage */\n";
}

/** The installed theme: a theme's id, 'default', or 'custom' (a theme.css that PUPS didn't write). */
function installedTheme(Config $c): string
{
    $css = @file_get_contents("$c->siteDir/theme.css");
    if ($css === false || trim($css) === '')
        return 'default';
    return preg_match('#^/\* webpup theme: ([a-z0-9-]+)\.#', $css, $m) ? $m[1] : 'custom';
}

/** webpup-config.json as installed, without the keys PUPS adds when it serves the file. */
function installedWebpupConfig(Config $c): array
{
    $config = json_decode(@file_get_contents("$c->siteDir/webpup-config.json") ?: '{}', true);
    unset($config['owner-link'], $config['settings-url']);
    return is_array($config) && !array_is_list($config) ? $config : [];
}

function writeSiteFile(string $path, string $data): void
{
    $tmp = "$path.pups-tmp";
    if (file_put_contents($tmp, $data) === false || !rename($tmp, $path))
        throw new \RuntimeException("Could not write $path");
}

function removeTree(string $dir): void
{
    foreach (glob("$dir/*") ?: [] as $f)
        is_dir($f) ? removeTree($f) : unlink($f);
    @rmdir($dir);
}

/** Copies webpup to the domain root, with the theme ('custom' keeps theme.css) and the theme selector on or off. */
function installWebpup(Config $c, string $theme, bool $themeSelector): void
{
    $src = webpupSource();
    $dst = $c->siteDir;
    if (!is_dir($dst) && !@mkdir($dst, 0755, true))
        throw new \RuntimeException("Could not create $dst");
    foreach (array_keys(WEBPUP_ASSETS) as $f)
        if ($f !== '/theme.css')
            writeSiteFile("$dst$f", file_get_contents("$src$f"));
    if ($theme !== 'custom')
        writeSiteFile("$dst/theme.css", themeMarker($c, $theme) . ($theme === 'default' ? '' : file_get_contents("$src/webpup-themes/$theme.css")));
    // The theme selector loads the themes from /webpup-themes/; without it, they aren't needed.
    removeTree("$dst/webpup-themes");
    if ($themeSelector) {
        mkdir("$dst/webpup-themes", 0755);
        foreach (glob("$src/webpup-themes/*") ?: [] as $f)
            copy($f, "$dst/webpup-themes/" . basename($f));
    }
    writeSiteFile("$dst/webpup-config.json", json_encode(['theme-selector' => $themeSelector] + installedWebpupConfig($c), JSON_FLAGS | JSON_PRETTY_PRINT) . "\n");
    // Last, so that the page appears only when its files are there.
    writeSiteFile("$dst/index.html", file_get_contents("$src/index.html"));
}

/** webpup's post pages: /p/feed/post/12, /p/feed/photos/post/12. */
function webpupPostUrlTemplate(Config $c): string
{
    return "$c->origin/p/{feed}/post/{index}";
}

/**
 * Sets the post URL template in host-meta.json to webpup's (`$on`), or removes it if it is still
 * webpup's. Apps that write the feeds then give new posts the URL of their page (RFC-7).
 */
function setPostUrlTemplate(Ctx $ctx, bool $on): void
{
    $template = webpupPostUrlTemplate($ctx->config);
    modifyHostMeta($ctx, function (object $doc) use ($on, $template) {
        if (!isset($doc->properties) || !is_object($doc->properties))
            $doc->properties = new \stdClass();
        $current = $doc->properties->{POST_URL_TEMPLATE_PROP} ?? null;
        if ($on === ($current === $template))
            return false;
        if ($on)
            $doc->properties->{POST_URL_TEMPLATE_PROP} = $template;
        else
            unset($doc->properties->{POST_URL_TEMPLATE_PROP});
        return true;
    }, $on);
}

function removeWebpup(Config $c): void
{
    $dst = $c->siteDir;
    foreach (['/index.html', ...array_keys(WEBPUP_ASSETS), '/webpup-config.json'] as $f)
        @unlink("$dst$f");
    removeTree("$dst/webpup-themes");
}

/** A file of the domain root, revalidated on every use (webpup's files have fixed names). */
function siteFile(Request $req, string $path, string $type, ?string $body = null): Response
{
    $body ??= file_get_contents($path);
    $etag = '"' . substr(sha1($body), 0, 16) . '"';
    $headers = ['Content-Type' => "$type; charset=utf-8", 'Cache-Control' => 'no-cache', 'ETag' => $etag, 'X-Content-Type-Options' => 'nosniff'];
    return $req->header('if-none-match') === $etag ? new Response(304, $headers) : new Response(200, $headers, $body);
}

/**
 * GET / and webpup's URLs. / serves the domain's index.html (webpup's, or the owner's own), else
 * forwards to the owner pages. The rest only exists while webpup is installed: index.html for
 * /p/* (webpup's pretty URLs), its files, and webpup-config.json with the links PUPS adds.
 * Apache serves webpup's files directly when they exist (.htaccess); this is for other servers.
 */
function homepageRoute(Request $req, string $rel, Ctx $ctx): ?Response
{
    $c = $ctx->config;
    if ($rel === '/') {
        $kind = homepageKind($c);
        return $kind ? siteFile($req, "$c->siteDir/index.html", 'text/html') : seeOther($c->path('/pups/'));
    }
    $theme = preg_match('#^/webpup-themes/([a-z0-9-]+\.(css|jpg)|index\.json)$#D', $rel, $m);
    if (!($rel === '/index.html' || str_starts_with($rel, '/p/') || isset(WEBPUP_ASSETS[$rel]) || $rel === '/webpup-config.json' || $theme)
        || homepageKind($c) !== 'webpup')
        return null;
    if ($rel === '/webpup-config.json') {
        $links = ['settings-url' => $c->path('/pups/homepage')] + ($c->webpupOwnerLink ? ['owner-link' => $c->path('/pups/')] : []);
        return siteFile($req, '', 'application/json', json_encode(installedWebpupConfig($c) + $links, JSON_FLAGS | JSON_PRETTY_PRINT) . "\n");
    }
    if ($theme) {
        $path = "$c->siteDir$rel";
        $type = str_ends_with($rel, '.jpg') ? 'image/jpeg' : (str_ends_with($rel, '.css') ? 'text/css' : 'application/json');
        return is_file($path) ? siteFile($req, $path, $type) : null;
    }
    if (isset(WEBPUP_ASSETS[$rel]))
        return is_file("$c->siteDir$rel") ? siteFile($req, "$c->siteDir$rel", WEBPUP_ASSETS[$rel]) : null;
    return siteFile($req, "$c->siteDir/index.html", 'text/html');
}

/** /pups/assets/themes/<id>.jpg: the theme thumbnails for the homepage page. */
function themeThumbnail(string $name): ?Response
{
    $path = webpupSource() . "/webpup-themes/$name.jpg";
    return preg_match('/^[a-z0-9-]+$/D', $name) && is_file($path)
        ? new Response(200, ['Content-Type' => 'image/jpeg', 'Cache-Control' => 'public, max-age=86400', 'X-Content-Type-Options' => 'nosniff'], file_get_contents($path))
        : null;
}

/** A line about the homepage, for the start page and the end of the setup. */
function homepageSummary(Config $c): string
{
    $settings = h($c->path('/pups/homepage'));
    return match ($c->basePath !== '' ? 'folder' : homepageKind($c)) {
        'folder' => '',
        'webpup' => "<p>Your homepage is <a href=\"/\">webpup</a>. <a href=\"$settings\">Change its theme, or remove it</a>.</p>",
        'own' => '<p>Your homepage is your own <a href="/"><code>index.html</code></a>.</p>',
        default => '<p>Your domain has no homepage yet: <a href="/">' . h($c->host) . "</a> forwards to these pages. <a href=\"$settings\">Install webpup</a>,
a homepage that shows your profile, posts and pages from the files your apps write.</p>",
    };
}

// --- /pups/homepage ---------------------------------------------------------------------------

function homepageEndpoint(Request $req, Ctx $ctx): Response
{
    $c = $ctx->config;
    return htmlErrors($c, function () use ($req, $ctx, $c) {
        $form = $req->isForm() ? $req->form() : [];
        $do = field($form, 'webpup');
        $g = guardOwner($req, $ctx, 'Homepage', 'Confirm that you are the owner of <strong>' . h($c->host) . '</strong> to change the homepage of your domain.',
            '/pups/homepage', $do === 'install' ? 'install webpup' : ($do === 'remove' ? 'remove webpup' : 'view homepage page'));
        if ($g instanceof Response)
            return $g;
        $kind = homepageKind($c);
        if ($do === null || $c->basePath !== '' || $kind === 'own')
            return homepagePage($ctx);
        if ($do === 'remove') {
            if ($kind === 'webpup')
                removeWebpup($c);
            setPostUrlTemplate($ctx, false);
            Log::event('webpup.removed');
            return homepagePage($ctx, "webpup was removed. $c->host now forwards to these pages.");
        }
        $theme = field($form, 'theme') ?? '';
        if ($do !== 'install' || !(isset(webpupThemes()[$theme]) || $theme === 'default' || $theme === 'custom' && $kind === 'webpup' && installedTheme($c) === 'custom'))
            return homepagePage($ctx, null, 'Choose a theme.');
        $selector = field($form, 'theme_selector') === '1';
        installWebpup($c, $theme, $selector);
        setPostUrlTemplate($ctx, true);
        Log::event('webpup.installed', ['theme' => $theme, 'themeSelector' => $selector]);
        return homepagePage($ctx, $kind === 'webpup' ? 'Saved.' : "webpup is now the homepage of $c->host.");
    });
}

function homepagePage(Ctx $ctx, ?string $message = null, ?string $error = null): Response
{
    $c = $ctx->config;
    $kind = homepageKind($c);
    $intro = '<p>webpup is a homepage for your domain. It shows your profile, your posts and your pages: the files your apps write
through PUPS, like your feeds, <code>about.md</code> and <code>contact.vcf</code>. It runs in your visitors’ browsers, and changes
when your apps change these files.</p>';
    $opts = ['nav' => nav($c, '/pups/homepage'), 'status' => $error ? 400 : 200];
    if ($c->basePath !== '')
        return page($c, 'Homepage', "<h1>Homepage</h1>\n$intro\n<p role=\"note\">webpup needs PUPS at the domain root, and this one is installed in "
            . '<code>' . h($c->basePath) . '/</code>.</p>', $opts);
    if ($kind === 'own')
        return page($c, 'Homepage', "<h1>Homepage</h1>\n" . status($message) . "\n$intro\n<p>Your domain already has its own homepage, <code>"
            . h("$c->siteDir/index.html") . '</code>. To use webpup instead, remove or rename that file first.</p>', $opts);

    $installed = $kind === 'webpup';
    $current = $installed ? installedTheme($c) : 'default';
    $selector = $installed && (installedWebpupConfig($c)['theme-selector'] ?? false) === true;
    $outdated = $installed && @file_get_contents("$c->siteDir/webpups.js") !== file_get_contents(webpupSource() . '/webpups.js');
    $themes = ['default' => ['Default', 'webpup’s own look, light or dark like the visitor’s system']] + webpupThemes();
    $radio = fn(string $id, string $title, string $description, bool $image = true) => '<label><input type="radio" name="theme" value="' . h($id) . '"'
        . ($id === $current ? ' checked' : '') . '> ' . ($image ? '<img src="' . h($c->path("/pups/assets/themes/$id.jpg")) . '" alt="" width="100" height="70"> ' : '')
        . '<span><strong>' . h($title) . '</strong><br><small>' . h($description) . '</small></span></label>';
    $choices = array_map(fn($id, $t) => $radio($id, $t[0], $t[1]), array_keys($themes), $themes);
    if ($current === 'custom')
        array_unshift($choices, $radio('custom', 'Your own theme.css', 'Keep the theme.css next to index.html as it is', false));
    return page($c, 'Homepage', '<h1>Homepage</h1>
' . status($message) . alert($error) . "\n$intro\n"
        . ($installed ? '<p>webpup is the homepage of <a href="/">' . h($c->host) . '</a>. Every post has a page of its own on it, and apps that
write your feeds link new posts to it: <code>host-meta.json</code> tells them the address, <code>' . h(webpupPostUrlTemplate($c)) . '</code>.</p>'
            : '<p>Your domain has no homepage yet: <a href="/">' . h($c->host) . '</a> forwards to these pages.</p>')
        . ($outdated ? "\n<p role=\"note\">This version of PUPS comes with another version of webpup. Save to install it.</p>" : '') . '
<form method="post">
<fieldset>
<legend>Theme</legend>
' . implode("\n", $choices) . '
</fieldset>
<fieldset>
<legend>Theme browser</legend>
<label><input type="checkbox" name="theme_selector" value="1"' . ($selector ? ' checked' : '') . '> <span>Show all themes at the bottom of the page,
so that you and your visitors can try them</span></label>
</fieldset>
' . ownerConfirm($ctx) . '
<p><button type="submit" name="webpup" value="install">' . ($installed ? 'Save' : 'Install webpup') . '</button>'
        . ($installed ? ' <button type="submit" name="webpup" value="remove">Remove webpup</button>' : '') . '</p>
</form>', $opts);
}
