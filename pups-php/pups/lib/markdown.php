<?php

namespace Pups;

/**
 * Comment Markdown (RFC-5): CommonMark with the tables and strikethrough of GitHub Flavored Markdown, raw HTML as
 * text, and no other extension. Renders like markdown-it (the TypeScript servers use it), which the tests compare it
 * with; commenthtml.php then checks the HTML. Not a complete CommonMark implementation: rare constructs (lazy setext
 * underlines, tabs inside container prefixes, link labels with nested brackets) may render differently, but the result
 * is always checked as Comment HTML, so a difference can only reject a comment or change its formatting.
 */

const MD_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const MD_MAX_NESTING = 20;

/** Escapes as markdown-it does: `&`, `<`, `>` and `"`. */
function mdEsc(string $s): string
{
    return str_replace(['&', '<', '>', '"'], ['&amp;', '&lt;', '&gt;', '&quot;'], $s);
}

function markdownHtml(string $md): string
{
    $md = str_replace(["\r\n", "\r", "\0"], ["\n", "\n", "\u{FFFD}"], scrub($md));
    $lines = array_map('Pups\mdExpandIndent', explode("\n", $md));
    $refs = [];
    $blocks = mdBlocks($lines, $refs, 0);
    return mdRenderBlocks($blocks, $refs, false);
}

// --- Blocks ------------------------------------------------------------------------------------

/** Replaces tabs in the indentation of a line with spaces (tab stops every 4 columns). */
function mdExpandIndent(string $line): string
{
    if (!preg_match('/^[ \t]+/', $line, $m) || !str_contains($m[0], "\t"))
        return $line;
    $out = '';
    foreach (str_split($m[0]) as $c)
        $out .= $c === "\t" ? str_repeat(' ', 4 - strlen($out) % 4) : ' ';
    return $out . substr($line, strlen($m[0]));
}

function mdIndent(string $line): int
{
    return strlen($line) - strlen(ltrim($line, ' '));
}

function mdBlank(string $line): bool
{
    return trim($line, " \t") === '';
}

/** A list marker at the start of a line: [type, start, width of marker and spaces, content] or null. */
function mdListMarker(string $line): ?array
{
    $ind = mdIndent($line);
    if ($ind > 3 || !preg_match('/^([*+-]|(\d{1,9})([.)]))([ \t]+|$)(.*)$/', substr($line, $ind), $m))
        return null;
    $marker = strlen($m[1]);
    $col = $ind + $marker;
    foreach (str_split($m[4]) as $c)
        $col += $c === "\t" ? 4 - $col % 4 : 1;
    $spaces = $col - $ind - $marker;
    $rest = $m[5];
    $type = $m[2] !== '' ? 'o' . $m[3] : 'u' . $m[1];
    if ($rest === '')
        $width = $marker + 1;
    elseif ($spaces >= 5) {
        $width = $marker + 1;
        $rest = str_repeat(' ', $spaces - 1) . $rest;
    } else
        $width = $marker + $spaces;
    return ['type' => $type, 'start' => $m[2] !== '' ? (int) $m[2] : null, 'indent' => $ind, 'width' => $ind + $width, 'content' => $rest];
}

function mdThematicBreak(string $line): bool
{
    return mdIndent($line) <= 3 && preg_match('/^ *(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/', $line) === 1;
}

function mdFence(string $line): ?array
{
    return preg_match('/^( {0,3})(`{3,}|~{3,})(.*)$/', $line, $m) && !($m[2][0] === '`' && str_contains($m[3], '`'))
        ? ['indent' => strlen($m[1]), 'fence' => $m[2], 'info' => trim($m[3])] : null;
}

function mdAtxHeading(string $line): ?array
{
    if (!preg_match('/^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/', $line, $m))
        return null;
    $text = preg_replace('/(?:^|[ \t]+)#+[ \t]*$/', '', rtrim($m[2] ?? '', " \t"));
    return ['level' => strlen($m[1]), 'text' => trim($text, " \t")];
}

/** The cells of a table row, split at unescaped pipes; an escaped pipe loses its backslash. */
function mdTableCells(string $line): array
{
    $line = trim($line, " \t");
    $cells = [];
    $cur = '';
    for ($i = 0, $n = strlen($line); $i < $n; $i++) {
        $c = $line[$i];
        if ($c === '\\' && $i + 1 < $n && $line[$i + 1] === '|') {
            $cur .= '|';
            $i++;
        } elseif ($c === '|') {
            $cells[] = $cur;
            $cur = '';
        } else
            $cur .= $c;
    }
    $cells[] = $cur;
    if ($line !== '' && $line[0] === '|')
        array_shift($cells);
    if (count($cells) && end($cells) === '' && str_ends_with($line, '|') && !str_ends_with($line, '\\|'))
        array_pop($cells);
    return array_map(fn($c) => trim($c, " \t"), $cells);
}

