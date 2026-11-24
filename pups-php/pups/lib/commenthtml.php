<?php

namespace Pups;

/**
 * Comment HTML and Comment Markdown (RFC-5): the content of a comment, checked against the features of the feed's
 * policy and normalized. Markdown (preferred) is rendered by markdown.php, plain text becomes paragraphs; the HTML
 * is then checked with a strict tokenizer. A comment that breaks a rule is rejected with the first problem, never
 * repaired; only unknown attributes are removed. A port of pups-inbox's comment-html.ts; both run the cases in
 * lib/pups-inbox/test/comment-html-cases.json.
 */

/** The features of RFC-5, as boolean rules of an RFC-4 policy. */
const COMMENT_FEATURES = ['allowStyle', 'allowLinks', 'allowCode', 'allowQuote', 'allowImages', 'allowTables', 'allowLists', 'allowHeadlines'];
const COMMENT_MAX_URL = 512;
const COMMENT_MAX_LINK_TEXT = 120;
/** Element → the feature that allows it. */
const COMMENT_ELEMENTS = [
    'p' => 'always', 'br' => 'always',
    'strong' => 'allowStyle', 'em' => 'allowStyle', 's' => 'allowStyle',
    'a' => 'allowLinks',
    'code' => 'allowCode', 'pre' => 'allowCode',
    'q' => 'allowQuote', 'blockquote' => 'allowQuote',
    'img' => 'allowImages',
    'table' => 'allowTables', 'thead' => 'allowTables', 'tbody' => 'allowTables', 'tr' => 'allowTables', 'th' => 'allowTables', 'td' => 'allowTables',
    'ul' => 'allowLists', 'ol' => 'allowLists', 'li' => 'allowLists',
    'h1' => 'allowHeadlines', 'h2' => 'allowHeadlines', 'h3' => 'allowHeadlines', 'h4' => 'allowHeadlines', 'h5' => 'allowHeadlines', 'h6' => 'allowHeadlines',
];
const COMMENT_FEATURE_NAMES = [
    'allowStyle' => 'bold, italic and strikethrough text', 'allowLinks' => 'links', 'allowCode' => 'code', 'allowQuote' => 'quotes', 'allowImages' => 'images',
    'allowTables' => 'tables', 'allowLists' => 'lists', 'allowHeadlines' => 'headlines',
];
const COMMENT_VOID = ['br', 'img'];
const COMMENT_ATTRIBUTES = ['a' => ['href'], 'img' => ['src', 'alt']];
const COMMENT_REQUIRED_ATTRIBUTE = ['a' => 'href', 'img' => 'src'];
const COMMENT_PARENTS = ['thead' => ['table'], 'tbody' => ['table'], 'tr' => ['table', 'thead', 'tbody'], 'th' => ['tr'], 'td' => ['tr'], 'li' => ['ul', 'ol']];
const COMMENT_CHILDREN = ['table' => ['thead', 'tbody', 'tr'], 'thead' => ['tr'], 'tbody' => ['tr'], 'tr' => ['th', 'td'], 'ul' => ['li'], 'ol' => ['li']];
/** Elements that don't separate words in the visible text. */
const COMMENT_INLINE = ['strong', 'em', 's', 'a', 'code', 'q', 'img'];
/** Control and invisible characters, which are removed from the text; tabs and line breaks stay. */
const COMMENT_UNSAFE = '[\x{0000}-\x{0008}\x{000b}-\x{001f}\x{007f}-\x{009f}\x{061c}\x{200b}\x{200e}\x{200f}\x{202a}-\x{202e}\x{2060}-\x{2069}\x{feff}\x{fff0}-\x{ffff}]';

final class CommentRefused extends \Exception
{
    public function __construct(public readonly string $reason, string $text)
    {
        parent::__construct($text);
    }
}

