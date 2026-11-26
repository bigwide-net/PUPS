<?php
// The WebSub hub (websub.php): subscriptions to the kept feeds, verified at the callback, and thin pings after changes.

namespace Pups\Test;

const HUB = ORIGIN . '/pups/websub';

/**
 * A server with a kept feed, whose callbacks echo the challenge unless `answers` says otherwise (callback URL without
 * query => ['status', 'body']); the pings are recorded and answered with `statuses` (callback => status, else 204).
 */
function hubApp(array $answers = []): array
{
    [$t, $tok] = feedApp();
    eq(createFeed($t, $tok)->status, 201);
    $w = (object) ['verified' => [], 'pings' => [], 'statuses' => []];
    $t->ctx->http = function (string $url) use ($answers, $w) {
        $base = explode('?', $url)[0];
        parse_str(parse_url($url, PHP_URL_QUERY) ?? '', $q);
        $w->verified[] = $q;
        return $answers[$base] ?? ['status' => 200, 'headers' => [], 'body' => $q['hub_challenge'] ?? ''];
    };
    $t->ctx->ping = function (array $requests) use ($w) {
        $w->pings = [...$w->pings, ...$requests];
        return array_map(fn($r) => $w->statuses[$r['url']] ?? 204, $requests);
    };
    return [$t, $tok, $w];
}

/** A subscription request, and the work after the response. */
function hubReq(T $t, array $fields): Res
{
    $res = $t->req('POST', '/pups/websub', ['content-type' => 'application/x-www-form-urlencoded'], form($fields + ['hub.mode' => 'subscribe', 'hub.topic' => FEED]));
    foreach ($t->ctx->afterResponse as $fn)
        $fn();
    $t->ctx->afterResponse = [];
    return $res;
}

function subscriptions(T $t): array
{
    $out = [];
    foreach (glob($t->dataDir . '/websub/subscriptions/*/*.json') as $f)
        if ($s = \Pups\readSubscription($t->ctx, $f))
            $out[] = $s;
    usort($out, fn($a, $b) => strcmp($a['callback'], $b['callback']));
    return $out;
}

function saveFeeds(T $t, array $fields): Res
{
    $t->ctx->websub = null;
    return $t->post('/pups/feed-settings', ['password' => PASSWORD, 'save_websub' => '1'] + $fields);
}

test('websub: kept feed files name the hub, in hubs and the Link header; archives and other files don\'t', function () {
    [$t, $tok] = hubApp();
    postTo($t, $tok, ['id' => 'a', 'content_text' => 'Hi']);
    eq(stored($t, '/feed.json')['hubs'], [['type' => 'WebSub', 'url' => HUB]]);
    ok(!isset(stored($t, '/feed/feed.000000.json')['hubs']), 'no hubs in archives');
    eq($t->get('/feed.json')->header('link'), '<' . HUB . '>; rel="hub", <' . FEED . '>; rel="self"');
    eq($t->get('/feed/feed.000000.json')->header('link'), null);
    // An app can't set hubs of its own.
    $t->put('/feed.json', $tok, feedBody(['hubs' => [['type' => 'WebSub', 'url' => 'https://elsewhere.example/hub']], 'items' => stored($t, '/feed.json')['items']]));
    eq(stored($t, '/feed.json')['hubs'], [['type' => 'WebSub', 'url' => HUB]]);
});

