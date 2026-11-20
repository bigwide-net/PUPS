<?php
// A folder installation, and the real request/response path on PHP's built-in server.

namespace Pups\Test;

test('folder installation: endpoints under the base path, discovery and well-known files at the domain root', function () {
    $t = new T(['base_path' => '/pups']);
    $doc = $t->get('/.well-known/host-meta.json')->json();
    eq($doc['links'][0]['href'], ORIGIN . '/pups/personal-storage.json');
    $cfg = $t->get('/pups/personal-storage.json')->json();
    eq([$cfg['issuer'], $cfg['authorization_endpoint'], $cfg['storage_base'], $cfg['host_meta_endpoint']],
        [ORIGIN, ORIGIN . '/pups/oauth/authorize', ORIGIN . '/pups/', ORIGIN . '/pups/pups/host-meta']);
    eq($t->get('/personal-storage.json')->status, 404, 'outside the base');
    eq($t->get('/.well-known/oauth-authorization-server')->json()['issuer'], ORIGIN);
    // Only /.well-known/ reaches PUPS at the domain root: no feeds, and the profile images and pages stay at storage_base.
    eq(array_column($cfg['well_known_paths'], 'path'), ['/.well-known/following.opml', '/.well-known/about.md', '/.well-known/contact.vcf', '/pups/images/', '/pups/pages/']);
    ok(!isset($cfg['well_known_paths'][3]['url']), 'profile images at storage_base');
    ok(!isset($cfg['well_known_paths'][4]['url']), 'pages at storage_base');

    $c = $t->registerClient('app.example');
    $p = T::pkce();
    $page = $t->get(str_replace('/oauth/', '/pups/oauth/', T::authorizeUrl($c, 'write:/appdata/app.example/ write:/.well-known/about.md write:/pups/images/ write:/pups/pages/', $p['challenge'])));
    contains($page->text, 'action="/pups/oauth/authorize"');
    contains($page->text, 'href="/pups/pups/assets/owner.css');
    $res = $t->post('/pups/oauth/authorize', ['request' => hidden($page->text, 'request'), 'decision' => 'approve', 'password' => PASSWORD,
        'scope' => ['write:/appdata/app.example/', 'write:/.well-known/about.md', 'write:/pups/images/', 'write:/pups/pages/']]);
    $tok = $t->post('/pups/oauth/token', ['grant_type' => 'authorization_code', 'code' => $res->location()['code'], 'client_id' => $c['clientId'],
        'redirect_uri' => $c['redirectUri'], 'code_verifier' => $p['verifier']])->json()['access_token'];

    $res = $t->put('/pups/appdata/app.example/a.json', $tok, '{}');
    eq([$res->status, $res->header('location')], [201, ORIGIN . '/pups/appdata/app.example/a.json']);
    eq($t->get('/pups/appdata/app.example/a.json')->text, '{}');
    eq($t->put('/appdata/app.example/a.json', $tok, '{}')->status, 404, 'writes only at storage_base');
    // Well-known files are written at storage_base and read at their URL at the domain root.
    eq($t->put('/pups/.well-known/about.md', $tok, '# Alice', ['content-type' => 'text/markdown'])->status, 201);
    $got = $t->get('/.well-known/about.md');
    eq([$got->status, $got->text, $got->header('content-security-policy')], [200, '# Alice', 'sandbox']);
    eq($t->hostMeta($tok, ['action' => 'add', 'rel' => 'https://app.example/r', 'href' => ORIGIN . '/pups/appdata/app.example/a.json'])->status, 404, 'endpoint is under the base');
    eq($t->req('POST', '/pups/pups/host-meta', ['authorization' => "Bearer $tok", 'content-type' => 'application/json'],
        json_encode(['action' => 'add', 'rel' => 'https://app.example/r', 'href' => ORIGIN . '/pups/appdata/app.example/a.json']))->status, 201);
    contains($t->post('/pups/pups/apps', ['password' => PASSWORD])->text, 'app.example');
    eq($t->put('/pups/pups/images/a.png', $tok, 'PNG', ['content-type' => 'image/png'])->status, 201);
    eq($t->get('/pups/pups/images/a.png')->text, 'PNG');
    eq($t->req('POST', '/pups/pups/host-meta', ['authorization' => "Bearer $tok", 'content-type' => 'application/json'],
        json_encode(['action' => 'set-property', 'property' => 'https://bigwide.net/ns/avatar', 'value' => ORIGIN . '/pups/pups/images/a.png']))->status, 201);
    eq($t->put('/pups/pups/pages/now.md', $tok, '# Now', ['content-type' => 'text/markdown'])->status, 201);
    eq($t->get('/pups/pups/pages/now.md')->text, '# Now');
    eq($t->req('POST', '/pups/pups/host-meta', ['authorization' => "Bearer $tok", 'content-type' => 'application/json'],
        json_encode(['action' => 'add', 'rel' => 'https://bigwide.net/ns/webpup-pages', 'href' => ORIGIN . '/pups/pups/pages/now.md',
            'titles' => ['default' => 'Now']]))->status, 201);
});

