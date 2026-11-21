<?php

namespace Pups;

const VERSION = '0.1.0';
const SPEC_VERSION = '0.1';
/** Link relation of the configuration document in host-meta.json (placeholder, see RFC-6). */
const PUPS_REL = 'https://bigwide.net/ns/personal-storage';
/** Ownership marker property on links that PUPS added for an app. */
const PUPS_CLIENT_PROP = 'https://bigwide.net/ns/pups#client';
const PUPS_PROP_PREFIX = 'https://bigwide.net/ns/pups#';
const CONFIG_PATH = '/personal-storage.json';
const HOST_META_PATH = '/.well-known/host-meta.json';
const OAUTH_METADATA_PATH = '/.well-known/oauth-authorization-server';
const MIN_SETUP_SECRET = 16;
/** The owner's inbox (RFC-12), written by the built-in mention and comment receiver. */
const INBOX_PATH = '/pups/private/inbox.json';

/** Files under /.well-known/ that may never be declared as well-known paths. */
const FORBIDDEN_WELL_KNOWN = [
    'host-meta', 'host-meta.json', 'webfinger', 'oauth-authorization-server', 'openid-configuration',
    'security.txt', 'change-password', 'oauth-protected-resource', 'did.json', 'nodeinfo',
    'apple-app-site-association', 'assetlinks.json', 'mta-sts.txt', 'openpgpkey', 'acme-challenge',
    // cPanel's AutoSSL proves domain control here.
    'pki-validation',
];

/**
 * The configuration: config.php (see config.example.php), plus what the setup checks
 * detected (data/detected.json). All URLs derive from the origin and the base path.
 */
final class Config
{
    /** `https://alice.example`: the owner's domain as an origin. */
    public string $origin;
    /** Host of the owner's domain (with port only if it isn't the default one). */
    public string $host;
    /** `https://alice.example/`: the owner's identity, returned as `me`. */
    public string $me;
    /** OAuth issuer. Same-domain mode only, so it is the origin. */
    public string $issuer;
    /** '' if PUPS is installed at the domain root, else its folder, e.g. `/pups`. */
    public string $basePath;
    /** origin + base path: where the endpoints live. */
    public string $base;
    public string $storageBase;
    public string $publicBase;
    public string $configUrl;
    public string $dataDir;
    public string $setupSecret;
    public int $maxUploadBytes;
    public int $maxStorageBytes;
    public int $writesPerMinute;
    /**
     * The declared well-known paths. `path`, `url`, `rels`, `properties` and `linkProperties` (the
     * properties apps may set on their links) are published in the configuration document;
     * `singleRels`, `urlProperties` and `description` (the consent text) stay on the server.
     * @var list<array{path: string, url: ?string, rels: list<string>, properties: list<string>, linkProperties: list<string>, singleRels: list<string>, urlProperties: list<string>, description: ?string}>
     */
    public array $wellKnown;
    /** Receive mentions (RFC-11) at /pups/mention and write them into the inbox. */
    public bool $mentions;
    /** Receive comments on the owner's feeds (RFC-4) at /pups/comments and write them into the inbox. */
    public bool $comments;
    /** Declare `post_endpoint`: from config.php, else from the setup checks. */
    public bool $postFallback;
    /** Whether post_fallback came from the setup checks rather than config.php. */
    public bool $postFallbackDetected;
    public bool $allowPrivateClients;
    public bool $allowHttp;
    public ?string $extraCa;
    /** WebAuthn relying party ID: the owner's host without port. */
    public string $rpId;