/** A table starting at line `i`: its header and alignments, or null. */
function mdTableStart(array $lines, int $i): ?array
{
    $head = $lines[$i] ?? null;
    $delim = $lines[$i + 1] ?? null;
    if ($head === null || $delim === null || str_starts_with($head, "\0") || str_starts_with($delim, "\0") || mdIndent($head) > 3 || mdIndent($delim) > 3 || !str_contains($head, '|'))
        return null;
    $d = ltrim($delim, ' ');
    if (!preg_match('/^[|:-][|:\- \t]*$/', $d) || ($d[0] === '-' && isset($d[1]) && ($d[1] === ' ' || $d[1] === "\t")) || strlen($d) < 2 && $d !== '-')
        return null;
    $aligns = [];
    foreach (mdTableCells($d) as $c) {
        if (!preg_match('/^(:)?-+(:)?$/', $c, $m))
            return null;
        $aligns[] = ($m[1] ?? '') !== '' ? (($m[2] ?? '') !== '' ? 'center' : 'left') : (($m[2] ?? '') !== '' ? 'right' : '');
    }
    $cells = mdTableCells($head);
    if (!$cells || count($cells) !== count($aligns))
        return null;
    return ['head' => $cells, 'aligns' => $aligns];
}

/** Does a line start a block that ends a paragraph? */
function mdInterruptsParagraph(array $lines, int $i): bool
{
    $line = $lines[$i];
    if (mdIndent($line) > 3)
        return false;
    $rest = ltrim($line, ' ');
    if ($rest === '' || mdThematicBreak($line) || mdFence($line) || mdAtxHeading($line) || $rest[0] === '>' || mdTableStart($lines, $i))
        return true;
    $li = mdListMarker($line);
    return $li && !mdBlank($li['content']) && ($li['start'] === null || $li['start'] === 1);
}

/** Does a line start a block that ends a table body or the lazy continuation of a quote? Any list item does. */
function mdEndsContainer(string $line): bool
{
    if (mdIndent($line) > 3)
        return false;
    $rest = ltrim($line, ' ');
    return $rest === '' || mdThematicBreak($line) || mdFence($line) || mdAtxHeading($line) || $rest[0] === '>' || mdListMarker($line);
}

/**
 * Parses lines into blocks. `refs` collects the link reference definitions. A block is
 * ['p', text] | ['h', level, text] | ['code', text, info] | ['hr'] | ['quote', blocks] | ['list', ordered, start, tight, items] | ['table', head, aligns, rows].
 * The result's key 'gap' says whether a blank line separates two of its blocks.
 */
