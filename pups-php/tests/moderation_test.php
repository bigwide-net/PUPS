<?php
// Auto-moderation of comments (moderation.php): the owner's settings, and comments that a model rates.

namespace Pups\Test;

use function Pups\processQueue;

/**
 * Replaces the model's API: answers with `answer` as the rating, or a string as the message (`raw`: as the body), or
 * throws it. Returns the calls.
 */
function moderator(T $t, mixed $answer, int $status = 200, bool $raw = false): \ArrayObject
{
    $calls = new \ArrayObject();
    $t->ctx->llm = function (string $url, array $headers, string $body) use ($calls, $answer, $status, $raw) {
        $calls[] = ['url' => $url, 'headers' => $headers, 'body' => json_decode($body, true)];
        if ($answer instanceof \Throwable)
            throw $answer;
        return ['status' => $status, 'headers' => [], 'body' => $raw ? $answer
            : json_encode(['choices' => [['message' => ['role' => 'assistant', 'content' => is_string($answer) ? $answer : json_encode($answer)]]]])];
    };
    return $calls;
}

function saveModeration(T $t, array $fields): Res
{
    return $t->post('/pups/comment-settings', ['password' => PASSWORD, 'save_moderation' => '1'] + $fields);
}

test('auto-moderation: off by default; the owner enables it with an API key, which the page never shows', function () {
    $t = new T();
    ok(!str_contains($t->get('/pups/apps')->text, '/pups/comment-settings'), 'no comments page without comments');
    eq($t->get('/pups/comment-settings')->status, 404);

    [$t] = commentSetup();
    contains($t->get('/pups/apps')->text, '<li><a href="/pups/comment-settings">Comments</a></li>');
    $apps = $t->post('/pups/apps', ['password' => PASSWORD])->text;
    ok(!str_contains($apps, 'Auto-moderation') && !str_contains($apps, 'comments waiting'), 'not on the apps page');
    eq($t->post('/pups/comment-settings', ['password' => 'nope'])->status, 401);
    $page = $t->post('/pups/comment-settings', ['password' => PASSWORD]);
    contains($page->text, '<li><a href="/pups/comment-settings" aria-current="page">Comments</a></li>');
    contains($page->text, '0 comments waiting for you');
    contains($page->text, '<h2 id="moderation-heading">Auto-moderation</h2>');
    ok(!str_contains($page->text, 'name="moderation_enabled" value="1" checked'), 'off');
    contains($page->text, 'value="https://openrouter.ai/api/v1"');
    contains($page->text, 'value="openai/gpt-5-nano"');
    contains($page->text, 'Create a new key for this domain only, with a low spending limit');
    contains($page->text, 'name="moderation_threshold" min="50" max="100" step="1" value="90"');

    contains(saveModeration($t, ['moderation_enabled' => '1'])->text, 'Auto-moderation needs an API key.');
    contains(saveModeration($t, ['moderation_key' => 'k', 'moderation_threshold' => '30'])->text, 'The threshold must be a whole number from 50 to 100.');
    contains(saveModeration($t, ['moderation_key' => 'k', 'moderation_endpoint' => 'ftp://x.example'])->text, 'The API endpoint must be an https URL');
    contains(saveModeration($t, ['moderation_key' => 'k', 'moderation_criteria' => str_repeat('x', 2001)])->text, 'at most 2000 characters');
    ok(!is_file($t->dataDir . '/moderation.json'), 'nothing saved');

    $res = saveModeration($t, ['moderation_enabled' => '1', 'moderation_key' => 'sk-or-v1-secret1234', 'moderation_threshold' => '85', 'moderation_criteria' => 'No cats.']);
    contains($res->text, 'Auto-moderation is on: comments rated at least 85 % likely acceptable are published at once.');
    ok(!str_contains($res->text, 'secret1234') && str_contains($res->text, 'ending in …1234'), 'only the end of the key');
    contains($res->text, '>No cats.</textarea>');
    eq(fileperms($t->dataDir . '/moderation.json') & 0777, 0600);
    eq(json_decode(file_get_contents($t->dataDir . '/moderation.json'), true)['apiKey'], 'sk-or-v1-secret1234');

    // Saved again without a key: the stored one stays; forgotten, it is gone, and moderation can't be on.
    saveModeration($t, ['moderation_enabled' => '1', 'moderation_threshold' => '90']);
    eq(\Pups\moderationSettings($t->ctx)['apiKey'], 'sk-or-v1-secret1234');
    contains(saveModeration($t, ['moderation_forget_key' => '1'])->text, 'Auto-moderation is off.');
    eq(\Pups\moderationSettings($t->ctx)['apiKey'], null);
    ok(!str_contains(file_get_contents($t->dataDir . '/moderation.json'), 'secret'), 'gone from the file');

    // Without the owner's confirmation, nothing changes.
    $t->post('/pups/comment-settings', ['save_moderation' => '1', 'moderation_enabled' => '1', 'moderation_key' => 'stolen']);
    eq(\Pups\moderationSettings($t->ctx)['apiKey'], null);
});

