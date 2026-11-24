<?php
// Comment feeds (RFC-7 "Publishing comments"): posts' `_source.comments`, approving comments in the inbox, edits and deletes.

namespace Pups\Test;

use function Pups\processQueue;

/** A server with the receiver, an app for the main feed, and the feed with comments at the built-in endpoint. */
function commentSetup(array $policy = [], string $republish = 'full'): array
{
    $t = new T(['mentions' => true, 'comments' => true, 'writes_per_minute' => 10000]);
    $tok = $t->connect($t->registerClient('app.example'), 'write:/feed.json write:/feed/')['access_token'];
    createFeed($t, $tok, '/feed.json', ['_submissions' => submissions($policy, $republish)]);
    return [$t, $tok];
}

function submissions(array $policy = [], string $republish = 'full'): array
{
    return ['url' => COMMENTS, 'republish' => $republish, 'policies' => ['comments' => $policy + ['minLength' => 2, 'maxLength' => 200, 'allowStyle' => true, 'allowLinks' => true]]];
}

/** Bob's comment on the post `p` at https://bob.example/comments.json#<id>, submitted and processed. Returns the status URL path. */
function comment(T $t, string $id = 'c-17', string $html = '<p>Agreed, but discovery is <strong>hard</strong>.</p>', string $p = 'p-12', array $more = []): string
{
    $mine = ['id' => $id, 'authors' => [['name' => 'Bob']], 'url' => "https://bob.example/c/$id", 'content_html' => $html,
        '_source' => ['accounts' => ['socialspec' => '@bob.example'], 'inReplyTo' => ORIGIN . "/feed.json#$p"]];
    serve($t, 'https://bob.example/comments.json', [$mine, ...$more]);
    $res = webmention($t, COMMENTS, "https://bob.example/comments.json#$id", ORIGIN . "/feed.json#$p");
    eq($res->status, 201, $res->text);
    processQueue($t->ctx);
    return substr($res->header('location'), strlen(ORIGIN));
}

/** A reply by `host` to `target`, submitted and processed. Returns the status URL path. */
function replyTo(T $t, string $host, string $target, string $id = 'r-1', string $html = '<p>Indeed, it is.</p>'): string
{
    serve($t, "https://$host/comments.json", [['id' => $id, 'authors' => [['name' => ucfirst(explode('.', $host)[0])]], 'url' => "https://$host/c/$id",
        'content_html' => $html, '_source' => ['accounts' => ['socialspec' => "@$host"], 'inReplyTo' => $target]]]);
    $res = webmention($t, COMMENTS, "https://$host/comments.json#$id", $target);
    eq($res->status, 201, $res->text);
    processQueue($t->ctx);
    return substr($res->header('location'), strlen(ORIGIN));
}

function inboxAction(T $t, string $id, string $do): Res
{
    $action = str_replace('{id}', rawurlencode($id), inbox($t)['_actions']['templates'][$do]['action']);
    return $t->req('POST', substr($action, strlen(ORIGIN)), ['content-type' => 'application/json'], '{}');
}

function post(T $t, string $id = 'p-12'): array
{
    return array_values(array_filter(stored($t, '/feed.json')['items'], fn($i) => $i['id'] === $id))[0];
}

