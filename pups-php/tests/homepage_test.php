<?php
// The homepage: / forwards to the owner pages at /pups/, or serves webpup, which the owner
// installs, changes and removes at /pups/homepage.

namespace Pups\Test;

function homepage(T $t, array $form): Res
{
    return $t->post('/pups/homepage', $form + ['password' => PASSWORD]);
}

test('homepage: / forwards to the owner pages at /pups/ while the domain has none', function () {
    $t = new T();
    $res = $t->get('/');
    eq([$res->status, $res->header('location')], [303, '/pups/']);
    $start = $t->get('/pups/');
    eq([$start->status, $start->header('access-control-allow-origin')], [200, null]);
    contains($start->text, 'Your domain has no homepage yet');
    contains($start->text, '<a href="/pups/homepage">Install webpup</a>');
    contains($t->get('/pups/apps')->text, '<a href="/pups/homepage">Homepage</a>');
    eq($t->get('/p/about')->status, 404, 'no webpup URLs without webpup');
    eq($t->get('/webpup-config.json')->status, 404);
});

test('homepage: the page needs the owner, and lists the themes with their thumbnails', function () {
    $t = new T();
    $locked = $t->get('/pups/homepage');
    notContains($locked->text, 'name="theme"');
    eq(homepage($t, ['password' => 'wrong'])->status, 401);
    $page = homepage($t, ['show' => '1'])->text;
    contains($page, '<input type="radio" name="theme" value="default" checked>');
    contains($page, '<input type="radio" name="theme" value="night">');
    contains($page, '<img src="/pups/assets/themes/night.jpg"');
    contains($page, '<input type="checkbox" name="theme_selector" value="1">');
    contains($page, 'Install webpup');
    notContains($page, 'Remove webpup');
    $jpg = $t->get('/pups/assets/themes/night.jpg');
    eq([$jpg->status, $jpg->header('content-type')], [200, 'image/jpeg']);
    eq($t->get('/pups/assets/themes/..%2Fnight.jpg')->status, 404);
});

test('homepage: install webpup with a theme and the theme browser, change it, remove it', function () {
    $t = new T();
    $site = $t->config->siteDir;
    $page = homepage($t, ['webpup' => 'install', 'theme' => 'night', 'theme_selector' => '1']);
    contains($page->text, 'webpup is now the homepage of alice.pups.test.');
    // The files are at the domain root, and the theme is the chosen one.
    eq(file_get_contents("$site/webpups.js"), file_get_contents(\Pups\webpupSource() . '/webpups.js'));
    contains(file_get_contents("$site/theme.css"), '/* webpup theme: night.');
    ok(is_file("$site/webpup-themes/index.json") && is_file("$site/webpup-themes/paper.css"), 'themes for the theme browser');

    $home = $t->get('/');
    eq([$home->status, $home->header('content-type'), $home->header('content-security-policy')], [200, 'text/html; charset=utf-8', null]);
    contains($home->text, \Pups\WEBPUP_GENERATOR);
    eq($t->get('/p/feed/photos/archive/3')->text, $home->text, 'pretty URLs serve index.html');
    eq($t->get('/index.html')->text, $home->text);
    eq($t->get('/webpups.js')->header('content-type'), 'text/javascript; charset=utf-8');
    eq($t->get('/webpup-themes/paper.css')->status, 200);
    eq($t->get('/webpup-config.json')->json(), ['theme-selector' => true, 'settings-url' => '/pups/homepage', 'owner-link' => '/pups/']);
    $etag = $home->header('etag');
    eq($t->get('/', ['if-none-match' => $etag])->status, 304);

    // The settings page shows what is installed.
    $page = homepage($t, ['show' => '1'])->text;
    contains($page, '<input type="radio" name="theme" value="night" checked>');
    contains($page, '<input type="checkbox" name="theme_selector" value="1" checked>');
    contains($page, 'Remove webpup');
    contains($t->get('/pups/')->text, 'Your homepage is <a href="/">webpup</a>');

    // The default look, without the theme browser; settings the owner added to the config stay.
    file_put_contents("$site/webpup-config.json", '{"theme-selector": true, "embeds": "consent"}');
    contains(homepage($t, ['webpup' => 'install', 'theme' => 'default'])->text, 'Saved.');
    ok(!file_exists("$site/webpup-themes"), 'no themes without the theme browser');
    eq(trim(preg_replace('#/\*.*?\*/#s', '', file_get_contents("$site/theme.css"))), '', 'no rules: webpup’s own look');
    eq($t->get('/webpup-config.json')->json(), ['theme-selector' => false, 'embeds' => 'consent', 'settings-url' => '/pups/homepage', 'owner-link' => '/pups/']);
    eq($t->get('/webpup-themes/paper.css')->status, 404);

    eq(homepage($t, ['webpup' => 'install', 'theme' => '../config'])->status, 400, 'only listed themes');
    contains(homepage($t, ['webpup' => 'remove'])->text, 'webpup was removed.');
    eq(array_values(array_diff(scandir($site), ['.', '..'])), [], 'all its files are gone');
    eq($t->get('/')->status, 303);
});

