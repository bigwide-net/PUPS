<?php
// Kept feeds (RFC-7): the server keeps the archives (RFC-13) of feed files with the _pups marker.

namespace Pups\Test;

const FEED = ORIGIN . '/feed.json';
const ARCHIVE = ORIGIN . '/feed/feed.%06d.json';

/** A server and a token with the main feed's scopes. */
function feedApp(array $config = []): array
{
    $t = new T($config + ['writes_per_minute' => 10000]);
    $c = $t->registerClient('app.example');
    return [$t, $t->connect($c, 'write:/feed.json write:/feed/ write:/appdata/app.example/')['access_token']];
}

function feedBody(array $extra = []): string
{
    return json_encode($extra + ['version' => 'https://jsonfeed.org/version/1.1', 'title' => 'Notes', 'items' => [], '_pups' => ['pupsControlled' => true]], JSON_UNESCAPED_SLASHES);
}

function createFeed(T $t, string $tok, string $path = '/feed.json', array $extra = []): Res
{
    return $t->put($path, $tok, feedBody($extra), ['if-none-match' => '*']);
}

function postTo(T $t, string $tok, array $item, string $path = '/feed.json'): Res
{
    return $t->req('POST', $path, ['authorization' => "Bearer $tok", 'content-type' => 'application/json'], json_encode($item, JSON_UNESCAPED_SLASHES));
}

function stored(T $t, string $path): array
{
    return json_decode($t->ctx->files->read($path), true);
}

function itemIds(array $doc): array
{
    return array_column($doc['items'], 'id');
}

function indexes(array $doc): array
{
    return array_map(fn($i) => $i['_archive']['index'] ?? null, $doc['items']);
}

function postMany(T $t, string $tok, int $from, int $to): void
{
    for ($i = $from; $i <= $to; $i++)
        eq(postTo($t, $tok, ['id' => "p$i", 'content_text' => "Post $i"])->status, 201, "post $i");
}

test('kept feeds: creating a feed sets the fixed fields and answers with the feed as stored', function () {
    [$t, $tok] = feedApp();
    $res = createFeed($t, $tok, '/feed.json', ['home_page_url' => 'https://elsewhere.example/', 'description' => 'Mine']);
    eq($res->status, 201);
    $doc = $res->json();
    eq([$doc['home_page_url'], $doc['feed_url'], $doc['description'], $doc['items'], $doc['_pups']['pupsControlled']], [ORIGIN . '/', FEED, 'Mine', [], true]);
    contains($doc['user_comment'], 'Personal Upload Server');
    ok(!isset($doc['_archive']), 'no archives without items');
    eq($res->header('etag'), null, 'no ETag: the server changed what was sent');
    eq($res->header('content-location'), FEED);
    eq(stored($t, '/feed.json'), $doc);
    ok($t->get('/personal-storage.json')->json()['kept_feeds'] ?? false, 'the configuration document says so');
});

test('kept feeds: posted items get indexes and go into archives of 20; the feed file keeps the newest 30', function () {
    [$t, $tok] = feedApp();
    createFeed($t, $tok);
    $res = postTo($t, $tok, ['id' => 'p0', 'content_text' => 'Post 0']);
    eq([$res->status, $res->header('location'), $res->json()['address'], $res->json()['item']['_archive']['index']],
        [201, sprintf(ARCHIVE, 0) . '#p0', sprintf(ARCHIVE, 0) . '#p0', 0]);
    ok(is_string($res->json()['item']['date_published']), 'date_published is set');
    postMany($t, $tok, 1, 44);

    $feed = stored($t, '/feed.json');
    eq(itemIds($feed), array_map(fn($i) => "p$i", range(44, 15)));
    eq($feed['_archive'], ['about' => \Pups\ARCHIVE_SPEC, 'archive_url' => sprintf(ARCHIVE, 2), 'archive_template' => ORIGIN . '/feed/feed.{number}.json', 'archive_size' => 20]);
    ok(!isset($feed['next_url']), 'no next_url');
    $a = [stored($t, '/feed/feed.000000.json'), stored($t, '/feed/feed.000001.json'), stored($t, '/feed/feed.000002.json')];
    eq([indexes($a[0]), indexes($a[1]), indexes($a[2])], [range(19, 0), range(39, 20), range(44, 40)]);
    eq([$a[0]['_archive'], $a[2]['_archive']['next_index'], $a[2]['next_url'], $a[1]['next_url'], isset($a[0]['next_url'])],
        [['about' => \Pups\ARCHIVE_SPEC, 'updates_url' => FEED, 'number' => 0], 45, sprintf(ARCHIVE, 1), sprintf(ARCHIVE, 0), false]);
    ok(!isset($a[1]['_archive']['next_index']), 'only the newest archive has the counter');
    eq([$a[1]['feed_url'], $a[1]['title'], $a[1]['_pups']['pupsControlled']], [sprintf(ARCHIVE, 1), 'Notes', true]);
    contains($a[1]['user_comment'], 'This is an archive of ' . FEED);
});