test('comment feeds: posts carry _source.comments while the feed takes comments here', function () {
    [$t, $tok] = commentSetup();
    postTo($t, $tok, ['id' => 'p-12', 'content_text' => 'Open', '_source' => ['comments' => ['count' => 99, 'feedUrl' => 'https://x.example/']]]);
    postTo($t, $tok, ['id' => 'p-13', 'content_text' => 'Closed', '_commenting' => ['allowComments' => false]]);
    eq(post($t)['_source'], ['about' => 'https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md', 'comments' => ['count' => 0, 'total' => 0]],
        'no URL without comments; what the app sent is replaced');
    ok(!isset(post($t, 'p-13')['_source']), 'not on a closed post');
    eq(post($t, 'p-12')['_archive']['index'], 0);

    // Off: the posts lose it, also in the archives; on again: they get it back.
    $feed = stored($t, '/feed.json');
    $put = function (array $doc) use ($t, $tok) {
        $etag = $t->get('/feed.json', ['authorization' => "Bearer $tok"])->header('etag');
        eq($t->put('/feed.json', $tok, json_encode($doc, JSON_UNESCAPED_SLASHES), ['if-match' => $etag])->status, 200);
    };
    $put(array_diff_key($feed, ['_submissions' => 0]));
    ok(!isset(post($t)['_source']) && !isset(stored($t, '/feed/feed.000000.json')['items'][1]['_source']), 'removed everywhere');
    $put(stored($t, '/feed.json') + ['_submissions' => submissions()]);
    eq(stored($t, '/feed/feed.000000.json')['items'][1]['_source']['comments'], ['count' => 0, 'total' => 0], 'back in the archive');

    // Another comment server keeps its own counts.
    $put(['_submissions' => ['url' => 'https://comments.example.org/mention'] + submissions()] + stored($t, '/feed.json'));
    postTo($t, $tok, ['id' => 'p-14', 'content_text' => 'Elsewhere', '_source' => ['comments' => ['count' => 3, 'feedUrl' => 'https://comments.example.org/14.json']]]);
    eq(post($t, 'p-14')['_source']['comments'], ['count' => 3, 'feedUrl' => 'https://comments.example.org/14.json']);
    ok(!isset(post($t)['_source']), 'its own zero counts are gone');

    // "comments" is no feed name: /feed/comments/ holds the main feed's comment feeds.
    eq(createFeed($t, $tok, '/feed/comments.json')->json()['_pups'] ?? null, null, 'stored as a plain file');
});