function mdBlocks(array $lines, array &$refs, int $depth): array
{
    $out = [];
    $gap = false;
    $blankBefore = false;
    $n = count($lines);
    $i = 0;
    $push = function (array $b) use (&$out, &$gap, &$blankBefore) {
        if ($out && $blankBefore)
            $gap = true;
        $blankBefore = false;
        $out[] = $b;
    };
    while ($i < $n) {
        $line = $lines[$i];
        if (mdBlank($line)) {
            $blankBefore = true;
            $i++;
            continue;
        }
        $ind = mdIndent($line);
        if ($ind >= 4) {
            $code = [];
            while ($i < $n && (mdBlank($lines[$i]) || mdIndent($lines[$i]) >= 4)) {
                $l = $lines[$i++];
                $code[] = substr($l, min(4, strlen($l)));
            }
            while ($code && mdBlank(end($code)))
                array_pop($code);
            $push(['code', implode("\n", $code) . "\n", '']);
            continue;
        }
        if ($f = mdFence($line)) {
            $code = [];
            $closed = false;
            $i++;
            while ($i < $n) {
                $l = $lines[$i++];
                if ($closed = preg_match('/^ {0,3}(' . preg_quote($f['fence'][0], '/') . '{' . strlen($f['fence']) . ',})[ \t]*$/', $l) === 1)
                    break;
                $code[] = substr($l, min($f['indent'], mdIndent($l)));
            }
            // An unclosed fence runs to the end, without a line break after the last line.
            $push(['code', $code ? implode("\n", $code) . ($closed ? "\n" : '') : '', $f['info']]);
            continue;
        }
        if ($h = mdAtxHeading($line)) {
            $push(['h', $h['level'], $h['text']]);
            $i++;
            continue;
        }
        if (mdThematicBreak($line)) {
            $push(['hr']);
            $i++;
            continue;
        }
        $rest = ltrim($line, ' ');
        if ($rest[0] === '>' && $depth < MD_MAX_NESTING) {
            $inner = [];
            while ($i < $n) {
                $l = $lines[$i];
                if (mdIndent($l) <= 3 && ($t = ltrim($l, ' ')) !== '' && $t[0] === '>') {
                    $t = substr($t, 1);
                    $inner[] = mdExpandIndent(isset($t[0]) && $t[0] === ' ' ? substr($t, 1) : (isset($t[0]) && $t[0] === "\t" ? '  ' . substr($t, 1) : $t));
                    $i++;
                } elseif (!mdBlank($l) && $inner && !mdBlank(end($inner)) && !mdEndsContainer($l) && !mdTableStart($lines, $i) && mdOpenParagraph($inner)) {
                    $inner[] = mdLazy($l);
                    $i++;
                } else
                    break;
            }
            $push(['quote', mdBlocks($inner, $refs, $depth + 1)]);
            continue;
        }
        if (($li = mdListMarker($line)) && $depth < MD_MAX_NESTING) {
            [$list, $i] = mdList($lines, $i, $li, $refs, $depth);
            $push($list);
            continue;
        }
        if ($t = mdTableStart($lines, $i)) {
            $rows = [];
            $i += 2;
            while ($i < $n && mdIndent($lines[$i]) <= 3 && !mdEndsContainer($lines[$i]) && $lines[$i][0] !== "\0") {
                $cells = mdTableCells($lines[$i++]);
                $rows[] = array_map(fn($k) => $cells[$k] ?? '', array_keys($t['aligns']));
            }
            $push(['table', $t['head'], $t['aligns'], $rows]);
            continue;
        }
        // Link reference definitions, as markdown-it: a block of their own, which can't interrupt a paragraph.
        if ($rest[0] === '[') {
            $j = $i;
            while ($j < $n && !mdBlank($lines[$j]))
                $j++;
            $chunk = implode("\n", array_slice($lines, $i, $j - $i));
            $left = mdTakeReferences($chunk, $refs);
            if ($left !== $chunk) {
                $i = $left === '' ? $j : $i + substr_count(substr($chunk, 0, strlen($chunk) - strlen($left)), "\n");
                continue;
            }
        }
        // A paragraph or a setext heading.
        $para = [ltrim(ltrim($line, ' '), "\0")];
        $i++;
        $heading = null;
        while ($i < $n && !mdBlank($lines[$i])) {
            $l = $lines[$i];
            if ($l[0] === "\0") {
                $para[] = ltrim($l, "\0");
                $i++;
                continue;
            }
            if (mdIndent($l) <= 3 && preg_match('/^ {0,3}(=+|-+)[ \t]*$/', $l, $m)) {
                $heading = $m[1][0] === '=' ? 1 : 2;
                $i++;
                break;
            }
            if (mdInterruptsParagraph($lines, $i))
                break;
            $para[] = ltrim($l, ' ');
            $i++;
        }
        $text = implode("\n", $para);
        $push($heading === null ? ['p', rtrim($text, " \t")] : ['h', $heading, trim($text, " \t\n")]);
    }
    return $out + ['gap' => $gap];
}

/**
 * A lazy continuation line: paragraph text, whatever it looks like. It starts with NUL, which the
 * input never contains (markdownHtml() replaces it), so that parsing it again doesn't start a block.
 */
function mdLazy(string $line): string
{
    return "\0" . ltrim(ltrim($line, ' '), "\0");
}

/** Whether the last block of the lines would be a paragraph that a lazy line can continue. */
function mdOpenParagraph(array $lines): bool
{
    $refs = [];
    $blocks = mdBlocks($lines, $refs, 0);
    unset($blocks['gap']);
    $last = end($blocks);
    return $last ? mdLastIsParagraph($last) : false;
}

function mdLastIsParagraph(array $block): bool
{
    if ($block[0] === 'p')
        return true;
    $children = $block[0] === 'quote' ? $block[1] : ($block[0] === 'list' ? end($block[4]) : null);
    if (!is_array($children))
        return false;
    unset($children['gap']);
    $last = end($children);
    return $last ? mdLastIsParagraph($last) : false;
}