test('auto-moderation: comments rated likely acceptable are published at once, others wait with the rating', function () {
    [$t, $tok] = commentSetup();
    postTo($t, $tok, ['id' => 'p-12', 'title' => 'Is RSS the better social network?', 'content_text' => 'I think so.']);
    saveModeration($t, ['moderation_enabled' => '1', 'moderation_key' => 'sk-test', 'moderation_criteria' => 'Only comments in English.']);

    $calls = moderator($t, ['safe' => 0.97, 'categories' => [], 'reason' => 'A genuine remark.']);
    $status = $t->get(comment($t))->json();
    eq([inbox($t)['items'] ?? [], $status['status']], [[], 'success'], 'published without review');
    eq($status['pubUrl'], ORIGIN . '/feed/comments/0.json#' . $status['guid']);
    eq(itemIds(stored($t, '/feed/comments/0.json')), [$status['guid']]);
    eq([count($calls), $calls[0]['url'], $calls[0]['headers']['Authorization']], [1, 'https://openrouter.ai/api/v1/chat/completions', 'Bearer sk-test']);
    $req = $calls[0]['body'];
    eq([$req['model'], $req['reasoning'], $req['max_tokens'], isset($req['temperature']), array_column($req['messages'], 'role')],
        ['openai/gpt-5-nano', ['effort' => 'minimal'], 1000, false, ['system', 'user']]);
    contains($req['messages'][0]['content'], 'spam');
    contains($req['messages'][0]['content'], "<owner-criteria>\nOnly comments in English.\n</owner-criteria>");
    $data = json_decode($req['messages'][1]['content'], true);
    eq([$data['post']['title'], $data['comment']['text'], $data['comment']['account'], $data['comment']['author']],
        ['Is RSS the better social network?', 'Agreed, but discovery is hard.', '@bob.example', 'Bob']);

    // Rated lower than the threshold: into the inbox, with the rating.
    moderator($t, ['safe' => 0.4, 'categories' => ['spam'], 'reason' => 'Promotes a shop.']);
    $status = $t->get(comment($t, 'c-18', '<p>Buy cheap <a href="https://shop.example/">shoes</a>!</p>'))->json();
    eq($status['status'], 'pending');
    $item = inbox($t)['items'][0];
    eq($item['_actions']['actions'][1], ['type' => 'display', 'text' => 'Auto-moderation: 40 % likely acceptable. Promotes a shop.', 'group' => 'origin']);
    eq(array_column($item['_actions']['actions'], 'template'), ['approve', 'dismiss']);
    eq($item['_pups']['moderation'], ['safe' => 0.4, 'categories' => ['spam'], 'reason' => 'Promotes a shop.']);
    contains($item['content_html'], '<small>Auto-moderation: 40 % likely acceptable. Promotes a shop.</small>');
    inboxAction($t, $item['id'], 'approve');
    $published = stored($t, '/feed/comments/0.json')['items'][0];
    ok(!str_contains(json_encode($published), 'Auto-moderation'), 'the note isn\'t published');

    // The threshold is the owner's, and so is the API: OpenAI's own gets no OpenRouter fields.
    saveModeration($t, ['moderation_enabled' => '1', 'moderation_threshold' => '80', 'moderation_endpoint' => 'https://api.openai.com/v1', 'moderation_model' => 'gpt-5-nano']);
    $calls = moderator($t, ['safe' => 0.85, 'reason' => 'Fine.']);
    eq($t->get(comment($t, 'c-19', '<p>Nice one.</p>'))->json()['status'], 'success');
    eq([$calls[0]['url'], $calls[0]['body']['model'], isset($calls[0]['body']['reasoning'])], ['https://api.openai.com/v1/chat/completions', 'gpt-5-nano', false]);
});