test('homepage: keeps a theme.css of the owner, and disables the owner link in config.php', function () {
    $t = new T(['webpup_owner_link' => false]);
    $site = $t->config->siteDir;
    homepage($t, ['webpup' => 'install', 'theme' => 'paper']);
    file_put_contents("$site/theme.css", 'body { color: red; }');
    $page = homepage($t, ['show' => '1'])->text;
    contains($page, '<input type="radio" name="theme" value="custom" checked>');
    homepage($t, ['webpup' => 'install', 'theme' => 'custom']);
    eq(file_get_contents("$site/theme.css"), 'body { color: red; }');
    eq($t->get('/webpup-config.json')->json(), ['theme-selector' => false, 'settings-url' => '/pups/homepage']);
});

test('homepage: an index.html of the owner is served at /, and never replaced', function () {
    $t = new T();
    $site = $t->config->siteDir;
    file_put_contents("$site/index.html", '<h1>My site</h1>');
    eq($t->get('/')->text, '<h1>My site</h1>');
    eq($t->get('/p/about')->status, 404, 'pretty URLs are webpup’s');
    contains($t->get('/pups/')->text, 'Your homepage is your own');
    $page = homepage($t, ['webpup' => 'install', 'theme' => 'night'])->text;
    contains($page, 'remove or rename that file first');
    eq(file_get_contents("$site/index.html"), '<h1>My site</h1>');
    ok(!file_exists("$site/webpups.js"), 'nothing installed');
});

test('homepage: not in a folder installation, where / forwards to the owner pages of the folder', function () {
    $t = new T(['base_path' => '/pups']);
    eq($t->get('/pups')->header('location'), '/pups/pups/');
    contains($t->get('/pups/pups/')->text, 'Your apps');
    notContains($t->get('/pups/pups/')->text, 'Install webpup');
    $page = $t->post('/pups/pups/homepage', ['webpup' => 'install', 'theme' => 'night', 'password' => PASSWORD])->text;
    contains($page, 'webpup needs PUPS at the domain root');
    eq(array_values(array_diff(scandir($t->config->siteDir), ['.', '..'])), []);
});

test('homepage: offered at the end of the setup', function () {
    $t = new T([], false);
    $res = $t->post('/pups/setup', ['step' => 'secret', 'secret' => SETUP_SECRET]);
    $res = $t->post('/pups/setup', ['setup' => hidden($res->text, 'setup'), 'new_password' => PASSWORD, 'new_password2' => PASSWORD]);
    contains($res->text, '<h2>Your homepage</h2>');
    contains($res->text, '<a href="/pups/homepage">Install webpup</a>');
});