/** A list starting at line `i` with the marker `first`. Returns [block, next line]. */
function mdList(array $lines, int $i, array $first, array &$refs, int $depth): array
{
    $n = count($lines);
    $items = [];
    $tight = true;
    $li = $first;
    while (true) {
        $width = $li['width'];
        $item = [$li['content']];
        $startsBlank = mdBlank($li['content']);
        $i++;
        while ($i < $n) {
            $l = $lines[$i];
            if (mdBlank($l)) {
                if ($startsBlank && count($item) === 1)
                    break;
                $item[] = '';
                $i++;
                continue;
            }
            if (mdIndent($l) >= $width) {
                $item[] = substr($l, $width);
                $i++;
                continue;
            }
            // Lazy continuation of a paragraph.
            if (!mdBlank(end($item)) && !mdInterruptsParagraph($lines, $i) && !mdListMarker($l) && mdOpenParagraph($item)) {
                $item[] = mdLazy($l);
                $i++;
                continue;
            }
            break;
        }
        $trailing = 0;
        while (count($item) > 1 && mdBlank(end($item))) {
            array_pop($item);
            $trailing++;
        }
        $blocks = mdBlocks($startsBlank ? array_slice($item, 1) : $item, $refs, $depth + 1);
        if ($blocks['gap'])
            $tight = false;
        unset($blocks['gap']);
        $items[] = $blocks;
        $next = $i < $n ? mdListMarker($lines[$i]) : null;
        if (!$next || $next['type'] !== $first['type'] || mdThematicBreak($lines[$i]))
            break;
        if ($trailing)
            $tight = false;
        $li = $next;
    }
    // Blank lines before the next item; at the end of the list they don't count.
    return [['list', $first['start'] !== null, $first['start'], $tight, $items], $i];
}

/** Removes the link reference definitions at the start of a paragraph into `refs`; returns the rest. */
function mdTakeReferences(string $text, array &$refs): string
{
    while ($text !== '' && $text[0] === '[') {
        if (!preg_match('/^\[((?:[^\\\\\[\]]|\\\\.){0,999})\]:[ \t]*\n?[ \t]*(<(?:[^<>\n\\\\]|\\\\.)*>|[^\s<]\S*)/s', $text, $m) || trim($m[1]) === '')
            break;
        $dest = $m[2][0] === '<' ? substr($m[2], 1, -1) : $m[2];
        if ($m[2][0] !== '<' && !mdBalancedParens($dest))
            break;
        $rest = substr($text, strlen($m[0]));
        // An optional title after whitespace, then the end of the line.
        $title = null;
        if (preg_match('/^[ \t]*\n?[ \t]*("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|\((?:[^()\\\\]|\\\\.)*\))[ \t]*(?:\n|$)/s', $rest, $t)
            && preg_match('/^[ \t\n]/', $rest)) {
            $rest = substr($rest, strlen($t[0]));
            $title = mdUnescape(substr($t[1], 1, -1));
        } elseif (preg_match('/^[ \t]*(?:\n|$)/', $rest, $e))
            $rest = substr($rest, strlen($e[0]));
        else
            break;
        $label = mdNormalizeLabel($m[1]);
        $refs[$label] ??= ['href' => mdUnescape($dest), 'title' => $title];
        $text = $rest;
    }
    return $text;
}

function mdBalancedParens(string $s): bool
{
    $depth = 0;
    for ($i = 0, $n = strlen($s); $i < $n; $i++) {
        if ($s[$i] === '\\') {
            $i++;
            continue;
        }
        if ($s[$i] === '(' && ++$depth > 32)
            return false;
        if ($s[$i] === ')' && --$depth < 0)
            return false;
    }
    return $depth === 0;
}

function mdNormalizeLabel(string $label): string
{
    return mb_strtoupper(mb_strtolower(preg_replace('/\s+/u', ' ', trim($label))));
}

// --- Rendering -----------------------------------------------------------------------------------