test('comment feeds: Publish Comment publishes the comment, counts it, and tells its author', function () {
    [$t, $tok] = commentSetup(['allowEdit' => true, 'allowDelete' => true]);
    postTo($t, $tok, ['id' => 'p-12', 'title' => 'Is RSS the better social network?', 'content_text' => 'I think so.']);
    $status = comment($t);
    eq($t->get($status)->json()['status'], 'pending');
    $item = inbox($t)['items'][0];
    eq(array_map(fn($a) => $a['template'] ?? $a['type'], $item['_actions']['actions']), ['display', 'approve', 'dismiss'], 'the link first');
    eq(array_column($item['_actions']['actions'], 'group'), ['origin', 'decide', 'decide']);
    eq([inbox($t)['_actions']['templates']['approve']['label'], inbox($t)['_actions']['templates']['approve']['style']], ['Publish Comment', 'major']);
    contains($item['content_html'], '>Comment from @bob.example.</a></p><p class="without-extension-actions"><a href="' . ORIGIN . '/pups/inbox/approve?');
    contains($item['content_html'], '>Publish Comment</a></p><p class="without-extension-actions"><a href="' . ORIGIN . '/pups/inbox/dismiss?');

    $res = inboxAction($t, $item['id'], 'approve');
    $address = ORIGIN . '/feed/comments/0.json#' . $item['id'];
    eq([$res->status, $res->json()['actions']], [200, [['type' => 'display', 'text' => 'Comment published.', 'url' => $address]]]);
    eq(inbox($t)['items'], [], 'out of the inbox');
    eq($t->get($status)->json(), ['status' => 'success', 'pubDate' => $item['_inbox']['postDate'], 'pubUrl' => $address, 'guid' => $item['id']]);
    $feed = stored($t, '/feed/comments/0.json');
    eq([$feed['title'], $feed['feed_url'], $feed['home_page_url']], ['Comments on “Is RSS the better social network?”', ORIGIN . '/feed/comments/0.json', ORIGIN . '/']);
    eq($feed['items'], [['id' => $item['id'], 'url' => 'https://bob.example/c/c-17', 'content_html' => '<p>Agreed, but discovery is <strong>hard</strong>.</p>',
        'date_published' => $item['_inbox']['postDate'], 'authors' => [['name' => 'Bob']],
        '_source' => ['about' => 'https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md', 'inReplyTo' => ORIGIN . '/feed.json#p-12',
            'accounts' => ['socialspec' => '@bob.example'], 'comments' => ['count' => 0, 'total' => 0]]]], 'open for replies');
    eq(post($t)['_source']['comments'], ['feedUrl' => ORIGIN . '/feed/comments/0.json', 'count' => 1, 'total' => 1]);
    ok(!isset(post($t)['date_modified']), 'a comment is no edit of the post');
    eq($t->put('/feed/comments/0.json', $tok, '{"items":[]}')->status, 403, 'only the server writes comment feeds');
    eq(inboxAction($t, $item['id'], 'approve')->status, 404, 'approved already');

    // The second, approved on the fallback page, comes first.
    $t->offset += 60_000;
    comment($t, 'c-18', '<p>Me too.</p>');
    $second = inbox($t)['items'][0];
    preg_match('/href="([^"]+)">Publish Comment</', $second['content_html'], $m);
    $page = $t->get(substr(html_entity_decode($m[1]), strlen(ORIGIN)));
    contains($page->text, 'Publish this comment?');
    eq(count(inbox($t)['items']), 1, 'the link alone approves nothing');
    contains($t->post('/pups/inbox/approve', ['id' => hidden($page->text, 'id'), 'key' => hidden($page->text, 'key')])->text, 'The comment is published.');
    eq(itemIds(stored($t, '/feed/comments/0.json')), [$second['id'], $item['id']]);
    eq(post($t)['_source']['comments']['count'], 2);

    // An edit waits for approval; the published version stays until then.
    $t->offset += 120_000;
    comment($t, 'c-17', '<p>Agreed, discovery is hard.</p>');
    $edit = inbox($t)['items'][0];
    eq([$edit['id'], $edit['_actions']['actions'][0]['text']], [$item['id'], 'Edited comment from @bob.example.']);
    contains(stored($t, '/feed/comments/0.json')['items'][1]['content_html'], 'but discovery');
    inboxAction($t, $edit['id'], 'approve');
    $c = stored($t, '/feed/comments/0.json')['items'][1];
    eq([$c['content_html'], $c['date_published'], isset($c['date_modified'])], ['<p>Agreed, discovery is hard.</p>', $item['_inbox']['postDate'], true]);
    eq(post($t)['_source']['comments']['count'], 2);

    // Sent again unchanged: nothing to approve.
    $status = comment($t, 'c-17', '<p>Agreed, discovery is hard.</p>');
    eq([inbox($t)['items'], $t->get($status)->json()['status']], [[], 'success']);

    // Deleted by its author: gone from the comment feed and the counts.
    serve($t, 'https://bob.example/comments.json', []);
    webmention($t, COMMENTS, 'https://bob.example/comments.json#c-17', ORIGIN . '/feed.json#p-12');
    processQueue($t->ctx);
    eq(itemIds(stored($t, '/feed/comments/0.json')), [$second['id']]);
    eq(post($t)['_source']['comments'], ['feedUrl' => ORIGIN . '/feed/comments/0.json', 'count' => 1, 'total' => 1]);

    // A deleted post takes its comments along.
    eq(postTo($t, $tok, ['id' => 'p-12', '_pups' => ['delete' => true]])->status, 200);
    eq($t->ctx->files->stat('/feed/comments/0.json'), null);
});