test('kept feeds: an item is replaced by its index, or by its id while it is among the newest', function () {
    [$t, $tok] = feedApp();
    createFeed($t, $tok);
    postMany($t, $tok, 0, 44);
    $old = stored($t, '/feed/feed.000000.json')['items'][19];
    eq($old['id'], 'p0');

    // An old item, named by its index.
    $res = postTo($t, $tok, ['content_text' => 'Edited'] + $old);
    eq([$res->status, $res->json()['address'], $res->json()['item']['content_text'], $res->json()['item']['date_published']], [200, sprintf(ARCHIVE, 0) . '#p0', 'Edited', $old['date_published']]);
    ok(isset($res->json()['item']['date_modified']), 'date_modified is set');
    eq(stored($t, '/feed/feed.000000.json')['items'][19]['content_text'], 'Edited');

    // Sent again unchanged: nothing is written.
    $etag = $t->ctx->files->stat('/feed/feed.000000.json')['etag'];
    eq(postTo($t, $tok, stored($t, '/feed/feed.000000.json')['items'][19])->status, 200);
    eq($t->ctx->files->stat('/feed/feed.000000.json')['etag'], $etag, 'unchanged');

    // A repeated request for a new item replaces it instead of adding it twice.
    eq(postTo($t, $tok, ['id' => 'p44', 'content_text' => 'Post 44 again'])->status, 200);
    eq([count(stored($t, '/feed/feed.000002.json')['items']), stored($t, '/feed/feed.000002.json')['_archive']['next_index']], [5, 45]);
    eq(stored($t, '/feed.json')['items'][0]['content_text'], 'Post 44 again', 'the feed file has the new version');

    // An index that no item has, or that belongs to another item.
    eq(postTo($t, $tok, ['id' => 'p3', 'content_text' => 'x', '_archive' => ['index' => 4]])->status, 404);
    eq(postTo($t, $tok, ['content_text' => 'no content'] + ['id' => 'p5'] + ['_archive' => ['index' => 5]])->status, 200);
    eq(postTo($t, $tok, ['id' => 'p6'])->json()['error'], 'invalid_request', 'content is required');
});

test('kept feeds: deleting an item leaves a gap and fills the feed file up again from the archives', function () {
    [$t, $tok] = feedApp();
    createFeed($t, $tok);
    postMany($t, $tok, 0, 44);
    $res = postTo($t, $tok, ['id' => 'p30', '_pups' => ['delete' => true]]);
    eq([$res->status, $res->json()['address'], $res->json()['item']['content_text']], [200, sprintf(ARCHIVE, 1) . '#p30', 'Post 30']);
    $feed = stored($t, '/feed.json');
    eq([count($feed['items']), end($feed['items'])['id'], in_array('p30', itemIds($feed), true)], [30, 'p14', false]);
    eq(count(stored($t, '/feed/feed.000001.json')['items']), 19, 'never rebalanced');
    // An old item, found without its index.
    eq(postTo($t, $tok, ['id' => 'p2', '_pups' => ['delete' => true]])->status, 200);
    eq(count(stored($t, '/feed/feed.000000.json')['items']), 19);
    eq(postTo($t, $tok, ['id' => 'p2', '_pups' => ['delete' => true]])->status, 404);
    eq(postTo($t, $tok, ['id' => 'p2', 'content_text' => 'Back', '_archive' => ['index' => 2]])->status, 404, 'a deleted item stays deleted');
    eq(postTo($t, $tok, ['id' => 'p45', 'content_text' => 'New'])->json()['item']['_archive']['index'], 45, 'indexes are not used again');
});

