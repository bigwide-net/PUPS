<?php
// PUPS configuration. Copy this file to config.php and fill in the first two settings.
// Everything else has a sensible default; see README.md, "Configuration".

return [
    // Your domain, as an origin: https, lowercase, no path, no trailing slash. It is your
    // identity toward apps ("me"), and all URLs derive from it.
    'origin' => 'https://alice.example',

    // A long random value (at least 16 characters). You enter it once on /pups/setup to prove
    // that you installed this server; after setup it is no longer used.
    // Generate one with: openssl rand -base64 32
    'setup_secret' => '',

    // Where PUPS keeps state.json (grants, hashed tokens, your credentials), the log and the
    // uploaded files. Default: the folder data/ next to this file, protected by .htaccess.
    // Better, if your host allows it: a folder outside the web root, e.g. __DIR__ . '/../pups-data'.
    // 'data_dir' => __DIR__ . '/data',

    // Where PUPS is installed, as seen from the browser: '' at the domain root, '/pups' in a
    // folder. Default: detected from the URL of index.php.
    // 'base_path' => '',

    // Largest accepted file in bytes (default 25 MB), and an overall quota (0: none).
    // 'max_upload_bytes' => 26214400,
    // 'max_storage_bytes' => 0,

    // Writes per minute per app before it gets 429 (0: no limit).
    // 'writes_per_minute' => 120,

    // Make apps send writes through POST (post_endpoint): true or false. Default: decided by
    // the checks on the setup and server pages, which test whether PUT and DELETE get through.
    // 'post_fallback' => null,

    // Declared well-known paths. Default: the list of well-known paths of RFC-6, at the domain
    // root: /.well-known/following.opml, /.well-known/about.md, /.well-known/contact.vcf,
    // /feed.json, /feed/, /pups/images/ (profile images) and /pups/pages/ (the site's pages).
    // See README.md, "Well-known paths".
    // If your website already serves /feed.json or /feed/ (WordPress does), list the paths
    // without them, e.g.:
    // 'well_known_paths' => [
    //     ['path' => '/.well-known/about.md', 'url' => 'https://alice.example/.well-known/about.md',
    //      'properties' => ['https://bigwide.net/ns/name'], 'description' => 'your profile'],
    //     ['path' => '/pups/images/', 'url' => 'https://alice.example/pups/images/',
    //      'properties' => ['https://bigwide.net/ns/avatar'], 'url_properties' => ['https://bigwide.net/ns/avatar'],
    //      'description' => "your site's profile images"],
    //     ['path' => '/pups/pages/', 'url' => 'https://alice.example/pups/pages/',
    //      'rels' => ['https://bigwide.net/ns/webpup-pages'], 'link_properties' => ['https://bigwide.net/ns/webpup-hidden'],
    //      'properties' => ['https://bigwide.net/ns/webpup-footer'], 'url_properties' => ['https://bigwide.net/ns/webpup-footer'],
    //      'description' => "your site's pages"],
    // ],

    // Base URL for public reads, if they go through another host (a CDN). Default: storage_base.
    // 'public_base' => null,

    // The built-in receiver, which writes your private inbox (/pups/private/inbox.json):
    // mentions of your domain from other sites (linked from host-meta.json as your mention
    // endpoint), and comments on your feeds, for feeds whose apps send them here. Comments are
    // not published; you read and dismiss them in your feed reader. See README.md, "Inbox".
    // 'mentions' => true,
    // 'comments' => true,

    // With webpup as your homepage (installed on /pups/homepage): end the page with a small
    // "Owner" link to the owner pages at /pups/.
    // 'webpup_owner_link' => true,

    // --- Local development only ---------------------------------------------------------------

    // Accept a plain http:// origin, e.g. 'http://localhost:8080'. Apps require HTTPS.
    // 'allow_http' => false,

    // Fetch client metadata documents from private addresses, e.g. a test app at
    // https://app.pups.test that resolves to 127.0.0.1. Never on a public server (SSRF).
    // 'allow_private_clients' => false,

    // An additional CA certificate (PEM file) to trust when fetching client metadata
    // documents, e.g. mkcert's: the file rootCA.pem in the folder `mkcert -CAROOT` prints.
    // 'extra_ca' => null,
];