/** Escapes text and attribute values as RFC-5 normalizes them: `&`, `<`, `>` and `"`. */
function commentEscape(string $s): string
{
    return str_replace(['&', '<', '>', '"'], ['&amp;', '&lt;', '&gt;', '&quot;'], $s);
}

function commentDecode(string $s): string
{
    return html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
}

/** Removes unsafe characters, also as numeric character references. */
function commentClean(string $s): string
{
    $s = preg_replace('/' . COMMENT_UNSAFE . '/u', '', scrub($s));
    return preg_replace_callback('/&#(x[0-9a-f]+|[0-9]+);/i', function ($m) {
        $code = $m[1][0] === 'x' || $m[1][0] === 'X' ? hexdec(substr($m[1], 1)) : (int) $m[1];
        $unsafe = $code > 0x10FFFF || $code >= 0xD800 && $code <= 0xDFFF || preg_match('/^' . COMMENT_UNSAFE . '$/u', mb_chr($code, 'UTF-8') ?: '') === 1;
        return $unsafe ? '' : $m[0];
    }, $s);
}

/** Plain text as Comment HTML: blank lines separate paragraphs, line breaks become `<br>`. */
function textCommentHtml(string $text): string
{
    $paragraphs = preg_split('/\n[ \t]*\n\s*/', trim(str_replace(["\r\n", "\r"], "\n", $text)));
    return implode('', array_map(fn($p) => '<p>' . str_replace("\n", '<br>', commentEscape(trim($p))) . '</p>', $paragraphs));
}

/** An absolute http(s) URL without whitespace, of at most 512 characters (RFC-5 "URLs"). */
function isCommentUrl(string $url): bool
{
    return strlen($url) <= COMMENT_MAX_URL && preg_match('/^https?:\/\/[^\/?#\s]+(?:[\/?#]\S*)?$/iu', $url) === 1;
}

/** The strict tokenizer: plain tags, comments (dropped) and text, nothing else. Tokens are [type, name or raw, attributes]. */
function commentTokens(string $html): array
{
    $tokens = [];
    $pos = 0;
    $len = strlen($html);
    while ($pos < $len) {
        $lt = strpos($html, '<', $pos);
        if ($lt === false || $lt > $pos)
            $tokens[] = ['text', substr($html, $pos, $lt === false ? null : $lt - $pos)];
        if ($lt === false)
            break;
        $rest = substr($html, $lt);
        if (str_starts_with($rest, '<!--')) {
            $end = strpos($html, '-->', $lt + 4);
            if ($end === false)
                throw new CommentRefused('malformed-html', 'An HTML comment is not closed.');
            $pos = $end + 3;
            continue;
        }
        if (preg_match('/^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/', $rest, $m)) {
            $tokens[] = ['close', strtolower($m[1])];
        } elseif (preg_match('/^<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"\'>\/=]+(?:\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s"\'=<>`]+))?)*)\s*(\/?)>/', $rest, $m)) {
            $name = strtolower($m[1]);
            $attrs = [];
            preg_match_all('/([^\s"\'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s"\'=<>`]+)))?/', $m[2], $all, PREG_SET_ORDER);
            foreach ($all as $a)
                $attrs[strtolower($a[1])] ??= commentDecode(($a[2] ?? '') . ($a[3] ?? '') . ($a[4] ?? ''));
            if ($m[3] !== '' && !in_array($name, COMMENT_VOID, true))
                throw new CommentRefused('malformed-html', "<$name/> must not be self-closing.");
            $tokens[] = ['open', $name, $attrs];
        } else
            throw new CommentRefused('malformed-html', 'Malformed markup: “' . mb_substr($rest, 0, 30) . '”. A “<” that doesn\'t start a tag must be written as &lt;.');
        $pos = $lt + strlen($m[0]);
    }
    return $tokens;
}

