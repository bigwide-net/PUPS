<?php

namespace Pups;

/**
 * The text of incoming posts (RFC-11 mentions, RFC-4 comments): their visible text, the
 * handles in it, excerpts, and the small HTML subset that the inbox stores. Posts come from
 * strangers: nothing here keeps markup or URLs that aren't on the allowlist.
 */

/** Elements that separate words: their start and end count as whitespace in the visible text. */
const BLOCK_TAGS = ['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul'];
/** Elements whose content is never shown. */
const HIDDEN_TAGS = ['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'head', 'title', 'select', 'textarea', 'button'];
/** What inbox items keep of a post's HTML; everything else is unwrapped or, for HIDDEN_TAGS, dropped. */
const INBOX_TAGS = ['p', 'br', 'a', 'strong', 'b', 'em', 'i', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'del', 's'];

/**
 * A handle (RFC-11 "Handles"): `@` and a host name of at least two labels, the last one
 * starting with a letter. Before it: the start, whitespace, or punctuation other than
 * `. _ - + / @` (no e-mail addresses). After it: the end, whitespace, or punctuation other
 * than `- _ / @`, where a `.` ends the handle unless a letter or digit follows (no fediverse
 * addresses, no paths).
 */
const HANDLE_RE = '/(?:^|(?<=[\s\p{P}\p{S}]))(?<![._\-+\/@])@((?:[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?\.)+\p{L}(?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?)(?![\p{L}\p{M}\p{N}_\-\/@]|\.[\p{L}\p{N}])/u';

/** Parses an HTML fragment. Returns its body element, or null if there is nothing. */
function htmlBody(string $html): ?\DOMElement
{
    if (trim($html) === '')
        return null;
    $doc = new \DOMDocument();
    $prev = libxml_use_internal_errors(true);
    $doc->loadHTML('<?xml encoding="UTF-8"><!DOCTYPE html><html><body>' . scrub($html) . '</body></html>', LIBXML_NONET | LIBXML_NOERROR | LIBXML_NOWARNING);
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    return $doc->getElementsByTagName('body')->item(0);
}

/** Collapses whitespace and removes unsafe characters. */
function normalizeSpace(string $s): string
{
    return trim(preg_replace('/\s+/u', ' ', preg_replace('/' . UNSAFE . '/u', ' ', scrub($s))));
}

/** The visible text of HTML. `skipCode` leaves out `code` and `pre`, as handles there don't count. */
function visibleText(string $html, bool $skipCode = false): string
{
    $body = htmlBody($html);
    if (!$body)
        return '';
    $out = '';
    $walk = function (\DOMNode $n) use (&$walk, &$out, $skipCode) {
        foreach ($n->childNodes as $c) {
            if ($c instanceof \DOMText)
                $out .= $c->data;
            elseif ($c instanceof \DOMElement) {
                $tag = strtolower($c->tagName);
                $block = in_array($tag, BLOCK_TAGS, true);
                $out .= $block ? ' ' : '';
                if (!in_array($tag, HIDDEN_TAGS, true) && !($skipCode && ($tag === 'code' || $tag === 'pre')))
                    $walk($c);
                elseif ($skipCode)
                    $out .= ' ';
                $out .= $block ? ' ' : '';
            }
        }
    };
    $walk($body);
    return normalizeSpace($out);
}

/** A host name in the form handles are compared in: lowercase ASCII (IDNA). Null if it can't be converted. */
function asciiHost(string $host): ?string
{
    $host = mb_strtolower($host, 'UTF-8');
    if (preg_match('/^[\x21-\x7e]+$/', $host))
        return $host;
    $ascii = function_exists('idn_to_ascii') ? idn_to_ascii($host, IDNA_DEFAULT, INTL_IDNA_VARIANT_UTS46) : false;
    return is_string($ascii) && $ascii !== '' ? strtolower($ascii) : null;
}

/** The hosts of all handles in a text, in comparable form. */
function handles(string $text): array
{
    preg_match_all(HANDLE_RE, $text, $m);
    return array_values(array_unique(array_filter(array_map(fn($h) => asciiHost($h), $m[1]))));
}

/** The host of an account like `@alice.example.com`, in comparable form, or null. */
function accountHost(?string $account): ?string
{
    return is_string($account) && preg_match('/^@([^@\s\/]+)$/u', trim($account), $m) ? asciiHost($m[1]) : null;
}

/** The text in which handles are found: the title and the visible text, without code. */
function handleText(array $item): string
{
    $body = $item['html'] !== null ? visibleText($item['html'], true) : normalizeSpace($item['text'] ?? $item['markdown'] ?? '');
    return trim(($item['title'] ?? '') . ' ' . $body);
}

/** The plain text of a post, for excerpts and length rules: Markdown is preferred, as in RFC-4. */
function plainText(array $item): string
{
    return $item['markdown'] !== null ? normalizeSpace($item['markdown'])
        : ($item['html'] !== null ? visibleText($item['html']) : normalizeSpace($item['text'] ?? ''));
}

/** Plain text as HTML paragraphs. */
function textHtml(string $text): string
{
    $paragraphs = array_filter(array_map('trim', preg_split('/\R{2,}/u', scrub($text))), fn($p) => $p !== '');
    return implode('', array_map(fn($p) => '<p>' . nl2br(h(preg_replace('/' . UNSAFE . '/u', '', $p)), false) . '</p>', $paragraphs));
}

/**
 * A post's HTML, reduced to INBOX_TAGS. Links keep only an http(s) `href`; every other
 * attribute is dropped. Readers sanitize it once more (RFC-2); this is a second line.
 */
function inboxHtml(string $html): string
{
    $body = htmlBody($html);
    if (!$body)
        return '';
    $walk = function (\DOMNode $n) use (&$walk): string {
        $out = '';
        foreach ($n->childNodes as $c) {
            if ($c instanceof \DOMText)
                $out .= h(preg_replace('/' . UNSAFE . '/u', '', $c->data));
            elseif ($c instanceof \DOMElement) {
                $tag = strtolower($c->tagName);
                if (in_array($tag, HIDDEN_TAGS, true))
                    continue;
                if (!in_array($tag, INBOX_TAGS, true)) {
                    $out .= $walk($c);
                    continue;
                }
                if ($tag === 'br') {
                    $out .= '<br>';
                    continue;
                }
                $href = $tag === 'a' ? $c->getAttribute('href') : '';
                $open = $tag === 'a' ? (preg_match('#^https?://#i', $href) && isCleanUrlString($href) ? '<a href="' . h($href) . '">' : '') : "<$tag>";
                $out .= $open . $walk($c) . ($open === '' ? '' : "</$tag>");
            }
        }
        return $out;
    };
    return $walk($body);
}

/** The HTML that an inbox item shows of a post: its own HTML, else its Markdown or text as paragraphs. */
function postHtml(array $item): string
{
    return $item['html'] !== null ? inboxHtml($item['html']) : textHtml($item['markdown'] ?? $item['text'] ?? '');
}