test('comment feeds: replies to comments, as deep as the policy allows, counted up to the post', function () {
    [$t, $tok] = commentSetup(['allowDelete' => true, 'maxDepth' => 3, 'commentLimit' => 3]);
    postTo($t, $tok, ['id' => 'p-12', 'title' => 'Is RSS the better social network?', 'content_text' => 'I think so.']);
    comment($t);
    $bob = inbox($t)['items'][0]['id'];
    inboxAction($t, $bob, 'approve');
    $top = ORIGIN . '/feed/comments/0.json';

    // Carol answers Bob: her reply goes into the comment feed of Bob's comment.
    $status = replyTo($t, 'carol.example', "$top#$bob");
    $item = inbox($t)['items'][0];
    eq($item['_actions']['actions'][0]['text'], 'Reply from @carol.example.');
    $carol = $item['id'];
    inboxAction($t, $carol, 'approve');
    $bobs = ORIGIN . "/feed/comments/0/$bob.json";
    eq($t->get($status)->json()['pubUrl'], "$bobs#$carol");
    $feed = stored($t, "/feed/comments/0/$bob.json");
    eq([$feed['title'], $feed['feed_url'], $feed['home_page_url'], $feed['_pups']['inReplyTo']],
        ['Replies to a comment by Bob on “Is RSS the better social network?”', $bobs, 'https://bob.example/c/c-17', "$top#$bob"]);
    eq([$feed['items'][0]['_source']['inReplyTo'], $feed['items'][0]['_source']['comments']], ["$top#$bob", ['count' => 0, 'total' => 0]]);
    eq(stored($t, '/feed/comments/0.json')['items'][0]['_source']['comments'], ['feedUrl' => $bobs, 'count' => 1, 'total' => 1]);
    eq(post($t)['_source']['comments'], ['feedUrl' => $top, 'count' => 1, 'total' => 2]);

    // Dave answers Carol, at the deepest level: no replies to his.
    replyTo($t, 'dave.example', "$bobs#$carol");
    $dave = inbox($t)['items'][0]['id'];
    inboxAction($t, $dave, 'approve');
    $carols = ORIGIN . "/feed/comments/0/$carol.json";
    ok(!isset(stored($t, "/feed/comments/0/$carol.json")['items'][0]['_source']['comments']), 'at maxDepth');
    eq(stored($t, "/feed/comments/0/$bob.json")['items'][0]['_source']['comments'], ['feedUrl' => $carols, 'count' => 1, 'total' => 1]);
    eq(stored($t, '/feed/comments/0.json')['items'][0]['_source']['comments'], ['feedUrl' => $bobs, 'count' => 1, 'total' => 2]);
    eq(post($t)['_source']['comments'], ['feedUrl' => $top, 'count' => 1, 'total' => 3]);
    $res = webmention($t, COMMENTS, 'https://erin.example/comments.json#r-1', "$carols#$dave");
    eq([$res->status, $res->json()['error']], [400, 'max-depth']);
    $res = webmention($t, COMMENTS, 'https://erin.example/comments.json#r-1', "$top#s-unpublished");
    eq([$res->status, $res->json()['error']], [400, 'target-gone']);
    eq($t->put("/feed/comments/0/$bob.json", $tok, '{"items":[]}')->status, 403, 'only the server writes them');

    // The comment limit counts all levels.
    replyTo($t, 'erin.example', ORIGIN . '/feed.json#p-12');
    $erin = inbox($t)['items'][0]['id'];
    eq(inboxAction($t, $erin, 'approve')->json()['message'], 'The post has 3 comments, as many as the feed allows.');

    // Bob deletes his comment: the replies go with it.
    serve($t, 'https://bob.example/comments.json', []);
    webmention($t, COMMENTS, 'https://bob.example/comments.json#c-17', ORIGIN . '/feed.json#p-12');
    processQueue($t->ctx);
    foreach (['/feed/comments/0.json', "/feed/comments/0/$bob.json", "/feed/comments/0/$carol.json"] as $gone)
        eq($t->ctx->files->stat($gone), null, $gone);
    eq(post($t)['_source']['comments'], ['count' => 0, 'total' => 0]);
    eq(inboxAction($t, $erin, 'approve')->status, 200, 'room again');

    // A deleted post takes the whole thread along.
    replyTo($t, 'carol.example', "$top#$erin", 'r-2');
    inboxAction($t, inbox($t)['items'][0]['id'], 'approve');
    ok($t->ctx->files->stat("/feed/comments/0/$erin.json") !== null, 'a reply to Erin');
    postTo($t, $tok, ['id' => 'p-12', '_pups' => ['delete' => true]]);
    eq([$t->ctx->files->stat('/feed/comments/0.json'), $t->ctx->files->stat("/feed/comments/0/$erin.json")], [null, null]);
});