function mdRenderBlocks(array $blocks, array $refs, bool $tight): string
{
    unset($blocks['gap']);
    $out = '';
    $prevHidden = false;
    foreach (array_values($blocks) as $b) {
        // As markdown-it: a line break between a hidden paragraph and a block other than code.
        if ($prevHidden && $b[0] !== 'p' && $b[0] !== 'code')
            $out .= "\n";
        $prevHidden = false;
        switch ($b[0]) {
            case 'p':
                if ($tight) {
                    $out .= mdInline($b[1], $refs);
                    $prevHidden = true;
                } else
                    $out .= '<p>' . mdInline($b[1], $refs) . "</p>\n";
                break;
            case 'h':
                $out .= "<h$b[1]>" . mdInline($b[2], $refs) . "</h$b[1]>\n";
                break;
            case 'hr':
                $out .= "<hr>\n";
                break;
            case 'code':
                $lang = $b[2] === '' ? '' : preg_split('/\s+/', mdUnescape($b[2]))[0];
                $out .= '<pre><code' . ($lang === '' ? '' : ' class="language-' . mdEsc($lang) . '"') . '>' . mdEsc($b[1]) . "</code></pre>\n";
                break;
            case 'quote':
                $inner = mdRenderBlocks($b[1], $refs, false);
                $out .= '<blockquote>' . ($inner === '' ? '' : "\n" . $inner) . "</blockquote>\n";
                break;
            case 'list':
                [, $ordered, $start, $listTight, $items] = $b;
                $tag = $ordered ? 'ol' : 'ul';
                $out .= "<$tag" . ($ordered && $start !== 1 ? " start=\"$start\"" : '') . ">\n";
                foreach ($items as $item) {
                    $inner = mdRenderBlocks($item, $refs, $listTight);
                    $first = array_values(array_filter($item, 'is_int', ARRAY_FILTER_USE_KEY))[0] ?? null;
                    $out .= '<li>' . ($inner === '' || ($listTight && $first && $first[0] === 'p') ? '' : "\n") . $inner . "</li>\n";
                }
                $out .= "</$tag>\n";
                break;
            case 'table':
                [, $head, $aligns, $rows] = $b;
                $cell = fn(string $tag, string $text, string $align) => "<$tag" . ($align === '' ? '' : " style=\"text-align:$align\"") . '>' . mdInline($text, $refs) . "</$tag>\n";
                $out .= "<table>\n<thead>\n<tr>\n" . implode('', array_map(fn($t, $a) => $cell('th', $t, $a), $head, $aligns)) . "</tr>\n</thead>\n";
                if ($rows)
                    $out .= "<tbody>\n" . implode('', array_map(fn($r) => "<tr>\n" . implode('', array_map(fn($t, $a) => $cell('td', $t, $a), $r, $aligns)) . "</tr>\n", $rows)) . "</tbody>\n";
                $out .= "</table>\n";
                break;
        }
    }
    return $out;
}

// --- Inlines -------------------------------------------------------------------------------------

/** Backslash escapes and entities, as in link destinations and info strings. */
function mdUnescape(string $s): string
{
    return preg_replace_callback('/\\\\([' . preg_quote(MD_PUNCT, '/') . '])|&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/',
        fn($m) => isset($m[2]) ? mdEntity($m[2]) ?? $m[0] : $m[1], $s);
}

