<?php

namespace Pups;

/** Files up to this size get a content hash as ETag; larger ones a hash of size, mtime and inode. */
const CONTENT_ETAG_MAX = 1024 * 1024;

/**
 * Uploaded files on disk: storage path `/a/b.json` is `<root>/a/b.json`. Paths are validated
 * before they get here; this class also makes sure that no symbolic link leads out of the
 * root. Writes go to a temp file first, then are renamed into place.
 */
final class FileStore
{
    public string $root;
    private string $realRoot;

    public function __construct(string $root)
    {
        if (!is_dir($root) && !@mkdir($root, 0755, true) && !is_dir($root))
            throw new \RuntimeException("Cannot create the storage directory $root");
        $this->root = $root;
        $this->realRoot = realpath($root);
    }

    /** The absolute file name of a storage path, after checking that it stays inside the root. */
    public function abs(string $storagePath): string
    {
        $abs = $this->root . $storagePath;
        $existing = $abs;
        while (!file_exists($existing) && $existing !== $this->root)
            $existing = dirname($existing);
        $real = realpath($existing);
        if ($real === false || ($real !== $this->realRoot && !str_starts_with($real, $this->realRoot . DIRECTORY_SEPARATOR)))
            throw new \RuntimeException("Storage path leads out of the storage directory: $storagePath");
        return $abs;
    }

    /** ['abs', 'size', 'mtime', 'etag'] of a regular file, or null. */
    public function stat(string $storagePath): ?array
    {
        $abs = $this->abs($storagePath);
        clearstatcache(true, $abs);
        if (!is_file($abs) || is_link($abs))
            return null;
        $st = stat($abs);
        return ['abs' => $abs, 'size' => $st['size'], 'mtime' => $st['mtime'], 'etag' => etag($abs, $st)];
    }

    public function read(string $storagePath): ?string
    {
        $info = $this->stat($storagePath);
        return $info ? file_get_contents($info['abs']) : null;
    }

    /** A temp file in the storage root for an upload; its name starts with a dot, so the API can never reach it. */
    public function tempFile(): string
    {
        $dir = "$this->root/.pups-tmp";
        if (!is_dir($dir))
            @mkdir($dir, 0755, true);
        // Leftovers of crashed requests.
        foreach (glob("$dir/*.tmp") ?: [] as $f)
            if (@filemtime($f) < time() - 3600)
                @unlink($f);
        return "$dir/" . randomToken(9) . '.tmp';
    }

    /** Moves a temp file into place and returns the new ETag. Throws 409 if a directory is in the way. */
    public function commit(string $storagePath, string $tmp): string
    {
        $abs = $this->abs($storagePath);
        $dir = dirname($abs);
        if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir))
            throw new HttpError(409, 'conflict', 'A file is in the way of a folder of this path');
        if (is_dir($abs))
            throw new HttpError(409, 'conflict', 'A folder exists at this path');
        @chmod($tmp, 0644);
        if (!rename($tmp, $abs))
            throw new \RuntimeException("Cannot write $abs");
        return $this->stat($storagePath)['etag'];
    }

    /** Writes a small file (host-meta.json) and returns the new ETag. */
    public function write(string $storagePath, string $content): string
    {
        $tmp = $this->tempFile();
        file_put_contents($tmp, $content);
        return $this->commit($storagePath, $tmp);
    }

    public function delete(string $storagePath): void
    {
        unlink($this->abs($storagePath));
    }

    /** Deletes a whole directory, e.g. an app's `/appdata/<client-host>/`. Returns the number of files deleted. */
    public function deleteDir(string $storagePath): int
    {
        $abs = rtrim($this->abs($storagePath), '/');
        if (!is_dir($abs) || is_link($abs))
            return 0;
        $n = 0;
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($abs, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $f) {
            if ($f->isDir() && !$f->isLink())
                rmdir($f->getPathname());
            else {
                unlink($f->getPathname());
                $n++;
            }
        }
        rmdir($abs);
        return $n;
    }

    /** Bytes stored, without PUPS's own files (lock, temp files, .htaccess). */
    public function used(): int
    {
        $sum = 0;
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($this->root, \FilesystemIterator::SKIP_DOTS));
        foreach ($it as $f) {
            $rel = substr($f->getPathname(), strlen($this->root) + 1);
            if ($f->isFile() && !str_starts_with($rel, '.pups-') && $rel !== '.htaccess')
                $sum += $f->getSize();
        }
        return $sum;
    }

    /**
     * Runs `fn` while holding the storage lock, so that a precondition check and the write
     * that follows can't be interleaved with another request.
     */
    public function locked(callable $fn): mixed
    {
        $lock = fopen("$this->root/.pups-lock", 'c');
        if (!$lock || !flock($lock, LOCK_EX))
            throw new \RuntimeException('Cannot lock the storage directory');
        try {
            return $fn();
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}

/** A quoted strong ETag: the SHA-256 of the content, or for large files of size, mtime and inode. */
function etag(string $abs, array $st): string
{
    return '"' . ($st['size'] <= CONTENT_ETAG_MAX ? b64url(hash_file('sha256', $abs, true)) : sha256("$st[size]-$st[mtime]-$st[ino]")) . '"';
}