test('comment feeds: the owner\'s own comments are published at once, never in the inbox', function () {
    [$t, $tok] = commentSetup(['allowEdit' => true]);
    postTo($t, $tok, ['id' => 'p-12', 'content_text' => 'A post']);
    comment($t);
    $bob = inbox($t)['items'][0]['id'];
    inboxAction($t, $bob, 'approve');
    /** Alice's comment in a feed on her own server, submitted and processed. Returns its status. */
    $mine = function (string $html, string $target) use ($t, $tok) {
        $res = $t->put('/feed/mine.json', $tok, json_encode(['version' => 'https://jsonfeed.org/version/1.1', 'title' => 'Mine', 'items' => [
            ['id' => 'a-1', 'url' => ORIGIN . '/a-1', 'content_html' => $html, 'authors' => [['name' => 'Alice']], '_source' => ['inReplyTo' => $target]]]], JSON_UNESCAPED_SLASHES));
        ok(in_array($res->status, [200, 201], true), $res->text);
        $res = webmention($t, COMMENTS, ORIGIN . '/feed/mine.json#a-1', $target);
        eq($res->status, 201, $res->text);
        processQueue($t->ctx);
        return $t->get(substr($res->header('location'), strlen(ORIGIN)))->json();
    };
    $status = $mine('<p>Thanks, Bob!</p>', ORIGIN . "/feed/comments/0.json#$bob");
    eq([inbox($t)['items'], $status['status']], [[], 'success'], 'not in the inbox');
    eq($status['pubUrl'], ORIGIN . "/feed/comments/0/$bob.json#" . $status['guid']);
    $reply = stored($t, "/feed/comments/0/$bob.json")['items'][0];
    eq([$reply['content_html'], $reply['authors']], ['<p>Thanks, Bob!</p>', [['name' => 'Alice']]]);
    eq(post($t)['_source']['comments']['total'], 2);

    // An edit is published at once, too.
    $mine('<p>Thanks a lot, Bob!</p>', ORIGIN . "/feed/comments/0.json#$bob");
    eq([inbox($t)['items'], stored($t, "/feed/comments/0/$bob.json")['items'][0]['content_html']], [[], '<p>Thanks a lot, Bob!</p>']);

    // A feed that only delivers comments: nothing to publish, and nothing for the inbox.
    [$u, $tok] = commentSetup([], 'no');
    postTo($u, $tok, ['id' => 'p-12', 'content_text' => 'A post']);
    $u->put('/feed/mine.json', $tok, json_encode(['version' => 'https://jsonfeed.org/version/1.1', 'items' => [
        ['id' => 'a-1', 'content_html' => '<p>My own words.</p>', '_source' => ['inReplyTo' => ORIGIN . '/feed.json#p-12']]]], JSON_UNESCAPED_SLASHES));
    $res = webmention($u, COMMENTS, ORIGIN . '/feed/mine.json#a-1', ORIGIN . '/feed.json#p-12');
    processQueue($u->ctx);
    eq([inbox($u)['items'] ?? [], $u->get(substr($res->header('location'), strlen(ORIGIN)))->json()['status']], [[], 'success']);
});