/** Checks the tokens against the features and the structure rules, and keeps only the known attributes. */
function commentValidate(array $tokens, array $features): array
{
    $out = [];
    $stack = [];
    $linkText = null;
    foreach ($tokens as $t) {
        $parent = $stack ? end($stack) : null;
        if ($t[0] === 'text') {
            if ($parent !== null && isset(COMMENT_CHILDREN[$parent]) && trim($t[1]) !== '')
                throw new CommentRefused('bad-nesting', "Text is not allowed directly inside <$parent>.");
            if ($linkText !== null)
                $linkText .= $t[1];
            $out[] = ['text', commentClean($t[1])];
        } elseif ($t[0] === 'close') {
            if ($parent !== $t[1])
                throw new CommentRefused('malformed-html', $parent !== null ? "Expected </$parent>, found </$t[1]>." : "</$t[1]> closes no element.");
            array_pop($stack);
            if ($t[1] === 'a') {
                if (mb_strlen(trim(commentDecode($linkText))) > COMMENT_MAX_LINK_TEXT)
                    throw new CommentRefused('link-text-too-long', 'A link text is longer than ' . COMMENT_MAX_LINK_TEXT . ' characters.');
                $linkText = null;
            }
            $out[] = $t;
        } else {
            $name = $t[1];
            $feature = COMMENT_ELEMENTS[$name] ?? null;
            if ($feature === null)
                throw new CommentRefused('forbidden-element', "The element <$name> is not allowed.");
            if ($feature !== 'always' && !($features[$feature] ?? false))
                throw new CommentRefused('forbidden-element', "The element <$name> is not allowed: this feed doesn't accept " . COMMENT_FEATURE_NAMES[$feature] . '.');
            $parents = COMMENT_PARENTS[$name] ?? null;
            if ($parents !== null && !in_array($parent, $parents, true))
                throw new CommentRefused('bad-nesting', "<$name> must be inside " . implode(' or ', array_map(fn($p) => "<$p>", $parents)) . '.');
            if ($parent !== null && isset(COMMENT_CHILDREN[$parent]) && !in_array($name, COMMENT_CHILDREN[$parent], true))
                throw new CommentRefused('bad-nesting', "<$name> is not allowed directly inside <$parent>.");
            if ($name === 'a' && in_array('a', $stack, true))
                throw new CommentRefused('bad-nesting', 'Links must not be nested.');
            $attrs = [];
            foreach (COMMENT_ATTRIBUTES[$name] ?? [] as $a)
                if (isset($t[2][$a]))
                    $attrs[$a] = commentClean($t[2][$a]);
            if ($required = COMMENT_REQUIRED_ATTRIBUTE[$name] ?? null) {
                $url = $attrs[$required] ?? '';
                if ($url === '')
                    throw new CommentRefused('missing-attribute', "<$name> needs the attribute $required.");
                if (strlen($url) > COMMENT_MAX_URL)
                    throw new CommentRefused('url-too-long', 'A URL is longer than ' . COMMENT_MAX_URL . ' characters.');
                if (!isCommentUrl($url))
                    throw new CommentRefused('invalid-url', 'Only absolute http and https URLs are allowed: “' . mb_substr($url, 0, 80) . '”.');
            }
            if ($name === 'a')
                $linkText = '';
            if (!in_array($name, COMMENT_VOID, true))
                $stack[] = $name;
            $out[] = ['open', $name, $attrs];
        }
    }
    if ($stack)
        throw new CommentRefused('malformed-html', '<' . end($stack) . '> is not closed.');
    return $out;
}

/** The bare URL at the start of `raw` (encoded text), without what follows it: an entity of a delimiter, or punctuation. */
function commentUrlEnd(string $raw): string
{
    $url = preg_replace('/&(?:lt|gt|quot|apos|#\d+|#x[0-9a-f]+);.*$/is', '', $raw);
    do {
        $before = $url;
        $url = rtrim($url, ".,:;!?'*_~");
        if (str_ends_with($url, ')') && substr_count($url, '(') < substr_count($url, ')'))
            $url = substr($url, 0, -1);
    } while ($url !== $before);
    return $url;
}

