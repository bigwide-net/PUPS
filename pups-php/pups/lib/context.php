<?php

namespace Pups;

/** Everything the handlers share. */
final class Ctx
{
    public State $state;
    public FileStore $files;
    public ClientLoader $clients;
    /** @var callable(string): array GET for webmention sources and targets: ['status', 'headers', 'body'] */
    public $http;
    /** @var callable(string, array, string): array POST to the auto-moderation model (moderation.php): url, headers, body → ['status', 'body'] */
    public $llm;
    /** Set when a webmention was queued: run() works through the queue after the response. */
    public bool $workPending = false;

    /**
     * @param ?callable $fetch replaces the HTTPS fetch of client metadata documents (tests)
     * @param ?callable $clock milliseconds since the epoch (tests move it forward)
     * @param ?callable $http replaces the fetch of webmention sources and targets (tests)
     */
    public function __construct(public Config $config, ?callable $fetch = null, ?callable $clock = null, ?callable $http = null)
    {
        prepareDataDir($config->dataDir);
        $this->state = new State($config->dataDir, $clock ?? fn() => (int) floor(microtime(true) * 1000));
        $this->files = new FileStore("$config->dataDir/files");
        $this->clients = new ClientLoader($config, $this->state, $fetch);
        $this->http = $http ?? httpFetch($config);
        $this->llm = moderationHttp($config);
    }

    public function now(): int
    {
        return $this->state->now();
    }
}

/**
 * Creates the data directory with .htaccess files that keep the web server out, in case it
 * lies in the web root and the rewrite to index.php ever stops working (RFC-6 "Serving files").
 */
function prepareDataDir(string $dir): void
{
    if (is_file("$dir/.htaccess"))
        return;
    if (!is_dir($dir) && !@mkdir($dir, 0755, true) && !is_dir($dir))
        throw new \RuntimeException("Cannot create the data directory $dir. Create it and make it writable for PHP.");
    @mkdir("$dir/files", 0755);
    $deny = "# Written by PUPS. Nothing in here is ever served directly; index.php serves the uploads.\n"
        . "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n"
        . "<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n";
    // No script handlers for uploads, wherever the server supports switching them off.
    $files = $deny . "<IfModule mod_mime.c>\n    RemoveHandler .php .phtml .php3 .php4 .php5 .php7 .php8 .phar .pht .phps .cgi .pl .py .shtml\n"
        . "    RemoveType .php .phtml .php3 .php4 .php5 .php7 .php8 .phar .pht .phps\n</IfModule>\n"
        . "<IfModule mod_php.c>\n    php_flag engine off\n</IfModule>\n<IfModule mod_php7.c>\n    php_flag engine off\n</IfModule>\n";
    @file_put_contents("$dir/files/.htaccess", $files);
    @file_put_contents("$dir/index.html", '');
    if (@file_put_contents("$dir/.htaccess", $deny) === false)
        throw new \RuntimeException("The data directory $dir is not writable for PHP.");
}