/** The character of an entity (without & and ;), or null if it is none. */
function mdEntity(string $e): ?string
{
    if ($e[0] === '#') {
        $code = $e[1] === 'x' || $e[1] === 'X' ? hexdec(substr($e, 2)) : (int) substr($e, 1);
        $valid = !($code >= 0xD800 && $code <= 0xDFFF || $code >= 0xFDD0 && $code <= 0xFDEF || ($code & 0xFFFF) === 0xFFFF || ($code & 0xFFFE) === 0xFFFE
            || $code <= 8 || $code === 0x0B || $code >= 0x0E && $code <= 0x1F || $code >= 0x7F && $code <= 0x9F || $code > 0x10FFFF);
        return mb_chr($valid ? $code : 0xFFFD, 'UTF-8');
    }
    $c = html_entity_decode("&$e;", ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return $c === "&$e;" ? null : $c;
}

/** A link destination as markdown-it writes it: percent-encoded, existing escapes kept. */
function mdNormalizeUrl(string $url): string
{
    if (function_exists('idn_to_ascii') && preg_match('#^(https?://)([^/?\#:@]+)(.*)$#is', $url, $m) && preg_match('/[^\x00-\x7f]/', $m[2])) {
        $host = idn_to_ascii(strtolower($m[2]), IDNA_DEFAULT, INTL_IDNA_VARIANT_UTS46);
        if ($host !== false)
            $url = $m[1] . $host . $m[3];
    }
    return preg_replace_callback('/%[0-9a-fA-F]{2}|[^A-Za-z0-9;\/?:@&=+$,\-_.!~*\'()#%]|%/u',
        fn($m) => strlen($m[0]) === 3 && $m[0][0] === '%' ? $m[0] : strtoupper(rawurlencode($m[0])), $url);
}

function mdValidUrl(string $url): bool
{
    $u = strtolower(trim($url));
    return !preg_match('/^(vbscript|javascript|file|data):/', $u) || preg_match('/^data:image\/(gif|png|jpeg|webp);/', $u);
}

/**
 * Inline content as HTML. Nodes are objects: text (t = 'text', v), rendered HTML (t = 'html', v), and elements
 * (t = em, strong, s, a, img; c = children; href or src).
 */
function mdInline(string $text, array $refs): string
{
    $nodes = [];
    $delims = [];
    $brackets = [];
    $text = rtrim($text, " \t");
    $n = strlen($text);
    $buf = '';
    $flush = function () use (&$buf, &$nodes) {
        if ($buf !== '') {
            $nodes[] = (object) ['t' => 'text', 'v' => $buf];
            $buf = '';
        }
    };
    $i = 0;
    while ($i < $n) {
        $c = $text[$i];
        if ($c === '\\') {
            if ($i + 1 < $n && $text[$i + 1] === "\n") {
                $flush();
                $nodes[] = (object) ['t' => 'html', 'v' => "<br>\n"];
                $i += 2;
                while ($i < $n && $text[$i] === ' ')
                    $i++;
                continue;
            }
            if ($i + 1 < $n && str_contains(MD_PUNCT, $text[$i + 1])) {
                $buf .= $text[$i + 1];
                $i += 2;
                continue;
            }
            $buf .= '\\';
            $i++;
            continue;
        }
        if ($c === "\n") {
            $trail = strlen($buf) - strlen(rtrim($buf, ' '));
            $buf = rtrim($buf, ' ');
            $flush();
            $nodes[] = (object) ['t' => 'html', 'v' => $trail >= 2 ? "<br>\n" : "\n"];
            $i++;
            while ($i < $n && $text[$i] === ' ')
                $i++;
            continue;
        }
        if ($c === '`') {
            $run = strspn($text, '`', $i);
            $j = $i + $run;
            $found = null;
            while (($k = strpos($text, str_repeat('`', $run), $j)) !== false) {
                $len = strspn($text, '`', $k);
                if ($len === $run) {
                    $found = $k;
                    break;
                }
                $j = $k + $len;
            }
            if ($found === null) {
                $buf .= str_repeat('`', $run);
                $i += $run;
                continue;
            }
            $code = str_replace("\n", ' ', substr($text, $i + $run, $found - $i - $run));
            if (strlen($code) > 2 && $code[0] === ' ' && $code[-1] === ' ' && trim($code, ' ') !== '')
                $code = substr($code, 1, -1);
            $flush();
            $nodes[] = (object) ['t' => 'html', 'v' => '<code>' . mdEsc($code) . '</code>'];
            $i = $found + $run;
            continue;
        }
        if ($c === '&' && preg_match('/^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/', substr($text, $i, 40), $m) && ($e = mdEntity($m[1])) !== null) {
            $buf .= $e;
            $i += strlen($m[0]);
            continue;
        }
        if ($c === '<' && (preg_match('/^<([a-zA-Z][a-zA-Z0-9+.\-]{1,31}:[^<>\x00-\x20]*)>/', substr($text, $i), $m) && ($href = mdNormalizeUrl($m[1])) !== null
            || preg_match('/^<([a-zA-Z0-9.!#$%&\'*+\/=?^_`{|}~\-]+@[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*)>/', substr($text, $i), $m)
            && ($href = mdNormalizeUrl('mailto:' . $m[1])) !== null)) {
            if (mdValidUrl($href)) {
                $flush();
                $nodes[] = (object) ['t' => 'a', 'href' => $href, 'c' => [(object) ['t' => 'text', 'v' => $m[1]]]];
                $i += strlen($m[0]);
                continue;
            }
        }
        if ($c === '*' || $c === '_' || $c === '~') {
            $run = strspn($text, $c, $i);
            if ($c === '~' && $run < 2) {
                $buf .= str_repeat('~', $run);
                $i += $run;
                continue;
            }
            $before = $i > 0 ? mb_substr(substr($text, 0, $i), -1) : "\n";
            $after = $i + $run < $n ? mb_substr(substr($text, $i + $run), 0, 1) : "\n";
            $ws = fn($ch) => preg_match('/^[\s\x{00a0}\x{1680}\x{2000}-\x{200a}\x{202f}\x{205f}\x{3000}]$/u', $ch) === 1;
            $pu = fn($ch) => preg_match('/^[\p{P}\p{S}]$/u', $ch) === 1;
            $left = !$ws($after) && (!$pu($after) || $ws($before) || $pu($before));
            $right = !$ws($before) && (!$pu($before) || $ws($after) || $pu($after));
            $open = $c === '_' ? $left && (!$right || $pu($before)) : $left;
            $close = $c === '_' ? $right && (!$left || $pu($after)) : $right;
            $flush();
            $i += $run;
            // As markdown-it: a run of tildes is pairs, each a delimiter, after a single one if the run is odd. Delimiters of
            // one run never pair with each other.
            if ($c === '~') {
                $lone = null;
                if ($run % 2) {
                    $nodes[] = $lone = (object) ['t' => 'text', 'v' => '~'];
                    $run--;
                }
                for ($k = 0; $k < $run; $k += 2) {
                    $node = (object) ['t' => 'text', 'v' => '~~'];
                    $nodes[] = $node;
                    $delims[] = (object) ['ch' => '~', 'node' => $node, 'count' => 2, 'orig' => 2, 'open' => $open, 'close' => $close, 'run' => $i, 'lone' => $lone];
                }
            } else {
                $node = (object) ['t' => 'text', 'v' => str_repeat($c, $run)];
                $nodes[] = $node;
                $delims[] = (object) ['ch' => $c, 'node' => $node, 'count' => $run, 'orig' => $run, 'open' => $open, 'close' => $close, 'run' => $i, 'lone' => null];
            }
            continue;
        }
        if ($c === '[' || ($c === '!' && $i + 1 < $n && $text[$i + 1] === '[')) {
            $flush();
            $image = $c === '!';
            $node = (object) ['t' => 'text', 'v' => $image ? '![' : '['];
            $nodes[] = $node;
            $brackets[] = (object) ['node' => $node, 'image' => $image, 'active' => true, 'delims' => count($delims), 'pos' => $i + ($image ? 2 : 1)];
            $i += $image ? 2 : 1;
            continue;
        }
        if ($c === ']') {
            $flush();
            $opener = array_pop($brackets);
            if (!$opener || !$opener->active) {
                $buf .= ']';
                $i++;
                continue;
            }
            $label = substr($text, $opener->pos, $i - $opener->pos);
            [$dest, $end, $title] = mdLinkTail($text, $i + 1, $label, $refs);
            if ($dest === null) {
                $buf .= ']';
                $i++;
                continue;
            }
            $at = array_search($opener->node, $nodes, true);
            $children = array_slice($nodes, $at + 1);
            $inner = array_slice($delims, $opener->delims);
            $delims = array_slice($delims, 0, $opener->delims);
            $children = mdEmphasis($children, $inner);
            $nodes = array_slice($nodes, 0, $at);
            $nodes[] = $opener->image ? (object) ['t' => 'img', 'src' => $dest, 'title' => $title, 'c' => $children]
                : (object) ['t' => 'a', 'href' => $dest, 'title' => $title, 'c' => $children];
            if (!$opener->image)
                foreach ($brackets as $b)
                    if (!$b->image)
                        $b->active = false;
            $i = $end;
            continue;
        }
        $buf .= $c;
        $i++;
    }
    $flush();
    return mdRenderInline(mdEmphasis($nodes, $delims));
}

/**
 * What follows the `]` of a link at byte `pos`: an inline destination, or a reference. Returns
 * [normalized destination, position after the link, title] or [null, pos, null].
 */
function mdLinkTail(string $text, int $pos, string $label, array $refs): array
{
    $n = strlen($text);
    if ($pos < $n && $text[$pos] === '(') {
        $p = $pos + 1;
        $p += strspn($text, " \t\n", $p);
        $dest = '';
        $ok = true;
        if ($p < $n && $text[$p] === '<') {
            if (preg_match('/^<((?:[^<>\n\\\\]|\\\\.)*)>/', substr($text, $p), $m)) {
                $dest = $m[1];
                $p += strlen($m[0]);
            } else
                $ok = false;
        } else {
            $start = $p;
            $depth = 0;
            while ($p < $n) {
                $ch = $text[$p];
                if ($ch === '\\' && $p + 1 < $n && str_contains(MD_PUNCT, $text[$p + 1])) {
                    $p += 2;
                    continue;
                }
                if (ord($ch) <= 0x20 || ord($ch) === 0x7f)
                    break;
                if ($ch === '(' && ++$depth > 32)
                    break;
                if ($ch === ')' && $depth-- === 0)
                    break;
                $p++;
            }
            $dest = substr($text, $start, $p - $start);
            if ($depth > 0)
                $ok = false;
        }
        if ($ok) {
            $href = mdNormalizeUrl(mdUnescape($dest));
            if (mdValidUrl($href)) {
                $q = $p + strspn($text, " \t\n", $p);
                $title = null;
                if ($q > $p && $q < $n && preg_match('/^("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|\((?:[^()\\\\]|\\\\.)*\))/s', substr($text, $q), $m)) {
                    $title = mdUnescape(substr($m[0], 1, -1));
                    $q += strlen($m[0]) + strspn($text, " \t\n", $q + strlen($m[0]));
                }
                if ($q < $n && $text[$q] === ')')
                    return [$href, $q + 1, $title];
            }
        }
    }
    // A reference: full ([text][label]), collapsed ([text][]) or shortcut ([text]).
    $ref = null;
    $end = $pos;
    if ($pos < $n && $text[$pos] === '[' && preg_match('/^\[((?:[^\\\\\[\]]|\\\\.){0,999})\]/', substr($text, $pos), $m)) {
        $ref = trim($m[1]) === '' ? $label : $m[1];
        $end = $pos + strlen($m[0]);
    } else
        $ref = $label;
    $key = mdNormalizeLabel($ref);
    if (trim($ref) === '' || !isset($refs[$key]))
        return [null, $pos, null];
    $href = mdNormalizeUrl($refs[$key]['href']);
    return mdValidUrl($href) ? [$href, $end, $refs[$key]['title']] : [null, $pos, null];
}

/** Processes the delimiters (CommonMark "process emphasis") of the nodes; returns the nodes with em, strong and s. */
function mdEmphasis(array $nodes, array $delims): array
{
    $bottom = [];
    $k = 0;
    while ($k < count($delims)) {
        $closer = $delims[$k];
        if (!$closer->close) {
            $k++;
            continue;
        }
        $key = $closer->ch . ($closer->open ? '1' : '0') . ($closer->orig % 3);
        $found = -1;
        for ($j = $k - 1; $j >= ($bottom[$key] ?? 0); $j--) {
            $o = $delims[$j];
            if ($o->ch !== $closer->ch || !$o->open || $o->run === $closer->run)
                continue;
            if ($o->ch !== '~' && ($o->close || $closer->open) && ($o->orig + $closer->orig) % 3 === 0 && !($o->orig % 3 === 0 && $closer->orig % 3 === 0))
                continue;
            $found = $j;
            break;
        }
        if ($found < 0) {
            $bottom[$key] = $k;
            if (!$closer->open) {
                array_splice($delims, $k, 1);
                continue;
            }
            $k++;
            continue;
        }
        $opener = $delims[$found];
        $use = $closer->ch === '~' ? 2 : ($closer->count >= 2 && $opener->count >= 2 ? 2 : 1);
        $tag = $closer->ch === '~' ? 's' : ($use === 2 ? 'strong' : 'em');
        $opener->count -= $use;
        $closer->count -= $use;
        $opener->node->v = substr($opener->node->v, 0, strlen($opener->node->v) - $use);
        $closer->node->v = substr($closer->node->v, $use);
        $a = array_search($opener->node, $nodes, true);
        $b = array_search($closer->node, $nodes, true);
        $el = (object) ['t' => $tag, 'c' => array_slice($nodes, $a + 1, $b - $a - 1)];
        $after = [];
        // markdown-it moves the single tilde of an odd closing run after the </s>.
        if ($closer->lone && end($el->c) === $closer->lone)
            $after[] = array_pop($el->c);
        array_splice($nodes, $a + 1, $b - $a - 1, [$el, ...$after]);
        // Delimiters between them are done.
        array_splice($delims, $found + 1, $k - $found - 1);
        $k = $found + 1;
        if ($opener->count === 0) {
            array_splice($delims, $found, 1);
            $k--;
            array_splice($nodes, array_search($opener->node, $nodes, true), 1);
        }
        if ($closer->count === 0) {
            array_splice($delims, $k, 1);
            array_splice($nodes, array_search($closer->node, $nodes, true), 1);
        }
    }
    return $nodes;
}

function mdRenderInline(array $nodes): string
{
    $out = '';
    foreach ($nodes as $node)
        $out .= match ($node->t) {
            'text' => mdEsc($node->v),
            'html' => $node->v,
            'a' => '<a href="' . mdEsc($node->href) . '"' . mdTitle($node) . '>' . mdRenderInline($node->c) . '</a>',
            'img' => '<img src="' . mdEsc($node->src) . '" alt="' . mdEsc(mdPlainText($node->c)) . '"' . mdTitle($node) . '>',
            default => "<{$node->t}>" . mdRenderInline($node->c) . "</{$node->t}>",
        };
    return $out;
}

function mdTitle(object $node): string
{
    return ($node->title ?? '') === '' ? '' : ' title="' . mdEsc($node->title) . '"';
}

/** The text of nodes, for the alt text of images. */
function mdPlainText(array $nodes): string
{
    $out = '';
    foreach ($nodes as $node)
        $out .= match ($node->t) {
            'text' => $node->v,
            'html' => str_starts_with($node->v, '<code>') ? html_entity_decode(strip_tags($node->v), ENT_QUOTES | ENT_HTML5, 'UTF-8') : "\n",
            default => mdPlainText($node->c),
        };
    return $out;
}