test('kept feeds: a PUT of the feed file adds, changes and deletes items, and changes the settings', function () {
    [$t, $tok] = feedApp();
    createFeed($t, $tok);
    postMany($t, $tok, 0, 24);
    $feed = stored($t, '/feed.json');
    $etag = $t->get('/feed.json')->header('etag');
    $feed['title'] = 'Renamed';
    $feed['_submissions'] = ['url' => 'https://rm.example/m'];
    $feed['items'][1]['content_text'] = 'Changed';               // p23, in archive 1
    array_splice($feed['items'], 10, 1);                          // p14, in archive 0
    array_unshift($feed['items'], ['id' => 'n1', 'content_text' => 'New 1'], ['id' => 'n2', 'content_text' => 'New 2']);
    $feed['_archive']['archive_url'] = 'https://evil.example/x.json';
    $res = $t->put('/feed.json', $tok, json_encode($feed, JSON_UNESCAPED_SLASHES), ['if-match' => $etag]);
    eq($res->status, 200);
    $doc = $res->json();
    eq([$doc['title'], $doc['_archive']['archive_url'], $doc['_submissions']['url']], ['Renamed', sprintf(ARCHIVE, 1), 'https://rm.example/m']);
    eq(array_slice(itemIds($doc), 0, 3), ['n1', 'n2', 'p24'], 'in the order of the feed');
    eq(array_slice(indexes($doc), 0, 2), [26, 25]);
    $a0 = stored($t, '/feed/feed.000000.json');
    $a1 = stored($t, '/feed/feed.000001.json');
    eq([in_array('p14', itemIds($a0), true), $a1['items'][3]['content_text'], itemIds($a1)[0]], [false, 'Changed', 'n1']);
    ok(isset($a1['items'][3]['date_modified']), 'date_modified is set');
    ok(!isset($a1['_submissions']), 'archives never carry _submissions');
    eq($t->put('/feed.json', $tok, json_encode($feed), ['if-match' => $etag])->status, 412, 'ETags as always');

    // Duplicate ids are refused.
    $doc['items'][1]['id'] = $doc['items'][0]['id'];
    eq($t->put('/feed.json', $tok, json_encode($doc), ['if-match' => $t->get('/feed.json')->header('etag')])->status, 400);
});

test('kept feeds: apps never write archives; feeds without the marker are ordinary files', function () {
    [$t, $tok] = feedApp();
    createFeed($t, $tok);
    postTo($t, $tok, ['id' => 'p0', 'content_text' => 'Post 0']);
    eq($t->put('/feed/feed.000000.json', $tok, feedBody())->status, 403);
    eq($t->req('DELETE', '/feed/feed.000000.json', ['authorization' => "Bearer $tok"])->status, 403);

    $plain = json_encode(['version' => 'https://jsonfeed.org/version/1.1', 'title' => 'By hand', 'items' => [['id' => 'x', 'content_text' => 'X']]]);
    eq($t->put('/feed/photos.json', $tok, $plain)->status, 201);
    eq($t->ctx->files->read('/feed/photos.json'), $plain, 'stored as sent');
    eq(postTo($t, $tok, ['content_text' => 'Hi'], '/feed/photos.json')->json()['error'], 'not_pups_controlled');
    eq($t->put('/feed/photos/feed.000000.json', $tok, $plain)->status, 201, 'archives of a feed without the marker are files too');
    eq(postTo($t, $tok, ['content_text' => 'Hi'], '/feed/nothing.json')->status, 404);
    eq(postTo($t, $tok, ['content_text' => 'Hi'], '/appdata/app.example/feed.json')->status, 404, 'POST only on feed files');
    eq($t->put('/feed.json', $tok, json_encode(['_pups' => ['pupsControlled' => true], 'title' => 'x']))->status, 400, 'a kept feed file must be a JSON Feed');
});