    /** Builds the configuration. Throws \InvalidArgumentException on errors. */
    public static function fromArray(array $c, array $detected = [], string $detectedBasePath = ''): self
    {
        $x = new self();
        $x->allowHttp = ($c['allow_http'] ?? false) === true;
        $origin = $c['origin'] ?? '';
        if (!is_string($origin) || !preg_match('#^(https?)://([a-z0-9.-]+|\[[0-9a-f:]+\])(:\d{1,5})?$#D', $origin, $m))
            throw new \InvalidArgumentException("'origin' must be an origin like https://alice.example, lowercase, without path or trailing slash");
        if ($m[1] !== 'https' && !$x->allowHttp)
            throw new \InvalidArgumentException("'origin' must use https (for local tests, set 'allow_http' => true)");
        if (($m[1] === 'https' && ($m[3] ?? '') === ':443') || ($m[1] === 'http' && ($m[3] ?? '') === ':80'))
            throw new \InvalidArgumentException("'origin' must not contain the default port");
        // .example is reserved for documentation (RFC 2606): config.php was copied without filling it in.
        if (str_ends_with($m[2], '.example'))
            throw new \InvalidArgumentException("'origin' is still the example domain, $origin. Set it in config.php to your own domain, e.g. https://yourname.com");
        $x->origin = $origin;
        $x->host = $m[2] . ($m[3] ?? '');
        $x->rpId = trim($m[2], '[]');
        $x->me = "$origin/";
        $x->issuer = $origin;

        $bp = $c['base_path'] ?? null;
        $bp = $bp === null ? $detectedBasePath : $bp;
        if (!is_string($bp) || !preg_match('#^(/[A-Za-z0-9._~-]+)*$#D', $bp) || preg_match('#/\.\.?(/|$)#', $bp))
            throw new \InvalidArgumentException("'base_path' must be '' or a folder like '/pups', without trailing slash");
        $x->basePath = $bp;
        $x->base = $origin . $bp;
        $x->storageBase = $x->base . '/';
        $pb = $c['public_base'] ?? null;
        $x->publicBase = is_string($pb) && $pb !== '' ? rtrim($pb, '/') . '/' : $x->storageBase;
        $x->configUrl = $x->base . CONFIG_PATH;

        $dataDir = $c['data_dir'] ?? null;
        if (!is_string($dataDir) || $dataDir === '')
            throw new \InvalidArgumentException("'data_dir' must be set");
        $x->dataDir = rtrim($dataDir, '/\\');
        $secret = $c['setup_secret'] ?? '';
        $x->setupSecret = is_string($secret) ? $secret : '';
        $x->maxUploadBytes = self::int($c, 'max_upload_bytes', 26214400);
        $x->maxStorageBytes = self::int($c, 'max_storage_bytes', 0);
        $x->writesPerMinute = self::int($c, 'writes_per_minute', 120);
        $x->mentions = self::bool($c, 'mentions', true);
        $x->comments = self::bool($c, 'comments', true);
        $x->wellKnown = parseWellKnown($c['well_known_paths'] ?? null, $origin, $bp);
        // The receiver writes the inbox, so readers must be able to ask for it.
        if (($x->mentions || $x->comments) && !in_array(INBOX_PATH, array_column($x->wellKnown, 'path'), true))
            $x->wellKnown = [...$x->wellKnown, ...parseWellKnown([inboxWellKnown()], $origin, $bp)];
        $pf = $c['post_fallback'] ?? null;
        $x->postFallbackDetected = !is_bool($pf);
        $x->postFallback = is_bool($pf) ? $pf : ($detected['post_fallback'] ?? false) === true;
        $x->allowPrivateClients = ($c['allow_private_clients'] ?? false) === true;
        $ca = $c['extra_ca'] ?? null;
        if ($ca !== null && (!is_string($ca) || !is_file($ca)))
            throw new \InvalidArgumentException("'extra_ca' must be the path of a PEM file");
        $x->extraCa = $ca;
        return $x;
    }

    private static function bool(array $c, string $key, bool $default): bool
    {
        $v = $c[$key] ?? null;
        if ($v !== null && !is_bool($v))
            throw new \InvalidArgumentException("'$key' must be true or false");
        return $v ?? $default;
    }

    private static function int(array $c, string $key, int $default): int
    {
        $v = $c[$key] ?? null;
        if ($v === null)
            return $default;
        if (!is_int($v) || $v < 0)
            throw new \InvalidArgumentException("'$key' must be a number of at least 0");
        return $v;
    }

    /** A path of the server's own endpoints, relative to the domain root (for links in pages). */
    public function path(string $p): string
    {
        return $this->basePath . $p;
    }
}

/**
 * The only well-known directories under the server's own /pups/: the site's profile images
 * and pages, and the private paths that extensions of RFC-6 define inside /pups/private/.
 */
const IMAGES_PATH = '/pups/images/';
const PAGES_PATH = '/pups/pages/';
const PRIVATE_PATH = '/pups/private/';
/** Fields that private paths can't have: private files are never linked and have no public URL. */
const PUBLIC_ONLY_FIELDS = ['url', 'rels', 'properties', 'link_properties', 'url_properties', 'single_rels'];

/**
 * The list of well-known paths (RFC-6), served at the domain root. In a folder installation
 * only /.well-known/ reaches PUPS at the domain root, so the feeds are left out there, and
 * the profile images and pages stay at storage_base.
 */
function defaultWellKnown(string $origin, string $basePath = ''): array
{
    $ns = 'https://bigwide.net/ns/';
    $root = $basePath === '';
    return array_values(array_filter([
        ['path' => '/.well-known/following.opml', 'url' => "$origin/.well-known/following.opml", 'description' => 'the list of people you follow'],
        ['path' => '/.well-known/about.md', 'url' => "$origin/.well-known/about.md",
            'properties' => array_map(fn($p) => $ns . $p, ['name', 'title', 'summary', 'theme-color', 'language']), 'description' => 'your profile'],
        ['path' => '/.well-known/contact.vcf', 'url' => "$origin/.well-known/contact.vcf", 'description' => 'your contact details'],
        $root ? ['path' => '/feed.json', 'url' => "$origin/feed.json", 'rels' => ["{$ns}feed"], 'description' => 'your feed'] : null,
        $root ? ['path' => '/feed/', 'url' => "$origin/feed/", 'rels' => ["{$ns}feed"], 'description' => 'the files of your feed, and your other feeds'] : null,
        ['path' => IMAGES_PATH, 'url' => $root ? $origin . IMAGES_PATH : null, 'properties' => ["{$ns}avatar", "{$ns}banner"],
            'url_properties' => ["{$ns}avatar", "{$ns}banner"], 'description' => "your site's profile images"],
        ['path' => PAGES_PATH, 'url' => $root ? $origin . PAGES_PATH : null, 'rels' => ["{$ns}webpup-pages"], 'link_properties' => ["{$ns}webpup-hidden"],
            'properties' => ["{$ns}webpup-footer"], 'url_properties' => ["{$ns}webpup-footer"], 'description' => "your site's pages"],
    ]));
}