/** Starts PHP's built-in server with a test router. Returns [base URL, stop function]. */
function startServer(array $config): array
{
    $dir = tempDir();
    $port = 0;
    $sock = stream_socket_server('tcp://127.0.0.1:0');
    $port = (int) substr(strrchr(stream_socket_get_name($sock, false), ':'), 1);
    fclose($sock);
    $config += ['origin' => "http://127.0.0.1:$port", 'allow_http' => true, 'setup_secret' => SETUP_SECRET, 'data_dir' => "$dir/data"];
    file_put_contents("$dir/config.php", '<?php return ' . var_export($config, true) . ';');
    file_put_contents("$dir/router.php", '<?php require ' . var_export(dirname(__DIR__) . '/pups/controller.php', true) . '; Pups\run(__DIR__);');
    $proc = proc_open([PHP_BINARY, '-S', "127.0.0.1:$port", "$dir/router.php"], [1 => ['file', "$dir/server.log", 'a'], 2 => ['file', "$dir/server.log", 'a']],
        $pipes, $dir, ['PHP_CLI_SERVER_WORKERS' => '4'] + getenv());
    $url = "http://127.0.0.1:$port";
    for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port); $i++)
        usleep(100_000);
    return [$url, $dir, function () use ($proc) {
        // The workers are children of the server process and outlive it.
        exec('pkill -P ' . proc_get_status($proc)['pid']);
        proc_terminate($proc);
        proc_close($proc);
    }];
}

test('built-in server: setup, upload, ranges and the Authorization header over real HTTP', function () {
    [$url, $dir, $stop] = startServer([]);
    try {
        $http = fn(string $method, string $path, array $headers = [], string $body = '') => \Pups\httpRequest($method, $url . $path, $headers, $body, ['maxBytes' => 1 << 20]);
        $page = $http('GET', '/pups/setup');
        eq($page['status'], 200);
        contains($page['body'], 'data-check="ok"><th scope="row">Authorization header');
        contains($page['body'], 'data-check="ok"><th scope="row">PUT and DELETE');
        $res = $http('POST', '/pups/setup', ['Content-Type' => 'application/x-www-form-urlencoded'], form(['step' => 'secret', 'secret' => SETUP_SECRET]));
        $res = $http('POST', '/pups/setup', ['Content-Type' => 'application/x-www-form-urlencoded'],
            form(['setup' => hidden($res['body'], 'setup'), 'new_password' => PASSWORD, 'new_password2' => PASSWORD]));
        contains($res['body'], 'Setup complete');

        // A grant made directly in the state, since the fake client network exists only in-process.
        $ctx = new \Pups\Ctx(\Pups\loadConfig($dir));
        $code = $ctx->state->createCode(['clientId' => 'https://app.example/c.json', 'clientHost' => 'app.example', 'clientName' => null,
            'redirectUri' => 'https://app.example/cb', 'codeChallenge' => \Pups\s256(str_repeat('v', 43)), 'scope' => 'write:/appdata/app.example/']);
        $tok = json_decode($http('POST', '/oauth/token', ['Content-Type' => 'application/x-www-form-urlencoded'], form(['grant_type' => 'authorization_code',
            'code' => $code, 'client_id' => 'https://app.example/c.json', 'redirect_uri' => 'https://app.example/cb', 'code_verifier' => str_repeat('v', 43)]))['body'], true)['access_token'];

        $big = str_repeat('0123456789', 20000);
        $res = $http('PUT', '/appdata/app.example/big.txt', ['Authorization' => "Bearer $tok", 'Content-Type' => 'text/plain'], $big);
        eq($res['status'], 201);
        $etag = $res['headers']['etag'];
        $res = $http('GET', '/appdata/app.example/big.txt');
        eq([$res['status'], strlen($res['body']), $res['headers']['content-security-policy']], [200, 200000, 'sandbox']);
        $res = $http('GET', '/appdata/app.example/big.txt', ['Range' => 'bytes=199990-']);
        eq([$res['status'], $res['body'], $res['headers']['content-range']], [206, '0123456789', 'bytes 199990-199999/200000']);
        $res = $http('HEAD', '/appdata/app.example/big.txt');
        eq([$res['status'], $res['headers']['content-length'], $res['body']], [200, '200000', '']);
        $res = $http('HEAD', '/appdata/app.example/big.txt', ['Authorization' => "Bearer $tok"]);
        eq([$res['status'], $res['headers']['cache-control'], $res['headers']['etag']], [200, 'private, no-store', $etag]);
        eq($http('GET', '/appdata/app.example/big.txt', ['Authorization' => 'Bearer invalid'])['status'], 401);
        eq($http('PUT', '/appdata/app.example/x.json', ['Content-Type' => 'application/json'], '{}')['status'], 401);
        contains(file_get_contents("$dir/data/pups.log"), 'file.created client=https://app.example/c.json');
        contains(file_get_contents("$dir/data/pups.log"), 'http method=PUT url=/appdata/app.example/big.txt status=201');
    } finally {
        $stop();
    }
});

test('built-in server: a missing or broken config.php gives a clear message', function () {
    [$url, $dir, $stop] = startServer([]);
    try {
        unlink("$dir/config.php");
        $res = \Pups\httpRequest('GET', "$url/");
        eq($res['status'], 500);
        contains($res['body'], 'Copy config.example.php to config.php');
        file_put_contents("$dir/config.php", "<?php return ['origin' => 'https://x.example/'];");
        contains(\Pups\httpRequest('GET', "$url/")['body'], "'origin' must be an origin");
    } finally {
        $stop();
    }
});