test('kept feeds: a handed-over feed gets archives with its items, oldest first, continuing its next_url', function () {
    [$t, $tok] = feedApp();
    $items = array_map(fn($i) => ['id' => "h$i", 'content_text' => "Hand $i"], range(24, 0));
    $t->ctx->files->write('/feed.json', json_encode(['version' => 'https://jsonfeed.org/version/1', 'title' => 'By hand', 'author' => ['name' => 'Alice'],
        'next_url' => 'https://alice.pups.test/old/page2.json', '_pups' => ['pupsControlled' => true], 'items' => $items]));
    eq(postTo($t, $tok, ['id' => 'new', 'content_text' => 'New'])->json()['item']['_archive']['index'], 25);
    $a0 = stored($t, '/feed/feed.000000.json');
    eq([indexes($a0)[0], end($a0['items'])['id'], end($a0['items'])['_archive']['index'], $a0['next_url']], [19, 'h0', 0, 'https://alice.pups.test/old/page2.json']);
    eq(itemIds(stored($t, '/feed/feed.000001.json')), ['new', 'h24', 'h23', 'h22', 'h21', 'h20']);
    $feed = stored($t, '/feed.json');
    eq([$feed['version'], $feed['authors'], isset($feed['author']), isset($feed['next_url']), $feed['items'][0]['id']],
        ['https://jsonfeed.org/version/1.1', [['name' => 'Alice']], false, false, 'new']);
});

test('kept feeds: new items get the URL of their page from the post URL template', function () {
    [$t, $tok] = feedApp();
    $t->ctx->files->write('/.well-known/host-meta.json', json_encode(['links' => [], 'properties' => ['https://bigwide.net/ns/post-url-template' => ORIGIN . '/p/{feed}/post/{index}']]));
    createFeed($t, $tok, '/feed/photos.json');
    eq(postTo($t, $tok, ['id' => 'a', 'content_text' => 'A'], '/feed/photos.json')->json(), [
        'item' => ['id' => 'a', 'content_text' => 'A', 'date_published' => stored($t, '/feed/photos/feed.000000.json')['items'][0]['date_published'],
            '_archive' => ['index' => 0], 'url' => ORIGIN . '/p/feed/photos/post/0'],
        'address' => ORIGIN . '/feed/photos/feed.000000.json#a',
    ]);
    eq(postTo($t, $tok, ['id' => 'b', 'content_text' => 'B', 'url' => 'https://elsewhere.example/b'], '/feed/photos.json')->json()['item']['url'], 'https://elsewhere.example/b');
    eq(stored($t, '/feed/photos.json')['_archive']['archive_template'], ORIGIN . '/feed/photos/feed.{number}.json');
});

test('kept feeds: items through the POST fallback', function () {
    [$t, $tok] = feedApp(['post_fallback' => true]);
    eq($t->req('POST', '/pups/post?method=PUT&path=%2Ffeed.json', ['authorization' => "Bearer $tok", 'content-type' => 'application/json', 'if-none-match' => '*'], feedBody())->status, 201);
    $res = $t->req('POST', '/pups/post?method=POST&path=%2Ffeed.json', ['authorization' => "Bearer $tok", 'content-type' => 'application/json'], '{"content_text":"Hi"}');
    eq([$res->status, $res->json()['item']['_archive']['index']], [201, 0]);
    ok(str_starts_with($res->json()['item']['id'], 'p-'), 'the server gives an id');
});

test('kept feeds: the storage quota applies to the files the server writes', function () {
    [$t, $tok] = feedApp(['max_storage_bytes' => 6000]);
    createFeed($t, $tok);
    $res = postTo($t, $tok, ['id' => 'big', 'content_text' => str_repeat('x', 5000)]);
    eq([$res->status, $res->json()['error']], [507, 'insufficient_storage']);
    eq(stored($t, '/feed.json')['items'], [], 'nothing was written');
    ok(!$t->ctx->files->stat('/feed/feed.000000.json'), 'no archive');
});