test('websub: checks the request, verifies the intent at the callback, then subscribes, renews and unsubscribes', function () {
    [$t, , $w] = hubApp();
    $bad = fn(array $f) => hubReq($t, $f + ['hub.callback' => 'https://reader.example/cb'])->status;
    eq($bad(['hub.mode' => 'publish']), 400);
    eq($bad(['hub.callback' => 'ftp://reader.example/']), 400);
    eq($bad(['hub.callback' => 'https://reader.example/cb#x']), 400);
    eq($bad(['hub.callback' => ORIGIN . '/cb']), 400, 'not the owner\'s host');
    eq($bad(['hub.topic' => ORIGIN . '/feed/feed.000000.json']), 400, 'no archives');
    eq($bad(['hub.topic' => ORIGIN . '/feed/comments/1.json']), 400, 'no comment feeds');
    eq($bad(['hub.topic' => 'https://other.example/feed.json']), 400);
    eq($bad(['hub.lease_seconds' => 'soon']), 400);
    eq($bad(['hub.secret' => str_repeat('x', 200)]), 400);
    eq($t->req('POST', '/pups/websub', ['content-type' => 'application/json'], '{}')->status, 415);
    eq($t->get('/pups/websub')->status, 405);
    eq($w->verified, [], 'nothing verified for refused requests');

    $res = hubReq($t, ['hub.callback' => 'https://reader.example/cb?feed=1', 'hub.lease_seconds' => '60', 'hub.secret' => 's3cret']);
    eq($res->status, 202);
    eq([$w->verified[0]['feed'], $w->verified[0]['hub_mode'], $w->verified[0]['hub_topic'], $w->verified[0]['hub_lease_seconds']], ['1', 'subscribe', FEED, '3600']);
    $s = subscriptions($t)[0];
    eq([$s['topic'], $s['callback'], $s['host'], $s['secret'], $s['expiresAt'] - $s['createdAt']], [FEED, 'https://reader.example/cb?feed=1', 'reader.example', 's3cret', 3600_000]);
    $t->offset += 5000;
    hubReq($t, ['hub.callback' => 'https://reader.example/cb?feed=1']);
    $r = subscriptions($t)[0];
    eq([count(subscriptions($t)), $r['createdAt']], [1, $s['createdAt']]);
    ok(abs($r['expiresAt'] - $s['createdAt'] - 5000 - 864000_000) < 1000, 'renewed for 10 days');
    eq(hubReq($t, ['hub.mode' => 'unsubscribe', 'hub.callback' => 'https://reader.example/cb?feed=1'])->status, 202);
    eq(subscriptions($t), []);
});

test('websub: nobody is subscribed whose callback doesn\'t echo the challenge', function () {
    [$t] = hubApp(['https://a.example/cb' => ['status' => 200, 'headers' => [], 'body' => 'nope'], 'https://b.example/cb' => ['status' => 404, 'headers' => [], 'body' => '']]);
    eq(hubReq($t, ['hub.callback' => 'https://a.example/cb'])->status, 202);
    eq(hubReq($t, ['hub.callback' => 'https://b.example/cb'])->status, 202);
    eq(subscriptions($t), []);
});

test('websub: new subscribers are turned away when the hub is full, except trusted feed readers', function () {
    [$t, , $w] = hubApp();
    eq(saveFeeds($t, ['websub_enabled' => '1', 'websub_max' => '2', 'websub_trusted' => "feedly.com\nexample.net"])->status, 200);
    eq(hubReq($t, ['hub.callback' => 'https://a.example/cb'])->status, 202);
    eq(hubReq($t, ['hub.callback' => 'https://b.example/cb'])->status, 202);
    $full = hubReq($t, ['hub.callback' => 'https://c.example/cb']);
    eq([$full->status, $full->json()['error']], [403, 'subscriber_limit']);
    eq(hubReq($t, ['hub.callback' => 'https://cloud.feedly.com/push/1'])->status, 202, 'trusted');
    eq(hubReq($t, ['hub.callback' => 'https://a.example/cb'])->status, 202, 'renewals pass');
    eq(count(subscriptions($t)), 3);
    // At most five per callback host and feed, also for trusted readers.
    for ($i = 0; $i < 5; $i++)
        eq(hubReq($t, ['hub.callback' => "https://r.example.net/cb/$i"])->status, 202);
    eq(hubReq($t, ['hub.callback' => 'https://r.example.net/cb/x'])->json()['error'], 'too_many_subscriptions');
    // Expired subscriptions make room.
    $t->offset += 864000_000 + 1000;
    eq(hubReq($t, ['hub.callback' => 'https://c.example/cb'])->status, 202);
});

test('websub: a change to a feed pings its subscribers after the response, with an empty POST, the Link header and the signature', function () {
    [$t, $tok, $w] = hubApp();
    hubReq($t, ['hub.callback' => 'https://a.example/cb']);
    hubReq($t, ['hub.callback' => 'https://b.example/gone', 'hub.secret' => 's3cret']);
    hubReq($t, ['hub.callback' => 'https://c.example/down']);
    ok(!\Pups\websubPending($t->ctx), 'nothing to send yet');
    $w->statuses = ['https://b.example/gone' => 410, 'https://c.example/down' => 503];
    postTo($t, $tok, ['id' => 'a', 'content_text' => 'Hi']);
    ok(\Pups\websubPending($t->ctx), 'pings wait');
    eq(\Pups\websubWork($t->ctx), 3);
    ok(!\Pups\websubPending($t->ctx), 'all sent');
    usort($w->pings, fn($a, $b) => strcmp($a['url'], $b['url']));
    eq(array_column($w->pings, 'url'), ['https://a.example/cb', 'https://b.example/gone', 'https://c.example/down']);
    eq($w->pings[0]['headers'], ['Link' => '<' . HUB . '>; rel="hub", <' . FEED . '>; rel="self"']);
    eq($w->pings[1]['headers']['X-Hub-Signature'], 'sha256=' . hash_hmac('sha256', '', 's3cret'));
    eq(array_column(subscriptions($t), 'callback'), ['https://a.example/cb', 'https://c.example/down'], '410 unsubscribes');
});

