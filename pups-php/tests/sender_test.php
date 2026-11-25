<?php
// Sending mentions (RFC-11) for published comments (sender.php): reply mentions, mentions by name, notifyReplies, edits, deletes, retries.

namespace Pups\Test;

use function Pups\processQueue;

/** host-meta.json with a mention endpoint, and the endpoint answering `status`. */
function mentionable(T $t, string $host, int $status = 202): void
{
    $t->web["https://$host/.well-known/host-meta.json"] = ['status' => 200, 'headers' => ['content-type' => 'application/json'],
        'body' => json_encode(['links' => [['rel' => 'other', 'href' => 'https://x.example/'], ['rel' => \Pups\MENTION_REL, 'href' => "https://$host/mention"]]])];
    $t->web["https://$host/mention"] = ['status' => $status, 'headers' => [], 'body' => ''];
}

/** The mentions sent: [endpoint, ['source', 'target']]. */
function sent(T $t): array
{
    return array_map(function ($p) {
        parse_str($p[1], $f);
        return [$p[0], $f];
    }, $t->posted);
}

/** A post with Bob's approved comment on it; returns [$t, Bob's id, Bob's address, a function that resubmits Bob's comment]. */
function withBob(array $policy = [], array $bobItem = []): array
{
    [$t, $tok] = commentSetup($policy);
    postTo($t, $tok, ['id' => 'p-12', 'content_text' => 'A post']);
    $submit = function (array $extra = []) use ($t, $bobItem) {
        serve($t, 'https://bob.example/comments.json', [$extra + $bobItem + ['id' => 'c-17', 'authors' => [['name' => 'Bob']], 'content_html' => '<p>Agreed.</p>',
            '_source' => ['accounts' => ['socialspec' => '@bob.example'], 'inReplyTo' => ORIGIN . '/feed.json#p-12']]]);
        $res = webmention($t, COMMENTS, 'https://bob.example/comments.json#c-17', ORIGIN . '/feed.json#p-12');
        eq($res->status, 201, $res->text);
        processQueue($t->ctx);
        return $t->get(substr($res->header('location'), strlen(ORIGIN)))->json();
    };
    $submit();
    $bob = inbox($t)['items'][0]['id'];
    inboxAction($t, $bob, 'approve');
    processQueue($t->ctx);
    return [$t, $bob, ORIGIN . "/feed/comments/0.json#$bob", $submit];
}

function approveFirst(T $t): void
{
    inboxAction($t, inbox($t)['items'][0]['id'], 'approve');
    processQueue($t->ctx);
}

test('sending mentions: a published reply notifies the author of the comment it answers, and the handles it names', function () {
    [$t, $bob, $bobs] = withBob(['allowCode' => true]);
    eq($t->posted, [], 'Bob answers the owner, who is not notified');
    mentionable($t, 'bob.example');
    mentionable($t, 'dave.example');
    $status = replyTo($t, 'carol.example', $bobs, 'r-1', '<p>Right, ask @dave.example, not @carol.example or @alice.pups.test. <code>@erin.example</code></p>');
    eq($t->posted, [], 'nothing before the owner approves');
    approveFirst($t);
    $carol = $t->get($status)->json()['pubUrl'];
    ok(str_starts_with($carol, ORIGIN . "/feed/comments/0/$bob.json#s-"), $carol);
    eq(sent($t), [
        ['https://bob.example/mention', ['source' => $carol, 'target' => $bobs]],
        ['https://dave.example/mention', ['source' => $carol, 'target' => 'https://dave.example/']],
    ]);
    eq(glob("{$t->dataDir}/mentions/queue/*.json"), []);
});

test('sending mentions: notifyReplies false is republished, and stops reply mentions but not mentions by name', function () {
    [$t, , $bobs] = withBob([], ['_commenting' => ['notifyReplies' => false]]);
    eq(stored($t, '/feed/comments/0.json')['items'][0]['_commenting'], ['about' => 'https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md', 'notifyReplies' => false]);
    mentionable($t, 'bob.example');
    replyTo($t, 'carol.example', $bobs, 'r-1', '<p>I agree.</p>');
    approveFirst($t);
    eq($t->posted, []);
    replyTo($t, 'carol.example', $bobs, 'r-2', '<p>Did you see this, @bob.example?</p>');
    approveFirst($t);
    eq(array_map(fn($s) => $s[1]['target'], sent($t)), ['https://bob.example/']);
});

test('sending mentions: notifyReplies can be changed without allowEdit and without approval; other changes cannot', function () {
    [$t, , , $submit] = withBob();
    $s = $submit(['_commenting' => ['notifyReplies' => false]]);
    eq([$s['status'], inbox($t)['items'], stored($t, '/feed/comments/0.json')['items'][0]['_commenting']['notifyReplies'] ?? null], ['success', [], false]);
    eq(glob("{$t->dataDir}/mentions/queue/*.json"), [], 'no mentions for the change');
    $s = $submit(['content_html' => '<p>Agreed, mostly.</p>']);
    eq([$s['status'], $s['code']], ['failure', 'edit-not-allowed']);
    eq(stored($t, '/feed/comments/0.json')['items'][0]['_commenting']['notifyReplies'] ?? null, false);
});

