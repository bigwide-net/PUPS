<?php
// The built-in receiver: mentions (RFC-11) and comments (RFC-4) into the inbox (RFC-12), with Dismiss (RFC-9, RFC-8).

namespace Pups\Test;

use function Pups\handles;
use function Pups\processQueue;
use function Pups\putInboxItem;
use function Pups\inboxItem;

const MENTION = ORIGIN . '/pups/mention';
const COMMENTS = ORIGIN . '/pups/comments';
const SRC = 'http://source.scripting.com/';

/** A server with the receiver on, as it is by default. */
function receiver(array $config = []): T
{
    unset($config['mentions'], $config['comments']);
    return new T($config + ['mentions' => true, 'comments' => true]);
}

function jsonFeedDoc(array $items, array $extra = []): string
{
    return json_encode(['version' => 'https://jsonfeed.org/version/1.1', 'title' => 'A feed'] + $extra + ['items' => $items], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

/** Puts a JSON Feed on the fake network. */
function serve(T $t, string $url, array $items, array $extra = []): void
{
    $t->web[$url] = ['status' => 200, 'headers' => ['content-type' => 'application/feed+json'], 'body' => jsonFeedDoc($items, $extra)];
}

function webmention(T $t, string $endpoint, string $source, string $target): Res
{
    return $t->post($endpoint, ['source' => $source, 'target' => $target]);
}

function inbox(T $t): ?array
{
    $text = $t->ctx->files->read('/pups/private/inbox.json');
    return $text === null ? null : json_decode($text, true);
}

function inboxIds(T $t): array
{
    return array_column(inbox($t)['items'] ?? [], 'id');
}

/** The owner's main feed, with comments at the built-in endpoint. */
function ownerFeed(T $t, array $policy = [], array $items = [], array $extra = []): void
{
    $items = $items ?: [['id' => 'p-12', 'title' => 'Is RSS the better social network?', 'content_html' => '<p>I think so.</p>']];
    $t->ctx->files->write('/feed.json', jsonFeedDoc($items, $extra + ['_submissions' => ['url' => COMMENTS, 'republish' => 'no',
        'policies' => ['comments' => $policy + ['minLength' => 2, 'maxLength' => 200, 'title' => 'none', 'allowStyle' => true]]]]));
}

function bobComment(array $extra = []): array
{
    return $extra + ['id' => 'c-17', 'authors' => [['name' => 'Bob']], 'content_html' => '<P>Agreed, but discovery is <strong class="x" onclick="x">hard</strong>.</P>',
        '_source' => ['accounts' => ['socialspec' => '@bob.example'], 'inReplyTo' => ORIGIN . '/feed.json#p-12']];
}

test('receiver: on by default; announced in host-meta.json once and in the configuration document', function () {
    $t = new T(['mentions' => true, 'comments' => true]);
    $plain = new T();
    $cfg = $t->get('/personal-storage.json')->json();
    eq([$cfg['mention_endpoint'], $cfg['comment_endpoint']], [MENTION, COMMENTS]);
    ok(in_array(['path' => '/pups/private/inbox.json'], $cfg['well_known_paths'], true), 'the inbox is declared');
    ok(!isset($plain->get('/personal-storage.json')->json()['mention_endpoint']), 'not without the receiver');
    eq(\Pups\Config::fromArray(['origin' => ORIGIN, 'data_dir' => tempDir()])->mentions, true, 'default');
    eq($t->get('/.well-known/host-meta.json')->json()['links'][1], ['rel' => 'https://bigwide.net/ns/mention', 'href' => MENTION]);

    // A stored host-meta.json gets the link once; if the owner removes it, it stays removed.
    $u = new T(['mentions' => true]);
    $file = '/.well-known/host-meta.json';
    $u->ctx->files->write($file, json_encode(['links' => [['rel' => 'me', 'href' => 'https://x.example/']]]));
    @unlink("$u->dataDir/mention-link.json");
    $u->get('/');
    eq(array_column(json_decode($u->ctx->files->read($file), true)['links'], 'rel'), ['me', 'https://bigwide.net/ns/mention']);
    $u->ctx->files->write($file, json_encode(['links' => []]));
    $u->get('/');
    eq(json_decode($u->ctx->files->read($file), true)['links'], [], 'not added again');
});

test('handles: found as RFC-11 describes, not in e-mail and fediverse addresses or paths', function () {
    eq(handles('Great talk by @Tim.Example.com yesterday. Thanks, @alice.pups.test.'), ['tim.example.com', 'alice.pups.test']);
    eq(handles('(@a.example), "@b.example"! @c.example: @d.example;'), ['a.example', 'b.example', 'c.example', 'd.example']);
    eq(handles('tim@tim.example.com @tim@social.example @x.example/path @x-.example @nolabel @1.2 x@y.example.com .@z.example'), []);
    eq(handles('@x.example.com- @x.example_y @a.example.com.au @b.example.com-y'), ['a.example.com.au', 'b.example.com-y']);
    eq(handles('@foo.com,@bar.com;@baz.com (@x.example, @y.example).'), ['foo.com', 'bar.com', 'baz.com', 'x.example', 'y.example']);
    eq(handles("I did this thanks to @foo.com. And @bar.com!\nAlso @baz.com."), ['foo.com', 'bar.com', 'baz.com']);
    eq(handles('Thanks to @a.example/@b.example/@c.example! @d.example/@e.example/path x/@f.example @g.example/@nodot'), ['a.example', 'b.example', 'c.example']);
    eq(\Pups\visibleText('<p>Hi <a href="https://alice.pups.test/">@alice.pups.test</a></p><pre>@code.example</pre>', true), 'Hi @alice.pups.test');
    // RFC-9's action fallbacks are no part of the post.
    eq(\Pups\visibleText('<p>Vote!</p><p class="poll without-extension-actions"><a href="https://polls.example/p">Vote on the website</a></p>'), 'Vote!');
});

test('mentions: a post that names the owner reaches the inbox, attributed and with Dismiss', function () {
    $t = receiver();
    $src = 'https://bob.example/feed/feed.000004.json';
    serve($t, $src, [['id' => 'p-81', 'url' => 'https://bob.example/2026/feeds', 'title' => 'Feeds are back', 'date_published' => '2026-11-19T09:00:00Z',
        'content_html' => '<p>Great talk by <a href="https://alice.pups.test/">@alice.pups.test</a> yesterday.</p>', 'authors' => [['name' => 'Bob']],
        '_source' => ['accounts' => ['socialspec' => '@bob.example']]]]);
    $res = webmention($t, MENTION, "$src#p-81", ORIGIN . '/');
    eq([$res->status, $res->header('access-control-allow-origin')], [202, '*']);
    ok($t->ctx->workPending, 'the queue is worked through after the response');
    eq(inbox($t), null, 'nothing before the check');
    eq(processQueue($t->ctx), 1);
    $feed = inbox($t);
    eq([$feed['_inbox']['writer'], $feed['_inbox']['categories']], ['pups', ['mentions', 'moderation']]);
    $item = $feed['items'][0];
    eq([$item['_inbox']['type'], $item['_inbox']['source'], $item['_inbox']['target'], $item['_inbox']['postDate']], ['mention', "$src#p-81", ORIGIN . '/', '2026-11-19T09:00:00Z']);
    eq([$item['title'], $item['url'], $item['authors'][0]['name'], $item['_source']['accounts']['socialspec']], ['Feeds are back', 'https://bob.example/2026/feeds', 'Bob', '@bob.example']);
    contains($item['content_html'], '<p>Great talk by @alice.pups.test yesterday.</p><p class="without-extension-actions">'
        . "<a href=\"$src#p-81\">Mention from @bob.example.</a></p>"
        . '<p class="without-extension-actions"><a href="' . ORIGIN . '/pups/inbox/dismiss?id=' . $item['id'] . '&amp;key=');
    eq($item['_actions']['actions'], [['type' => 'display', 'text' => 'Mention from @bob.example.', 'url' => "$src#p-81", 'group' => 'origin'],
        ['template' => 'dismiss', 'group' => 'dismiss']]);
    contains($feed['_actions']['templates']['dismiss']['action'], ORIGIN . '/pups/inbox/action?id={id}&key=');

    // The same webmention again changes nothing; once the handle is gone, the mention is removed.
    webmention($t, MENTION, "$src#p-81", ORIGIN . '/');
    processQueue($t->ctx);
    eq(count(inbox($t)['items']), 1);
    serve($t, $src, [['id' => 'p-81', 'content_html' => '<p>Great talk yesterday.</p>']]);
    webmention($t, MENTION, "$src#p-81", ORIGIN . '/');
    processQueue($t->ctx);
    eq(inbox($t)['items'], []);
});

test('mentions: invalid ones never reach the inbox; deleted posts withdraw theirs; errors change nothing', function () {
    $t = receiver();
    $src = 'https://bob.example/feed.json';
    serve($t, $src, [['id' => 'a', 'content_html' => '<p>mail me: x@alice.pups.test, <code>@alice.pups.test</code></p>'],
        ['id' => 'b', 'content_text' => 'Hello @alice.pups.test', '_source' => ['accounts' => ['socialspec' => '@mallory.example']]]]);
    webmention($t, MENTION, "$src#a", ORIGIN . '/');
    webmention($t, MENTION, "$src#missing", ORIGIN . '/');
    webmention($t, MENTION, "$src#b", ORIGIN . '/');
    processQueue($t->ctx);
    $items = inbox($t)['items'];
    eq(count($items), 1);
    ok(!isset($items[0]['_source']), 'an account on another host is not shown');
    eq($items[0]['authors'][0]['name'], 'bob.example', 'the host stands in for a missing name');

    $t->web[$src]['status'] = 500;
    webmention($t, MENTION, "$src#b", ORIGIN . '/');
    processQueue($t->ctx);
    eq(count(inbox($t)['items']), 1, 'a server error removes nothing');
    $t->web[$src]['status'] = 410;
    webmention($t, MENTION, "$src#b", ORIGIN . '/');
    processQueue($t->ctx);
    eq(inbox($t)['items'], [], 'gone');

    // The owner's own posts, and documents that aren't feeds, are ignored.
    serve($t, ORIGIN . '/x.json', [['id' => 'x', 'content_text' => '@alice.pups.test']]);
    $t->web['https://bob.example/x.txt'] = ['status' => 200, 'headers' => ['content-type' => 'text/plain'], 'body' => 'hi @alice.pups.test'];
    webmention($t, MENTION, ORIGIN . '/elsewhere.json#x', ORIGIN . '/');
    webmention($t, MENTION, 'https://bob.example/x.txt', ORIGIN . '/');
    processQueue($t->ctx);
    eq(inbox($t)['items'], []);
});

test('mentions: the request is checked at once; the queue is limited per host and in total', function () {
    $t = receiver();
    foreach ([['https://bob.example/f.json', 'https://bob.example/f.json'], ['ftp://bob.example/f', ORIGIN . '/'], ['https://bob.example/f.json#1', ORIGIN . '/about'],
            ['https://bob.example/f.json#1', 'https://other.example/'], ["https://bob.example/f\u{202e}.json", ORIGIN . '/']] as [$s, $tg]) {
        $res = webmention($t, MENTION, $s, $tg);
        eq([$res->status, isset($res->json()['message'])], [400, true], "$s → $tg");
    }
    eq($t->get(MENTION)->status, 405);
    $res = $t->req('POST', '/pups/mention', ['content-type' => 'application/json'], json_encode(['source' => 'https://bob.example/f.json#1', 'target' => ORIGIN . '/']));
    eq($res->status, 202, 'JSON body');
    eq($t->req('OPTIONS', '/pups/mention', ['origin' => 'https://app.example', 'access-control-request-method' => 'POST'])->header('access-control-allow-origin'), '*');
    for ($i = 2; $i <= 5; $i++)
        eq(webmention($t, MENTION, "https://bob.example/f.json#$i", ORIGIN . '/')->status, 202);
    eq(webmention($t, MENTION, 'https://bob.example/f.json#1', ORIGIN . '/')->status, 202, 'the same job again');
    $res = webmention($t, MENTION, 'https://bob.example/f.json#6', ORIGIN . '/');
    eq([$res->status, $res->header('retry-after')], [429, '60']);
    eq(webmention($t, MENTION, 'https://carol.example/f.json#1', ORIGIN . '/')->status, 202, 'another host');
    eq((new T(['mentions' => false]))->post('/pups/mention', ['source' => 'https://bob.example/f.json#1', 'target' => ORIGIN . '/'])->status, 404);
});

test('mentions: RSS sources, HTML pages with h-entry, redirects; never the own endpoints', function () {
    $t = receiver();
    $t->web['https://bob.example/rss.xml'] = ['status' => 200, 'headers' => ['content-type' => 'application/rss+xml'], 'body' => '<?xml version="1.0"?>
<rss version="2.0" xmlns:source="' . SRC . '" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Bob</title>
<source:account service="socialspec">@bob.example</source:account>
<item><guid>r1</guid><title>Hello</title><dc:creator>Bob</dc:creator><description>&lt;p&gt;Hi @alice.pups.test!&lt;/p&gt;</description><pubDate>Thu, 19 Nov 2026 09:00:00 GMT</pubDate></item>
</channel></rss>'];
    $t->web['https://carol.example/post'] = ['status' => 200, 'headers' => ['content-type' => 'text/html; charset=utf-8'], 'body' => '<!doctype html><html><head><title>Carol\'s blog</title></head>
<body><nav>@nav.example</nav><article class="h-entry"><h1 class="p-name">Shout-out</h1><a class="p-author h-card" href="/"><span class="p-name">Carol</span></a>
<div class="e-content"><p>Thanks <a href="https://alice.pups.test/">@alice.pups.test</a>!</p></div></article></body></html>'];
    $t->web['https://dave.example/old'] = ['status' => 301, 'headers' => ['location' => '/new'], 'body' => ''];
    serve($t, 'https://dave.example/new', [['id' => 'd', 'content_text' => 'cc @alice.pups.test']]);
    $t->web['https://loop.example/a'] = ['status' => 302, 'headers' => ['location' => 'https://loop.example/a'], 'body' => ''];
    foreach (['https://bob.example/rss.xml#r1', 'https://carol.example/post', 'https://dave.example/old#d', 'https://loop.example/a#x', MENTION . '?x#y'] as $s)
        webmention($t, MENTION, $s, ORIGIN . '/');
    processQueue($t->ctx);
    $by = [];
    foreach (inbox($t)['items'] as $i)
        $by[$i['_inbox']['source']] = $i;
    ksort($by);
    eq(array_keys($by), ['https://bob.example/rss.xml#r1', 'https://carol.example/post', 'https://dave.example/old#d']);
    eq([$by['https://bob.example/rss.xml#r1']['title'], $by['https://bob.example/rss.xml#r1']['_source']['accounts']['socialspec'], $by['https://bob.example/rss.xml#r1']['_inbox']['postDate']],
        ['Hello', '@bob.example', '2026-11-19T09:00:00Z']);
    eq([$by['https://carol.example/post']['title'], $by['https://carol.example/post']['authors'][0]['name'], $by['https://carol.example/post']['url']], ['Shout-out', 'Carol', 'https://carol.example/post']);
    eq(count(array_filter($t->fetched, fn($u) => $u === 'https://loop.example/a')), 4, 'at most 3 redirects');
    ok(!in_array(MENTION . '?x', $t->fetched, true), 'never fetches its own endpoint');
});

test('replies: to the owner\'s items, also in archives, and to items republished for the owner', function () {
    $t = receiver();
    $t->ctx->files->write('/feed.json', jsonFeedDoc([['id' => 'p-12', 'content_text' => 'Mine']], ['_archive' => ['archive_url' => ORIGIN . '/feed/feed.000000.json']]));
    $t->ctx->files->write('/feed/feed.000000.json', jsonFeedDoc([['id' => 'p-1', 'url' => 'https://alice.pups.test/2025/old', 'content_text' => 'Old']]));
    $group = 'https://rm.example/groups/two/posts.json';
    serve($t, $group, [['id' => 'g1', 'content_text' => 'By Alice', '_source' => ['accounts' => ['socialspec' => '@alice.pups.test']]],
        ['id' => 'g2', 'content_text' => 'By someone else', '_source' => ['accounts' => ['socialspec' => '@x.example']]]], ['_submissions' => ['url' => 'https://rm.example/m']]);
    serve($t, 'https://plain.example/feed.json', [['id' => 'g1', 'content_text' => 'No submissions', '_source' => ['accounts' => ['socialspec' => '@alice.pups.test']]]]);
    $replies = [['id' => 'r1', 'content_text' => 'Re', '_source' => ['inReplyTo' => ORIGIN . '/feed.json#p-12']],
        ['id' => 'r2', 'content_text' => 'Re old', '_source' => ['inReplyTo' => ORIGIN . '/feed/feed.000000.json#p-1']],
        ['id' => 'r3', 'authors' => [['name' => 'Bob']], 'content_text' => 'Re group', '_source' => ['inReplyTo' => "$group#g1", 'accounts' => ['socialspec' => '@bob.example']]],
        ['id' => 'r4', 'content_text' => 'Re other', '_source' => ['inReplyTo' => "$group#g2"]],
        ['id' => 'r5', 'content_text' => 'Re plain', '_source' => ['inReplyTo' => 'https://plain.example/feed.json#g1']],
        ['id' => 'r6', 'content_text' => 'Wrong target', '_source' => ['inReplyTo' => ORIGIN . '/feed.json#p-99']]];
    $comments = 'https://rm.example/groups/two/comments/g1.json';
    serve($t, $comments, $replies, ['_submissions' => ['url' => 'https://rm.example/m']]);
    $page = 'https://erin.example/reply';
    $t->web[$page] = ['status' => 200, 'headers' => ['content-type' => 'text/html'], 'body' => '<html><body><div class="h-entry"><div class="e-content">
<p>In reply to <a class="u-in-reply-to" href="https://alice.pups.test/2025/old">this</a>.</p></div></div></body></html>'];
    foreach (['r1' => ORIGIN . '/feed.json#p-12', 'r2' => ORIGIN . '/feed/feed.000000.json#p-1', 'r3' => "$group#g1", 'r4' => "$group#g2",
            'r5' => 'https://plain.example/feed.json#g1', 'r6' => ORIGIN . '/feed.json#p-99'] as $id => $target)
        webmention($t, MENTION, "$comments#$id", $target);
    webmention($t, MENTION, $page, ORIGIN . '/feed/feed.000000.json#p-1');
    processQueue($t->ctx);
    $sources = array_map(fn($i) => $i['_inbox']['source'], inbox($t)['items']);
    sort($sources);
    eq($sources, [$page, "$comments#r1", "$comments#r2", "$comments#r3"]);
    foreach (inbox($t)['items'] as $i)
        eq($i['_inbox']['type'], 'reply');
    ok(!in_array(ORIGIN . '/feed.json', $t->fetched, true), 'the owner\'s feeds are read from storage');
    $r3 = array_values(array_filter(inbox($t)['items'], fn($i) => $i['_inbox']['source'] === "$comments#r3"))[0];
    eq($r3['_source']['accounts']['socialspec'], '@bob.example', 'stated by the server that republished it');
    $r1 = array_values(array_filter(inbox($t)['items'], fn($i) => $i['_inbox']['source'] === "$comments#r1"))[0];
    eq([$r3['_actions']['actions'][0]['text'], $r1['_actions']['actions'][0]['text']], ['Reply from @bob.example.', 'Reply from rm.example.'], 'the host without a verified account');
});

test('replies: to the owner\'s comments in RFC-7 comment feeds, whose feed file has the submissions', function () {
    // As on rhinoreader.com: the owner commented on a post that is in an archive by now. The comment
    // feeds carry no _submissions; their _pups.inReplyTo leads to the archive, whose updates_url
    // leads to the feed file that has them.
    $t = receiver();
    $r = 'https://rhino.example';
    $pups = fn(string $parent) => ['_pups' => ['pupsControlled' => true, 'inReplyTo' => $parent]];
    $mine = fn(string $id) => ['id' => $id, 'content_html' => '<p>Mine</p>', '_source' => ['accounts' => ['socialspec' => '@alice.pups.test']]];
    serve($t, "$r/feed.json", [['id' => 'new', 'content_text' => 'New']], ['_submissions' => ['url' => "$r/pups/comments"], '_archive' => ['archive_url' => "$r/feed/feed.000000.json"]]);
    serve($t, "$r/feed/feed.000000.json", [['id' => 't2w', 'content_text' => 'Post 4']], ['_archive' => ['updates_url' => "$r/feed.json"]]);
    serve($t, "$r/feed/comments/3.json", [$mine('s-x')], $pups("$r/feed/feed.000000.json#t2w"));
    // A reply to the owner's comment, and the owner's answer to it, one level deeper.
    serve($t, "$r/feed/comments/3/s-x.json", [['id' => 's-y', 'content_text' => 'Yes, it worked.', '_source' => ['inReplyTo' => "$r/feed/comments/3.json#s-x"]],
        $mine('s-z')], $pups("$r/feed/comments/3.json#s-x"));
    serve($t, "$r/feed/comments/3/s-x/s-z.json", [['id' => 's-w', 'content_text' => 'And again.', '_source' => ['inReplyTo' => "$r/feed/comments/3/s-x.json#s-z"]]],
        $pups("$r/feed/comments/3/s-x.json#s-z"));
    // Not republished for the owner: a comment feed of a feed without submissions, and one whose
    // _pups.inReplyTo leaves the host.
    serve($t, 'https://plain.example/feed.json', [['id' => 'p', 'content_text' => 'Post']]);
    serve($t, 'https://plain.example/comments/1.json', [$mine('c')], $pups('https://plain.example/feed.json#p'));
    serve($t, 'https://plain.example/comments/1/c.json', [['id' => 'd', 'content_text' => 'Re', '_source' => ['inReplyTo' => 'https://plain.example/comments/1.json#c']]],
        $pups('https://plain.example/comments/1.json#c'));
    serve($t, 'https://away.example/comments/1.json', [$mine('c')], $pups("$r/feed.json#new"));
    serve($t, 'https://away.example/comments/1/c.json', [['id' => 'd', 'content_text' => 'Re', '_source' => ['inReplyTo' => 'https://away.example/comments/1.json#c']]],
        $pups('https://away.example/comments/1.json#c'));
    foreach (["$r/feed/comments/3/s-x.json#s-y" => "$r/feed/comments/3.json#s-x", "$r/feed/comments/3/s-x/s-z.json#s-w" => "$r/feed/comments/3/s-x.json#s-z",
            'https://plain.example/comments/1/c.json#d' => 'https://plain.example/comments/1.json#c',
            'https://away.example/comments/1/c.json#d' => 'https://away.example/comments/1.json#c'] as $source => $target)
        webmention($t, MENTION, $source, $target);
    processQueue($t->ctx);
    $sources = array_map(fn($i) => $i['_inbox']['source'], inbox($t)['items'] ?? []);
    sort($sources);
    eq($sources, ["$r/feed/comments/3/s-x.json#s-y", "$r/feed/comments/3/s-x/s-z.json#s-w"]);
    foreach (inbox($t)['items'] as $i)
        eq($i['_inbox']['type'], 'reply');
});

test('comments: on the owner\'s posts, checked against the feed\'s rules, into the inbox, not published', function () {
    $t = receiver();
    ownerFeed($t, ['requireSocialSpec' => true]);
    serve($t, 'https://bob.example/comments.json', [bobComment(), bobComment(['id' => 'c-18', 'content_text' => 'x', 'content_html' => null]),
        bobComment(['id' => 'c-19', '_source' => ['inReplyTo' => ORIGIN . '/feed.json#p-12', 'accounts' => ['socialspec' => '@mallory.example']]]),
        bobComment(['id' => 'c-20', '_source' => ['accounts' => ['socialspec' => '@bob.example'], 'inReplyTo' => ORIGIN . '/feed.json#other']]),
        bobComment(['id' => 'c-21', 'title' => 'A title']), bobComment(['id' => 'c-22', 'content_html' => '<p>Hi <script>alert(1)</script></p>']),
        bobComment(['id' => 'c-23', 'content_html' => '<p>See <a href="https://x.example/">this</a></p>'])]);
    $res = webmention($t, COMMENTS, 'https://bob.example/comments.json#c-17', ORIGIN . '/feed.json#p-12');
    eq([$res->status, $res->json()['status'], $res->header('access-control-expose-headers') !== null], [201, 'waiting', true]);
    $statusUrl = $res->header('location');
    eq($res->json()['statusUrl'], $statusUrl);
    $status = fn(string $url) => $t->get(substr($url, strlen(ORIGIN)))->json();
    eq($status($statusUrl)['status'], 'waiting');
    $urls = [];
    // At most 5 webmentions from one site wait at a time.
    foreach ([['c-18', 'c-19', 'c-20', 'c-21'], ['c-22', 'c-23']] as $ids) {
        foreach ($ids as $id)
            $urls[$id] = webmention($t, COMMENTS, "https://bob.example/comments.json#$id", ORIGIN . '/feed.json#p-12')->header('location');
        processQueue($t->ctx);
    }
    $s = $status($statusUrl);
    eq([$s['status'], isset($s['pubUrl'])], ['success', false], 'republish: no');
    eq(array_map(fn($u) => $status($u)['code'], $urls), ['c-18' => 'too-short', 'c-19' => 'socialspec-mismatch', 'c-20' => 'in-reply-to-mismatch', 'c-21' => 'title-not-allowed',
        'c-22' => 'forbidden-element', 'c-23' => 'forbidden-element'], 'RFC-5: no script, and no links without allowLinks');
    $items = inbox($t)['items'];
    eq(count($items), 1);
    $item = $items[0];
    eq([$item['_inbox']['type'], $item['_inbox']['target'], $item['authors'][0]['name'], $item['_source']['accounts']['socialspec']], ['submission', ORIGIN . '/feed.json#p-12', 'Bob', '@bob.example']);
    contains($item['content_html'], '<p>Agreed, but discovery is <strong>hard</strong>.</p>', 'normalized: lower-case, without unknown attributes');
    eq($item['_actions']['actions'][0], ['type' => 'display', 'text' => 'Comment from @bob.example.', 'url' => 'https://bob.example/comments.json#c-17', 'group' => 'origin']);
    notContains($item['content_html'], 'class="x"');
    notContains($item['content_html'], 'onclick');
    notContains(json_decode($t->ctx->files->read('/feed.json'), true)['items'][0]['content_html'], 'Agreed', 'nothing is published');

    // Without allowEdit, the same source can't be sent again.
    eq(webmention($t, COMMENTS, 'https://bob.example/comments.json#c-17', ORIGIN . '/feed.json#p-12')->json()['error'], 'edit-not-allowed');
});

test('comments: only on posts of feeds that name the endpoint; edits and deletes as the feed allows', function () {
    $t = receiver();
    ownerFeed($t, ['allowEdit' => true, 'allowDelete' => true], [['id' => 'p-12', 'content_text' => 'Open'], ['id' => 'p-13', 'content_text' => 'Closed', '_commenting' => ['allowComments' => false]]]);
    $t->ctx->files->write('/feed/photos.json', jsonFeedDoc([['id' => 'q', 'content_text' => 'No comments here']]));
    $src = 'https://bob.example/comments.json#c-17';
    foreach ([ORIGIN . '/feed.json' => 'invalid_request', ORIGIN . '/feed.json#p-13' => 'comments-disabled', ORIGIN . '/feed.json#p-99' => 'target-gone',
            ORIGIN . '/feed/photos.json#q' => 'invalid_request', 'https://other.example/feed.json#p-12' => 'invalid_request'] as $target => $code) {
        $res = webmention($t, COMMENTS, $src, $target);
        eq([$res->status, $res->json()['error']], [400, $code], $target);
    }
    serve($t, 'https://bob.example/comments.json', [bobComment()]);
    webmention($t, COMMENTS, $src, ORIGIN . '/feed.json#p-12');
    processQueue($t->ctx);
    $first = inbox($t)['items'][0];
    serve($t, 'https://bob.example/comments.json', [bobComment(['content_html' => '<p>Edited.</p>'])]);
    $t->offset += 60_000;
    eq(webmention($t, COMMENTS, $src, ORIGIN . '/feed.json#p-12')->status, 201);
    processQueue($t->ctx);
    $edited = inbox($t)['items'][0];
    eq([$edited['id'], $edited['date_published']], [$first['id'], $first['date_published']], 'same item, same arrival');
    contains($edited['content_html'], '<p>Edited.</p>');
    serve($t, 'https://bob.example/comments.json', []);
    $res = webmention($t, COMMENTS, $src, ORIGIN . '/feed.json#p-12');
    processQueue($t->ctx);
    eq([$t->get(substr($res->header('location'), strlen(ORIGIN)))->json()['status'], inbox($t)['items']], ['deleted', []]);
    eq($t->get('/pups/comments/status/s-AAAAAAAAAAAAAAAA')->status, 404);
});

test('comments: on archived posts as the feed file says, whatever the archive says (RFC-7)', function () {
    $t = receiver();
    $archive = ORIGIN . '/feed/feed.000000.json';
    ownerFeed($t, [], [], ['_archive' => ['archive_url' => $archive]]);
    $t->ctx->files->write('/feed/feed.000000.json', jsonFeedDoc([['id' => 'p-1', 'content_text' => 'Old']], ['_archive' => ['updates_url' => ORIGIN . '/feed.json']]));
    serve($t, 'https://bob.example/comments.json', [bobComment(['_source' => ['accounts' => ['socialspec' => '@bob.example'], 'inReplyTo' => "$archive#p-1"]])]);
    eq(webmention($t, COMMENTS, 'https://bob.example/comments.json#c-17', "$archive#p-1")->status, 201, 'the archive has no _submissions');
    processQueue($t->ctx);
    eq(array_column(array_column(inbox($t)['items'], '_inbox'), 'target'), ["$archive#p-1"]);

    // Comments turned off in the feed file; the archive still has a copy from earlier.
    $t->ctx->files->write('/feed.json', jsonFeedDoc([], ['_archive' => ['archive_url' => $archive]]));
    $t->ctx->files->write('/feed/feed.000000.json', jsonFeedDoc([['id' => 'p-2', 'content_text' => 'Old']],
        ['_archive' => ['updates_url' => ORIGIN . '/feed.json'], '_submissions' => ['url' => COMMENTS, 'republish' => 'no', 'policies' => ['comments' => []]]]));
    $res = webmention($t, COMMENTS, 'https://bob.example/comments.json#c-18', "$archive#p-2");
    eq([$res->status, $res->json()['error']], [400, 'invalid_request']);
});

test('inbox limits: 100 items, 10 per source host; old mentions make room, waiting comments never', function () {
    $t = receiver();
    $put = fn(string $id, string $host, string $type = 'mention') => putInboxItem($t->ctx, inboxItem($t->ctx, $id, $type, "https://$host/f.json#$id", ORIGIN . '/',
        ['id' => $id, 'url' => null, 'title' => null, 'date' => null], '<p>x</p>', null, null));
    for ($i = 0; $i < 10; $i++)
        $put("m$i", 'spam.example');
    throws(fn() => $put('m10', 'spam.example'), 'already has 10 items from spam.example');
    for ($h = 0; $h < 9; $h++)
        for ($i = 0; $i < 10; $i++) {
            $t->offset += 1000;
            $put("h$h-$i", "host$h.example", $h < 5 ? 'submission' : 'mention');
        }
    eq(count(inbox($t)['items']), 100);
    $t->offset += 1000;
    $put('new', 'fresh.example');
    $ids = inboxIds($t);
    eq([count($ids), in_array('new', $ids, true), count(array_filter($ids, fn($id) => $id[0] === 'm'))], [100, true, 9], 'one of the oldest mentions made room');
    ok(count(array_filter(inbox($t)['items'], fn($i) => $i['_inbox']['type'] === 'submission')) === 50, 'no comment was dropped');

    // A comment from a host with 10 items is refused at once.
    ownerFeed($t);
    $res = webmention($t, COMMENTS, 'https://host0.example/c.json#c', ORIGIN . '/feed.json#p-12');
    eq([$res->status, $res->json()['error']], [400, 'moderation-unavailable']);
});

test('dismiss: the RFC-9 action with the inbox key, and the fallback page that asks first', function () {
    $t = receiver();
    serve($t, 'https://bob.example/f.json', [['id' => 'a', 'title' => 'Hi', 'content_text' => 'Hello @alice.pups.test'], ['id' => 'b', 'content_text' => 'Again @alice.pups.test']]);
    webmention($t, MENTION, 'https://bob.example/f.json#a', ORIGIN . '/');
    webmention($t, MENTION, 'https://bob.example/f.json#b', ORIGIN . '/');
    processQueue($t->ctx);
    $bySource = array_column(array_map(fn($i) => $i + ['src' => $i['_inbox']['source']], inbox($t)['items']), null, 'src');
    [$a, $b] = [$bySource['https://bob.example/f.json#a'], $bySource['https://bob.example/f.json#b']];
    $action = str_replace('{id}', rawurlencode($a['id']), inbox($t)['_actions']['templates']['dismiss']['action']);
    $path = substr($action, strlen(ORIGIN));
    eq($t->req('POST', preg_replace('/key=\w+/', 'key=wrong', $path), ['content-type' => 'application/json'], '{}')->status, 403);
    eq($t->req('OPTIONS', $path, ['access-control-request-headers' => 'content-type'])->header('access-control-allow-origin'), '*');
    $res = $t->req('POST', $path, ['content-type' => 'application/json'], json_encode(['id' => $a['id']]));
    eq([$res->status, $res->json()['actions'], $res->header('access-control-allow-origin')], [200, [['type' => 'display', 'text' => 'Dismissed']], '*']);
    eq(inboxIds($t), [$b['id']]);
    eq($t->req('POST', $path, ['content-type' => 'application/json'], '{}')->status, 200, 'idempotent');

    preg_match('/href="([^"]+)">Dismiss</', $b['content_html'], $m);
    $link = substr(html_entity_decode($m[1]), strlen(ORIGIN));
    $page = $t->get($link);
    eq([$page->status, $page->header('access-control-allow-origin')], [200, null]);
    contains($page->text, 'Dismiss this mention?');
    contains($page->text, 'Again @alice.pups.test');
    eq(inboxIds($t), [$b['id']], 'the link alone dismisses nothing');
    $done = $t->post('/pups/inbox/dismiss', ['id' => hidden($page->text, 'id'), 'key' => hidden($page->text, 'key')]);
    contains($done->text, 'The item was removed from your inbox.');
    eq(inbox($t)['items'], []);
    eq($t->get(preg_replace('/key=\w+/', 'key=nope', $link))->status, 403);
});

test('inbox: the owner\'s reader reads it with a read scope; another writer\'s inbox is left alone', function () {
    $t = receiver();
    serve($t, 'https://bob.example/f.json', [['id' => 'a', 'content_text' => 'Hello @alice.pups.test']]);
    webmention($t, MENTION, 'https://bob.example/f.json#a', ORIGIN . '/');
    processQueue($t->ctx);
    $reader = $t->registerClient('reader.example');
    $tok = $t->connect($reader, 'read:/pups/private/inbox.json')['access_token'];
    $res = $t->get('/pups/private/inbox.json', ['authorization' => "Bearer $tok"]);
    eq([$res->status, $res->header('cache-control'), count($res->json()['items'])], [200, 'private, no-store', 1]);
    eq($t->get('/pups/private/inbox.json')->status, 401);

    $t->ctx->files->write('/pups/private/inbox.json', jsonFeedDoc([], ['_inbox' => ['writer' => 'https://other.example/client.json', 'categories' => []]]));
    serve($t, 'https://bob.example/f.json', [['id' => 'b', 'content_text' => 'Hello again @alice.pups.test']]);
    webmention($t, MENTION, 'https://bob.example/f.json#b', ORIGIN . '/');
    processQueue($t->ctx);
    eq(inbox($t)['items'], [], 'not written');
    eq(inbox($t)['_inbox']['writer'], 'https://other.example/client.json');
});