test('auto-moderation: when the model fails, the comment waits in the inbox; nothing is asked when nothing is published', function () {
    [$t, $tok] = commentSetup();
    postTo($t, $tok, ['id' => 'p-12', 'content_text' => 'A post']);
    saveModeration($t, ['moderation_enabled' => '1', 'moderation_key' => 'sk-test']);
    $n = 17;
    foreach ([
        [json_encode(['error' => ['message' => 'Invalid API key']]), 401],
        ['not json', 200],
        [['verdict' => 'fine'], 200],
        [['safe' => 7.5e3], 200],
        [new \RuntimeException('Connection to openrouter.ai failed'), 200],
    ] as [$answer, $code]) {
        moderator($t, $answer, $code, is_string($answer));
        $status = $t->get(comment($t, 'c-' . $n++))->json();
        eq($status['status'], 'pending', json_encode($answer));
    }
    eq(count(inbox($t)['items']), 5);
    ok(!isset(inbox($t)['items'][0]['_pups']['moderation']), 'no rating');

    // The answer may wrap the JSON in text, and give a percentage.
    moderator($t, "Here you are:\n```json\n" . '{"safe": 95, "reason": "ok"}' . "\n```");
    eq($t->get(comment($t, 'c-30'))->json()['status'], 'success');

    // Off, or in a feed that doesn't publish comments: the model isn't asked.
    $calls = moderator($t, ['safe' => 1]);
    saveModeration($t, ['moderation_key' => '']);
    eq($t->get(comment($t, 'c-31'))->json()['status'], 'pending');
    [$u, $tok] = commentSetup([], 'no');
    postTo($u, $tok, ['id' => 'p-12', 'content_text' => 'A post']);
    saveModeration($u, ['moderation_enabled' => '1', 'moderation_key' => 'sk-test']);
    $calls = moderator($u, ['safe' => 1]);
    comment($u);
    eq([count($calls), count(inbox($u)['items'])], [0, 1]);
});

test('auto-moderation: at most the tokens per day that the owner allows', function () {
    [$t, $tok] = commentSetup();
    postTo($t, $tok, ['id' => 'p-12', 'content_text' => 'A post']);
    contains($t->post('/pups/comment-settings', ['password' => PASSWORD])->text, 'name="moderation_daily_tokens" min="1" max="10000" step="1" value="500"');
    contains(saveModeration($t, ['moderation_key' => 'k', 'moderation_daily_tokens' => '10001'])->text, 'from 1 to 10000.');
    contains(saveModeration($t, ['moderation_key' => 'k', 'moderation_daily_tokens' => '0'])->text, 'from 1 to 10000.');
    saveModeration($t, ['moderation_enabled' => '1', 'moderation_key' => 'sk-test', 'moderation_daily_tokens' => '2']);

    // The API counts 1500 tokens per call: the second call reaches 2000, the third isn't made.
    $calls = new \ArrayObject();
    $t->ctx->llm = function (string $url, array $headers, string $body) use ($calls) {
        $calls[] = $body;
        return ['status' => 200, 'body' => json_encode(['choices' => [['message' => ['content' => '{"safe": 0.99}']]], 'usage' => ['total_tokens' => 1500]])];
    };
    eq($t->get(comment($t, 'c-1'))->json()['status'], 'success');
    eq($t->get(comment($t, 'c-2'))->json()['status'], 'success');
    eq([$t->get(comment($t, 'c-3'))->json()['status'], count($calls)], ['pending', 2], 'used up: into the inbox');
    contains($t->post('/pups/comment-settings', ['password' => PASSWORD])->text, 'Used today (UTC): 3,000 tokens.');

    // A new day, new tokens.
    $t->offset += 24 * 3600_000;
    eq([$t->get(comment($t, 'c-4'))->json()['status'], count($calls)], ['success', 3]);
    eq(\Pups\moderationTokensToday($t->ctx), 1500);

    // Without a count in the answer, the server estimates.
    $t->ctx->llm = fn() => ['status' => 200, 'body' => json_encode(['choices' => [['message' => ['content' => '{"safe": 0.99}']]]])];
    comment($t, 'c-5');
    ok(\Pups\moderationTokensToday($t->ctx) > 1500 + 300, 'estimated');
});