/** The inbox of RFC-12, a private path: it has nothing but the path. */
function inboxWellKnown(): array
{
    return ['path' => INBOX_PATH, 'description' => 'your inbox'];
}

function stringList(mixed $v, string $what): array
{
    if ($v === null)
        return [];
    if (!is_array($v) || !array_is_list($v) || array_filter($v, fn($x) => !is_string($x)))
        throw new \InvalidArgumentException("$what must be a list of strings");
    return $v;
}

/** Validates the declared well-known paths. Throws \InvalidArgumentException on configuration errors. */
function parseWellKnown(mixed $raw, string $origin, string $basePath = ''): array
{
    $raw ??= defaultWellKnown($origin, $basePath);
    if (!is_array($raw) || !array_is_list($raw))
        throw new \InvalidArgumentException("'well_known_paths' must be a list");
    return array_map(function ($e) use ($origin, $basePath) {
        $p = is_array($e) ? ($e['path'] ?? null) : null;
        if (!is_string($p) || !preg_match('#^/(?:[A-Za-z0-9\-._~]+/)*[A-Za-z0-9\-._~]*$#D', $p) || $p === '/')
            throw new \InvalidArgumentException('Invalid well-known path: ' . json_encode($p));
        $segments = array_values(array_filter(explode('/', $p), fn($s) => $s !== ''));
        if (array_intersect($segments, ['.', '..']))
            throw new \InvalidArgumentException("Invalid well-known path: $p");
        // Compared case-insensitively, as the disk may be case-insensitive.
        $first = strtolower($segments[0]);
        if ($first === 'appdata')
            throw new \InvalidArgumentException("Well-known paths can't be under /appdata/: $p");
        // Storage is at the base, next to the server's own endpoints. /pups/images/, /pups/pages/ and paths inside /pups/private/ are free for uploads.
        $private = str_starts_with($p, PRIVATE_PATH) && $p !== PRIVATE_PATH;
        if ($first === 'oauth' || ($first === 'pups' && !str_starts_with($p, IMAGES_PATH) && !str_starts_with($p, PAGES_PATH) && !$private) || $p === CONFIG_PATH)
            throw new \InvalidArgumentException("Well-known paths can't overlap the server's endpoints (/oauth/, /pups/ except " . IMAGES_PATH . ', ' . PAGES_PATH
                . ' and paths inside ' . PRIVATE_PATH . ', ' . CONFIG_PATH . "): $p");
        if ($private && array_filter(PUBLIC_ONLY_FIELDS, fn($k) => ($e[$k] ?? null) !== null))
            throw new \InvalidArgumentException('Private paths have no ' . implode(', ', PUBLIC_ONLY_FIELDS) . ": $p");
        if ($segments[0] === '.well-known') {
            if (str_ends_with($p, '/') || count($segments) !== 2)
                throw new \InvalidArgumentException("Only single files may be declared under /.well-known/: $p");
            if (in_array($segments[1], FORBIDDEN_WELL_KNOWN, true))
                throw new \InvalidArgumentException("Forbidden well-known path: $p");
        } elseif (array_filter($segments, fn($s) => $s[0] === '.'))
            throw new \InvalidArgumentException("Dot segments are only allowed for /.well-known/ files: $p");
        $url = $e['url'] ?? null;
        if ($url !== null && (!is_string($url) || !preg_match('#^/(?:[A-Za-z0-9\-._~]+/)*[A-Za-z0-9\-._~]*$#D', substr($url, strlen($origin)))
                || !str_starts_with($url, "$origin/") || str_ends_with($p, '/') !== str_ends_with($url, '/')))
            throw new \InvalidArgumentException("The url of well-known path $p must be on $origin and end with / exactly if the path does");
        $properties = stringList($e['properties'] ?? null, 'properties');
        $linkProperties = stringList($e['link_properties'] ?? null, 'link_properties');
        if (array_filter([...$properties, ...$linkProperties], fn($x) => str_starts_with($x, PUPS_PROP_PREFIX)))
            throw new \InvalidArgumentException("PUPS properties can't be declared: $p");
        $d = $e['description'] ?? null;
        return [
            'path' => $p, 'url' => $url, 'rels' => stringList($e['rels'] ?? null, 'rels'), 'properties' => $properties,
            'linkProperties' => $linkProperties, 'singleRels' => stringList($e['single_rels'] ?? null, 'single_rels'),
            'urlProperties' => stringList($e['url_properties'] ?? null, 'url_properties'),
            'description' => is_string($d) && trim($d) !== '' ? sanitizeText($d, 100) : null,
        ];
    }, $raw);
}