/** Turns bare http(s) URLs in the text into links, except inside links, code and pre. URLs that break the rules stay text. */
function commentAutoLink(array $tokens): array
{
    $out = [];
    $shielded = 0;
    foreach ($tokens as $t) {
        if ($t[0] !== 'text') {
            if (in_array($t[1], ['a', 'code', 'pre'], true))
                $shielded += $t[0] === 'open' ? 1 : -1;
            $out[] = $t;
            continue;
        }
        $raw = $t[1];
        $pos = 0;
        if (!$shielded && preg_match_all('/(?<![\p{L}\p{N}_\/])https?:\/\/[^\s<>"]+/iu', $raw, $all, PREG_OFFSET_CAPTURE))
            foreach ($all[0] as [$match, $at]) {
                if ($at < $pos)
                    continue;
                $url = commentUrlEnd($match);
                $href = commentDecode($url);
                if (!isCommentUrl($href))
                    continue;
                if ($at > $pos)
                    $out[] = ['text', substr($raw, $pos, $at - $pos)];
                array_push($out, ['open', 'a', ['href' => $href]], ['text', $url], ['close', 'a']);
                $pos = $at + strlen($url);
            }
        if ($pos < strlen($raw))
            $out[] = ['text', substr($raw, $pos)];
    }
    return $out;
}

/** The visible text (RFC-5 "Length"): entities decoded, block elements and `br` separate words, whitespace collapsed. */
function commentVisibleText(array $tokens): string
{
    $s = implode('', array_map(fn($t) => $t[0] === 'text' ? commentDecode($t[1]) : (in_array($t[1], COMMENT_INLINE, true) ? '' : ' '), $tokens));
    return trim(preg_replace('/\s+/u', ' ', $s));
}

function commentSerialize(array $tokens): string
{
    return trim(implode('', array_map(fn($t) => match ($t[0]) {
        'text' => $t[1],
        'close' => "</$t[1]>",
        default => "<$t[1]" . implode('', array_map(fn($k, $v) => " $k=\"" . commentEscape($v) . '"', array_keys($t[2]), $t[2])) . '>',
    }, $tokens)));
}

/**
 * Checks a comment (a post of feeds.php, or [markdown, html, text]) against RFC-5 and the policy's features and lengths.
 * Returns ['html' => normalized HTML, 'markdown' => the Markdown it came from or null, 'length' => of the visible text],
 * or ['code', 'text'] of the first problem. The first form present counts: Markdown, HTML, text.
 */
function commentContent(array $post, array $policy): array
{
    $markdown = trim($post['markdown'] ?? '') !== '' ? $post['markdown'] : null;
    $html = trim($post['html'] ?? '') !== '' ? $post['html'] : null;
    $source = trim($markdown ?? $html ?? $post['text'] ?? '');
    if ($source === '')
        return ['code' => 'empty-content', 'text' => 'The comment is empty.'];
    if (mb_strlen(scrub($source)) > $policy['maxLength'])
        return ['code' => 'too-long', 'text' => "The comment is longer than {$policy['maxLength']} characters."];
    try {
        $tokens = commentValidate(commentTokens($markdown !== null ? markdownHtml($markdown) : $html ?? textCommentHtml($source)), $policy);
        if ($policy['urlAutoLinking'] ?? false)
            $tokens = commentAutoLink($tokens);
        $length = mb_strlen(commentVisibleText($tokens));
        if (!$length && !array_filter($tokens, fn($t) => $t[0] === 'open' && $t[1] === 'img'))
            return ['code' => 'empty-content', 'text' => 'The comment is empty.'];
        if ($length < $policy['minLength'])
            return ['code' => 'too-short', 'text' => "The comment is shorter than {$policy['minLength']} characters."];
        return ['html' => commentSerialize($tokens), 'markdown' => $markdown, 'length' => $length];
    } catch (CommentRefused $e) {
        return ['code' => $e->reason, 'text' => $e->getMessage()];
    }
}