test('websub: many subscribers are pinged in batches, and a run that runs out of time continues with the next one', function () {
    [$t, $tok, $w] = hubApp();
    saveFeeds($t, ['websub_enabled' => '1', 'websub_max' => '200', 'websub_trusted' => '']);
    for ($i = 0; $i < 120; $i++)
        hubReq($t, ['hub.callback' => "https://r$i.example/cb"]);
    eq(count(subscriptions($t)), 120);
    postTo($t, $tok, ['id' => 'a', 'content_text' => 'Hi']);
    eq(\Pups\websubWork($t->ctx, 0.0), 50, 'one batch, then out of time');
    ok(\Pups\websubPending($t->ctx), 'the rest waits');
    eq(\Pups\websubWork($t->ctx), 70);
    eq(count(array_unique(array_column($w->pings, 'url'))), 120, 'everybody once');
    // A change while the pings go out starts over.
    $w->pings = [];
    postTo($t, $tok, ['id' => 'b', 'content_text' => 'Again']);
    \Pups\websubWork($t->ctx, 0.0);
    postTo($t, $tok, ['id' => 'c', 'content_text' => 'And again']);
    \Pups\websubWork($t->ctx);
    eq(count($w->pings), 170);
    eq(count(array_unique(array_column($w->pings, 'url'))), 120);
});

test('websub: the owner turns the hub off and on on the feeds page; off, feeds lose hubs and nobody is pinged', function () {
    [$t, $tok, $w] = hubApp();
    hubReq($t, ['hub.callback' => 'https://a.example/cb']);
    $page = saveFeeds($t, ['websub_max' => '1000', 'websub_trusted' => 'feedly.com']);
    eq($page->status, 200);
    contains($page->text, 'WebSub is off');
    notContains($page->text, 'name="websub_enabled" value="1" checked');
    ok(!isset(stored($t, '/feed.json')['hubs']), 'hubs removed at once');
    eq($t->get('/feed.json')->header('link'), null);
    eq(hubReq($t, ['hub.callback' => 'https://b.example/cb'])->status, 404);
    postTo($t, $tok, ['id' => 'a', 'content_text' => 'Hi']);
    ok(!\Pups\websubPending($t->ctx), 'no pings');
    ok(!isset(stored($t, '/feed.json')['hubs']), 'still none');
    $page = saveFeeds($t, ['websub_enabled' => '1', 'websub_max' => '1000', 'websub_trusted' => 'feedly.com']);
    contains($page->text, '1 subscription now');
    eq(stored($t, '/feed.json')['hubs'], [['type' => 'WebSub', 'url' => HUB]]);
    eq(itemIds(stored($t, '/feed.json')), ['a']);
});

test('websub: the feeds page checks the settings and needs the owner\'s confirmation', function () {
    [$t] = hubApp();
    $page = saveFeeds($t, ['websub_enabled' => '1', 'websub_max' => '10001']);
    eq($page->status, 400);
    contains($page->text, 'from 0 to 10,000');
    contains(saveFeeds($t, ['websub_max' => '5', 'websub_trusted' => 'https://feedly.com/'])->text, 'is not a domain');
    eq(\Pups\websubSettings($t->ctx), ['enabled' => true, 'maxSubscribers' => 1000, 'trustedDomains' => \Pups\TRUSTED_READERS]);
    $t->ctx->websub = null;
    $t->post('/pups/feed-settings', ['save_websub' => '1', 'websub_max' => '5']);
    $t->ctx->websub = null;
    eq(\Pups\websubSettings($t->ctx)['enabled'], true, 'unchanged without confirmation');
    $page = saveFeeds($t, ['websub_enabled' => '1', 'websub_max' => '250', 'websub_trusted' => "Feedly.com, *.inoreader.com\n\nfeedly.com"]);
    eq(\Pups\websubSettings($t->ctx), ['enabled' => true, 'maxSubscribers' => 250, 'trustedDomains' => ['feedly.com', 'inoreader.com']]);
    contains($page->text, "feedly.com\ninoreader.com</textarea>");
    contains($t->get('/pups/', [])->text, '/pups/feed-settings');
});
