<?php

namespace Pups;

/**
 * The fixed allowlist of RFC-6 "File types". The extension decides the type:
 * extension => [type it is served with, accepted upload Content-Types, text (UTF-8, charset=utf-8)].
 */
const FILE_TYPES = [
    'json' => ['application/json', ['application/json', 'application/feed+json'], true],
    'xml' => ['application/xml', ['application/xml', 'text/xml', 'application/rss+xml', 'application/atom+xml'], true],
    'opml' => ['text/x-opml', ['text/x-opml', 'application/xml', 'text/xml'], true],
    'md' => ['text/markdown', ['text/markdown', 'text/x-markdown'], true],
    'txt' => ['text/plain', ['text/plain'], true],
    'csv' => ['text/csv', ['text/csv'], true],
    'vcf' => ['text/vcard', ['text/vcard', 'text/x-vcard'], true],
    'svg' => ['image/svg+xml', ['image/svg+xml'], true],
    'png' => ['image/png', ['image/png'], false],
    'jpg' => ['image/jpeg', ['image/jpeg'], false],
    'jpeg' => ['image/jpeg', ['image/jpeg'], false],
    'gif' => ['image/gif', ['image/gif'], false],
    'webp' => ['image/webp', ['image/webp'], false],
    'avif' => ['image/avif', ['image/avif'], false],
    'mp3' => ['audio/mpeg', ['audio/mpeg'], false],
    'm4a' => ['audio/mp4', ['audio/mp4', 'audio/x-m4a'], false],
    'ogg' => ['audio/ogg', ['audio/ogg', 'audio/opus'], false],
    'opus' => ['audio/ogg', ['audio/ogg', 'audio/opus'], false],
    'mp4' => ['video/mp4', ['video/mp4', 'audio/mp4'], false],
    'webm' => ['video/webm', ['video/webm', 'audio/webm'], false],
];

/**
 * Never accepted anywhere, in any position of the file name: web content and
 * server-executable or server-config files. The allowlist already excludes them as the
 * final extension; this list catches `feed.php.json`, which Apache's mod_mime would execute.
 */
const BLOCKED_EXTENSIONS = [
    'html', 'htm', 'xhtml', 'js', 'mjs', 'css',
    'php', 'phtml', 'php3', 'php4', 'php5', 'php6', 'php7', 'php8', 'phar', 'pht', 'phps', 'inc',
    'jsp', 'jspx', 'asp', 'aspx', 'cgi', 'pl', 'py', 'rb', 'sh', 'shtml', 'htaccess', 'htpasswd', 'ini',
];

function extensions(string $path): array
{
    return array_slice(explode('.', strtolower(substr($path, strrpos($path, '/') + 1))), 1);
}

/** The file type for a path, or null if its extension is not allowed. */
function fileType(string $path): ?array
{
    $exts = extensions($path);
    $last = end($exts);
    if (!$last || array_intersect($exts, BLOCKED_EXTENSIONS) || !isset(FILE_TYPES[$last]))
        return null;
    return FILE_TYPES[$last];
}

/** The Content-Type a file is served with. */
function servedType(array $t): string
{
    return $t[2] ? "$t[0]; charset=utf-8" : $t[0];
}

/** Checks the extension and the upload's Content-Type. Throws 415. */
function checkUploadType(string $path, ?string $contentType): array
{
    $t = fileType($path);
    if (!$t) {
        $blocked = array_values(array_intersect(extensions($path), BLOCKED_EXTENSIONS));
        throw new HttpError(415, 'unsupported_type', $blocked
            ? "Files with the extension .$blocked[0] are never accepted, in any position of the name"
            : 'The file extension is not on the allowlist');
    }
    $media = strtolower(trim(explode(';', $contentType ?? '')[0]));
    if (!in_array($media, $t[1], true))
        throw new HttpError(415, 'unsupported_type', 'Content-Type must be one of: ' . implode(', ', $t[1]));
    return $t;
}
