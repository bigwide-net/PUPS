<?php
// Comment HTML and Markdown (RFC-5): commenthtml.php and markdown.php against the cases that pups-inbox (markdown-it) runs too,
// and the rules applied to comments.

namespace Pups\Test;

use function Pups\processQueue;

const PUPS_INBOX_TESTS = __DIR__ . '/../../lib/pups-inbox/test';

test('markdown: renders like markdown-it, if pups-inbox is checked out', function () {
    if (!is_file(PUPS_INBOX_TESTS . '/markdown-cases.json'))
        return;
    foreach (json_decode(file_get_contents(PUPS_INBOX_TESTS . '/markdown-cases.json'), true) as [$md, $html])
        eq(\Pups\markdownHtml($md), $html, json_encode($md));
});

test('comment html: the same result as pups-inbox for every case, if it is checked out', function () {
    if (!is_file(PUPS_INBOX_TESTS . '/comment-html-cases.json'))
        return;
    foreach (json_decode(file_get_contents(PUPS_INBOX_TESTS . '/comment-html-cases.json'), true) as $c) {
        $r = \Pups\commentContent($c['source'], $c['policy']);
        eq(isset($r['html']) ? ['html' => $r['html'], 'length' => $r['length']] : $r, $c['expect'], $c['name']);
    }
});

test('comment html: the examples of RFC-5', function () {
    $all = ['minLength' => 2, 'maxLength' => 2000, 'allowStyle' => true, 'allowLinks' => true, 'allowCode' => true];
    $md = "Works for me with `curl -I`.\n\nSee [RFC 5005](https://www.rfc-editor.org/rfc/rfc5005), *section 2*.";
    $html = "<p>Works for me with <code>curl -I</code>.</p>\n<p>See <a href=\"https://www.rfc-editor.org/rfc/rfc5005\">RFC 5005</a>, <em>section 2</em>.</p>";
    eq(\Pups\commentContent(['markdown' => $md, 'html' => '<p>ignored</p>'], $all), ['html' => $html, 'markdown' => $md, 'length' => 51]);
    eq(\Pups\commentContent(['html' => $html], $all)['html'], $html);
    foreach (['<p>Hello<p>World' => 'malformed-html', '<p><b>Important</b></p>' => 'forbidden-element', '<p>Read <a href="/about">this</a></p>' => 'invalid-url',
        '<ul>Things<li>one</li></ul>' => 'bad-nesting', '<p>A</p><hr><p>B</p>' => 'forbidden-element', '<h2>Update</h2>' => 'forbidden-element'] as $in => $code)
        eq(\Pups\commentContent(['html' => $in], $all + ['allowLists' => true])['code'], $code, $in);
    eq(\Pups\commentContent(['markdown' => '1. Step'], $all), ['code' => 'forbidden-element', 'text' => 'The element <ol> is not allowed: this feed doesn\'t accept lists.']);
    eq(\Pups\commentContent(['html' => '<P CLASS="note">Docs: https://example.com/docs <!-- todo --><BR/>Thanks!</P>'], ['minLength' => 2, 'maxLength' => 2000, 'urlAutoLinking' => true])['html'],
        '<p>Docs: <a href="https://example.com/docs">https://example.com/docs</a> <br>Thanks!</p>');
});

test('comments: checked against the features of the policy (RFC-5); published with their Markdown', function () {
    [$t, $tok] = commentSetup(['allowLists' => true, 'urlAutoLinking' => true]);
    postTo($t, $tok, ['id' => 'p-12', 'content_text' => 'A post']);
    $md = "Two things:\n\n- **feeds**\n- see https://bob.example/why";
    serve($t, 'https://bob.example/comments.json', [['id' => 'c-1', 'authors' => [['name' => 'Bob']], 'content_html' => '<p>ignored</p>',
        '_source' => ['markdown' => $md, 'accounts' => ['socialspec' => '@bob.example'], 'inReplyTo' => ORIGIN . '/feed.json#p-12']]]);
    $status = webmention($t, COMMENTS, 'https://bob.example/comments.json#c-1', ORIGIN . '/feed.json#p-12')->header('location');
    processQueue($t->ctx);
    eq($t->get(substr($status, strlen(ORIGIN)))->json()['status'], 'pending');
    $item = inbox($t)['items'][0];
    $html = "<p>Two things:</p>\n<ul>\n<li><strong>feeds</strong></li>\n<li>see <a href=\"https://bob.example/why\">https://bob.example/why</a></li>\n</ul>";
    contains($item['content_html'], $html . '<p class="without-extension-actions">');
    eq($item['_source']['markdown'], $md);
    inboxAction($t, $item['id'], 'approve');
    $published = stored($t, '/feed/comments/0.json')['items'][0];
    eq([$published['content_html'], $published['_source']['markdown']], [$html, $md], 'the normalized HTML and the Markdown, unchanged');

    // Images are off: rejected with the reason, and nothing reaches the inbox.
    $status = comment($t, 'c-2', '<p>Look: <img src="https://bob.example/cat.jpg" alt="cat"></p>');
    eq($t->get($status)->json(), ['status' => 'failure', 'code' => 'forbidden-element',
        'text' => 'The element <img> is not allowed: this feed doesn\'t accept images.', 'guid' => $t->get($status)->json()['guid']]);
    eq(inbox($t)['items'], []);
});