test('sending mentions: edits and deletes send the mentions again, also for the replies removed with a comment', function () {
    [$t, $bob, $bobs] = withBob(['allowEdit' => true, 'allowDelete' => true]);
    mentionable($t, 'bob.example');
    mentionable($t, 'dave.example');
    replyTo($t, 'carol.example', $bobs, 'r-1', '<p>Ask @dave.example.</p>');
    approveFirst($t);
    $carol = sent($t)[0][1]['source'];
    $t->posted = [];
    replyTo($t, 'carol.example', $bobs, 'r-1', '<p>Ask someone else.</p>');
    approveFirst($t);
    eq(sent($t), [
        ['https://bob.example/mention', ['source' => $carol, 'target' => $bobs]],
        ['https://dave.example/mention', ['source' => $carol, 'target' => 'https://dave.example/']],
    ], 'Dave is told again, and finds no mention anymore');
    $t->posted = [];
    serve($t, 'https://bob.example/comments.json', []);
    webmention($t, COMMENTS, 'https://bob.example/comments.json#c-17', ORIGIN . '/feed.json#p-12');
    processQueue($t->ctx);
    eq($t->ctx->files->read("/feed/comments/0/$bob.json"), null);
    eq(sent($t), [['https://bob.example/mention', ['source' => $carol, 'target' => $bobs]]], 'Bob is told again about the reply removed with his comment');
});

test('sending mentions: retries after 5xx, not after 4xx; remembers domains without an endpoint', function () {
    [$t, , $bobs] = withBob();
    mentionable($t, 'bob.example', 503);
    mentionable($t, 'erin.example', 400);
    replyTo($t, 'carol.example', $bobs, 'r-1', '<p>Hello @dave.example and @erin.example.</p>');
    approveFirst($t);
    $endpoints = array_map(fn($s) => $s[0], sent($t));
    sort($endpoints);
    eq($endpoints, ['https://bob.example/mention', 'https://erin.example/mention']);
    $queue = glob("{$t->dataDir}/mentions/queue/*.json");
    eq(array_map(fn($f) => [json_decode(file_get_contents($f), true)['host'], json_decode(file_get_contents($f), true)['tries']], $queue), [['bob.example', 1]]);
    processQueue($t->ctx);
    eq(count($t->posted), 2, 'not due yet');
    $t->offset += \Pups\RETRY_MS[0];
    mentionable($t, 'bob.example');
    processQueue($t->ctx);
    eq([count($t->posted), glob("{$t->dataDir}/mentions/queue/*.json")], [3, []]);
    $hostMeta = fn() => count(array_filter($t->fetched, fn($u) => $u === 'https://dave.example/.well-known/host-meta.json'));
    eq($hostMeta(), 1);
    replyTo($t, 'carol.example', $bobs, 'r-2', '<p>Hello again @dave.example.</p>');
    approveFirst($t);
    eq($hostMeta(), 1, 'remembered');
});

test('sending mentions: the owner\'s own reply notifies the commenter at once', function () {
    [$t, $tok] = commentSetup();
    postTo($t, $tok, ['id' => 'p-12', 'content_text' => 'A post']);
    comment($t);
    $bob = inbox($t)['items'][0]['id'];
    inboxAction($t, $bob, 'approve');
    $bobs = ORIGIN . "/feed/comments/0.json#$bob";
    mentionable($t, 'bob.example');
    $t->put('/feed/mine.json', $tok, json_encode(['version' => 'https://jsonfeed.org/version/1.1', 'title' => 'Mine', 'items' => [
        ['id' => 'a-1', 'content_html' => '<p>Thanks, Bob!</p>', 'authors' => [['name' => 'Alice']], '_source' => ['inReplyTo' => $bobs]]]], JSON_UNESCAPED_SLASHES));
    $res = webmention($t, COMMENTS, ORIGIN . '/feed/mine.json#a-1', $bobs);
    processQueue($t->ctx);
    $mine = $t->get(substr($res->header('location'), strlen(ORIGIN)))->json()['pubUrl'];
    eq(sent($t), [['https://bob.example/mention', ['source' => $mine, 'target' => $bobs]]]);
});

test('sending mentions: notifyReplies is read from JSON Feed and RSS', function () {
    $json = \Pups\parseFeed('{"version":"https://jsonfeed.org/version/1.1","items":[{"id":"a","_commenting":{"notifyReplies":false}},{"id":"b"}]}');
    eq(array_column($json['items'], 'notifyReplies'), [false, true]);
    $rss = \Pups\parseFeed('<rss version="2.0" xmlns:rm="https://rssmention.bigwide.net/"><channel><title>T</title>'
        . '<item><guid>a</guid><rm:commenting><rm:notifyReplies>false</rm:notifyReplies></rm:commenting></item><item><guid>b</guid></item></channel></rss>');
    eq(array_map(fn($i) => [$i['notifyReplies'], $i['allowComments']], $rss['items']), [[false, true], [true, true]]);
});