test('comment feeds: Dismiss rejects; the comment limit; feeds that only deliver comments', function () {
    [$t, $tok] = commentSetup(['commentLimit' => 1]);
    postTo($t, $tok, ['id' => 'p-12', 'content_text' => 'A post']);
    $status = comment($t);
    inboxAction($t, inbox($t)['items'][0]['id'], 'dismiss');
    eq(array_intersect_key($t->get($status)->json(), ['status' => 0, 'code' => 0]), ['status' => 'failure', 'code' => 'moderation-rejected']);
    ok(!$t->ctx->files->stat('/feed/comments/0.json'), 'nothing published');

    comment($t, 'c-18');
    comment($t, 'c-19');
    [$b, $a] = inbox($t)['items'];
    eq(inboxAction($t, $a['id'], 'approve')->status, 200);
    $res = inboxAction($t, $b['id'], 'approve');
    eq([$res->status, $res->json()['message']], [409, 'The post has 1 comments, as many as the feed allows.']);
    eq(inboxIds($t), [$b['id']], 'stays in the inbox');

    // republish: no: the owner only reads the comments.
    [$u, $tok] = commentSetup([], 'no');
    postTo($u, $tok, ['id' => 'p-12', 'content_text' => 'A post']);
    $status = comment($u);
    eq(array_column(inbox($u)['items'][0]['_actions']['actions'], 'template'), ['dismiss']);
    eq($u->get($status)->json()['status'], 'success');
    eq(inboxAction($u, inbox($u)['items'][0]['id'], 'approve')->status, 409);
});

test('comment feeds: republish summary publishes an abstract, linked to the full text', function () {
    [$t, $tok] = commentSetup(['maxLength' => 1000], 'summary');
    postTo($t, $tok, ['id' => 'p-12', 'content_text' => 'A post']);
    $long = '<p>' . str_repeat('Feeds are <strong>great</strong>, ', 12) . 'really.</p>';
    comment($t, 'c-17', $long);
    $item = inbox($t)['items'][0];
    eq([$item['_pups'], $t->get(substr(\Pups\commentUrl($t->ctx->config), strlen(ORIGIN)) . '/status/' . $item['id'])->json()['status']],
        [['republish' => 'summary'], 'pending']);
    contains($item['content_html'], '<strong>great</strong>', 'the owner sees it all');
    inboxAction($t, $item['id'], 'approve');
    $c = stored($t, '/feed/comments/0.json')['items'][0];
    ok(!isset($c['content_html']), 'no HTML');
    eq([mb_strlen($c['content_text']), mb_substr($c['content_text'], -1), $c['url']], [150, '…', 'https://bob.example/c/c-17']);
    ok(str_starts_with($c['content_text'], 'Feeds are great, Feeds are great,'), 'the plain text');

    // Without a link to the full text, the comment is refused.
    serve($t, 'https://bob.example/comments.json', [['id' => 'c-18', 'content_text' => 'No link', '_source' => ['inReplyTo' => ORIGIN . '/feed.json#p-12']]]);
    $res = webmention($t, COMMENTS, 'https://bob.example/comments.json#c-18', ORIGIN . '/feed.json#p-12');
    processQueue($t->ctx);
    eq($t->get(substr($res->header('location'), strlen(ORIGIN)))->json()['code'], 'link-missing');

    // Submitted for full republishing, approved after the feed changed to summary: an abstract.
    [$u, $tok] = commentSetup();
    postTo($u, $tok, ['id' => 'p-12', 'content_text' => 'A post']);
    comment($u);
    $feed = stored($u, '/feed.json');
    $feed['_submissions']['republish'] = 'summary';
    $u->put('/feed.json', $tok, json_encode($feed, JSON_UNESCAPED_SLASHES), ['if-match' => $u->get('/feed.json', ['authorization' => "Bearer $tok"])->header('etag')]);
    inboxAction($u, inbox($u)['items'][0]['id'], 'approve');
    eq(stored($u, '/feed/comments/0.json')['items'][0]['content_text'], 'Agreed, but discovery is hard.');

    // And when it no longer publishes comments at all, nothing is published.
    comment($u, 'c-18');
    $feed = stored($u, '/feed.json');
    $feed['_submissions']['republish'] = 'no';
    $u->put('/feed.json', $tok, json_encode($feed, JSON_UNESCAPED_SLASHES), ['if-match' => $u->get('/feed.json', ['authorization' => "Bearer $tok"])->header('etag')]);
    $res = inboxAction($u, inbox($u)['items'][0]['id'], 'approve');
    eq([$res->status, $res->json()['message']], [409, 'The feed doesn\'t publish comments anymore.']);
});