test('homepage: webpup declares its post URLs in host-meta.json, which apps can’t change', function () {
    $t = new T();
    $prop = 'https://bigwide.net/ns/post-url-template';
    ok(!isset($t->get('/.well-known/host-meta.json')->json()['properties'][$prop]), 'not without webpup');
    contains(homepage($t, ['webpup' => 'install', 'theme' => 'default'])->text, '<code>' . ORIGIN . '/p/{feed}/post/{index}</code>');
    $doc = $t->get('/.well-known/host-meta.json')->json();
    eq($doc['properties'][$prop], ORIGIN . '/p/{feed}/post/{index}');
    eq($doc['links'][0]['href'], ORIGIN . '/personal-storage.json', 'the PUPS link stays');
    // The template's URLs are webpup's post pages.
    contains($t->get('/p/feed/post/12')->text, \Pups\WEBPUP_GENERATOR);
    contains($t->get('/p/feed/photos/post/0')->text, \Pups\WEBPUP_GENERATOR);

    $c = $t->registerClient('app.example');
    $tok = $t->connect($c, 'write:/feed.json write:/feed/ write:/.well-known/about.md')['access_token'];
    eq($t->hostMeta($tok, ['action' => 'set-property', 'property' => $prop, 'value' => 'https://evil.example/{index}'])->status, 403);

    homepage($t, ['webpup' => 'remove']);
    ok(!isset($t->get('/.well-known/host-meta.json')->json()['properties'][$prop]), 'removed with webpup');
});

test('homepage: removing webpup keeps a post URL template the owner set', function () {
    $t = new T();
    homepage($t, ['webpup' => 'install', 'theme' => 'default']);
    $prop = 'https://bigwide.net/ns/post-url-template';
    $doc = $t->get('/.well-known/host-meta.json')->json();
    $doc['properties'][$prop] = 'https://blog.example/{feed}/{index}.html';
    file_put_contents($t->config->dataDir . '/files/.well-known/host-meta.json', json_encode($doc, JSON_UNESCAPED_SLASHES));
    homepage($t, ['webpup' => 'remove']);
    eq($t->get('/.well-known/host-meta.json')->json()['properties'][$prop], 'https://blog.example/{feed}/{index}.html');
});

test('homepage: index.html links the Markdown file of the URL, for Markdown browsers like bonBon', function () {
    $t = new T();
    homepage($t, ['webpup' => 'install', 'theme' => 'default']);
    $twin = fn(string $url) => preg_match('#<link rel="alternate" type="text/markdown" href="([^"]*)">#', $t->get($url)->text, $m) ? html_entity_decode($m[1]) : null;
    eq($twin('/'), null, 'no home page: the feed');
    eq($twin('/p/md/docs/%C3%9Cber%20uns.md'), ORIGIN . '/docs/%C3%9Cber%20uns.md');
    eq($twin('/index.html?show=md&path=/docs/intro.md'), ORIGIN . '/docs/intro.md');
    foreach (['/p/md/docs/x.html', '/p/md//evil.example/x.md', '/index.html?show=md&path=x.md', '/p/about', '/index.html?show=about'] as $url)
        eq($twin($url), null, $url);

    // The page marked as the home page in host-meta.json...
    $pages = 'https://bigwide.net/ns/webpup-pages';
    $mark = 'https://bigwide.net/ns/webpup-homepage';
    $doc = $t->get('/.well-known/host-meta.json')->json();
    $doc['links'][] = ['rel' => $pages, 'href' => ORIGIN . '/pups/pages/now.md'];
    $doc['links'][] = ['rel' => $pages, 'href' => ORIGIN . '/pups/pages/welcome.md', 'properties' => [$mark => 'true']];
    file_put_contents($t->config->dataDir . '/files/.well-known/host-meta.json', json_encode($doc, JSON_UNESCAPED_SLASHES));
    eq($twin('/'), ORIGIN . '/pups/pages/welcome.md');
    eq($twin('/index.html'), ORIGIN . '/pups/pages/welcome.md');
    eq($twin('/?show=about'), null);
    // ...unless webpup-config.json names another.
    $config = $t->config->siteDir . '/webpup-config.json';
    file_put_contents($config, json_encode(json_decode(file_get_contents($config), true) + ['homepage' => '/index.md']));
    eq($twin('/'), ORIGIN . '/index.md');
    eq($t->get('/webpup-config.json')->json()['homepage'], '/index.md');
    ok($t->get('/')->header('etag') !== $t->get('/p/md/a.md')->header('etag'), 'each its own ETag');
});
