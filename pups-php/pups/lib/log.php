<?php

namespace Pups;

/**
 * Transparent logging: one line per request, plus one line per event (logins, setup,
 * authorizations, tokens, uploads, revocations), in data/pups.log. The owner can read it on
 * the log page. Passwords and tokens are never logged; tokens appear as a fingerprint, the
 * first 8 characters of their SHA-256 hash, which is also the start of their key in
 * state.json. With PHP's built-in server, lines also go to the terminal.
 */
final class Log
{
    /** Longer values are cut in the log. */
    const MAX_VALUE_CHARS = 4096;
    /** The log is rotated to pups.log.1 at this size. */
    const MAX_BYTES = 5 * 1024 * 1024;

    public static ?string $file = null;
    public static bool $quiet = false;
    /** @var list<string> Lines logged in this request (tests read them). */
    public static array $lines = [];

    public static function file(string $dataDir): string
    {
        return "$dataDir/pups.log";
    }

    /**
     * Plain printable ASCII is written as it is; everything else is JSON-quoted, with control,
     * invisible and specials characters escaped, so that values from requests and fetched
     * documents can't inject lines or terminal escape sequences.
     */
    private static function format(mixed $v): string
    {
        $s = is_string($v) ? $v : (is_bool($v) ? ($v ? 'true' : 'false') : json_encode($v, JSON_FLAGS));
        if (strlen($s) > self::MAX_VALUE_CHARS)
            $s = substr($s, 0, self::MAX_VALUE_CHARS) . '…(' . (strlen($s) - self::MAX_VALUE_CHARS) . ' more bytes)';
        return preg_match('/^[\x21\x23-\x3c\x3e-\x7e]+$/D', $s) ? $s : escapeUnsafe(json_encode(scrub($s), JSON_FLAGS));
    }

    /** Logs an event: `<time> <event> key=value …`. Null values are left out. */
    public static function event(string $event, array $details = []): void
    {
        $line = gmdate('Y-m-d\TH:i:s') . sprintf('.%03dZ ', (int) (microtime(true) * 1000) % 1000) . $event;
        foreach ($details as $k => $v)
            if ($v !== null)
                $line .= ' ' . escapeUnsafe((string) $k) . '=' . self::format($v);
        self::$lines[] = $line;
        if (self::$quiet)
            return;
        if (PHP_SAPI === 'cli-server')
            file_put_contents('php://stderr', "$line\n");
        if (self::$file === null)
            return;
        if (@filesize(self::$file) > self::MAX_BYTES)
            @rename(self::$file, self::$file . '.1');
        @file_put_contents(self::$file, "$line\n", FILE_APPEND | LOCK_EX);
    }

    /** The last `n` lines of the log. */
    public static function tail(int $n): array
    {
        if (self::$file === null || !is_file(self::$file))
            return [];
        $f = fopen(self::$file, 'rb');
        $size = filesize(self::$file);
        fseek($f, max(0, $size - 512 * 1024));
        $lines = explode("\n", rtrim(stream_get_contents($f), "\n"));
        fclose($f);
        return array_slice($lines, -$n);
    }
}

/** A token's fingerprint: the first 8 characters of its hash, as in state.json. */
function fp(?string $token): ?string
{
    return $token === null ? null : substr(hashToken($token), 0, 8);
}
