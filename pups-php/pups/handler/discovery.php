<?php

namespace Pups;

function endpoints(Config $c): array
{
    return [
        'authorization_endpoint' => "$c->base/oauth/authorize",
        'token_endpoint' => "$c->base/oauth/token",
        'revocation_endpoint' => "$c->base/oauth/revoke",
    ];
}

/** The largest upload this installation accepts: the setting, and PHP's post_max_size if writes go through POST. */
function maxUploadBytes(Config $c): int
{
    $post = iniBytes(ini_get('post_max_size') ?: '0');
    return $c->postFallback && $post ? min($c->maxUploadBytes, $post) : $c->maxUploadBytes;
}

/** An ini size like `8M` in bytes. */
function iniBytes(string $v): int
{
    $n = (int) $v;
    return match (strtolower(substr(trim($v), -1))) { 'g' => $n << 30, 'm' => $n << 20, 'k' => $n << 10, default => $n };
}

/** The PUPS configuration document (RFC-6 "Configuration document"). */
function configDocument(Config $c): array
{
    return [
        'issuer' => $c->issuer,
        ...endpoints($c),
        'storage_base' => $c->storageBase,
        'public_base' => $c->publicBase,
        'scopes_supported' => ['identify', 'write:/appdata/'],
        // Private paths have nothing but `path`.
        'well_known_paths' => array_map(fn($e) => array_filter([
            'path' => $e['path'], 'url' => $e['url'], 'rels' => $e['rels'] ?: null, 'properties' => $e['properties'] ?: null,
            'link_properties' => $e['linkProperties'] ?: null,
        ], fn($v) => $v !== null), $c->wellKnown),
        'host_meta_endpoint' => "$c->base/pups/host-meta",
        ...($c->postFallback ? ['post_endpoint' => "$c->base/pups/post"] : []),
        // The built-in receiver: clients learn here that the mention link in host-meta.json is this
        // server, and where to send comments on the owner's feeds (`_submissions.url`).
        ...($c->mentions ? ['mention_endpoint' => mentionUrl($c)] : []),
        ...($c->comments ? ['comment_endpoint' => commentUrl($c)] : []),
        'max_upload_bytes' => maxUploadBytes($c),
        'spec_version' => SPEC_VERSION,
    ];
}

/** RFC 8414 metadata, for generic OAuth tooling. */
function oauthMetadata(Config $c): array
{
    return [
        'issuer' => $c->issuer,
        ...endpoints($c),
        'response_types_supported' => ['code'],
        'response_modes_supported' => ['query'],
        'grant_types_supported' => ['authorization_code', 'refresh_token'],
        'code_challenge_methods_supported' => ['S256'],
        'token_endpoint_auth_methods_supported' => ['none'],
        'revocation_endpoint_auth_methods_supported' => ['none'],
        'authorization_response_iss_parameter_supported' => true,
        'client_id_metadata_document_supported' => true,
        'scopes_supported' => ['identify', 'write:/appdata/', ...array_map(fn($e) => "write:$e[path]", $c->wellKnown),
            ...array_map(fn($e) => "read:$e[path]", array_values(array_filter($c->wellKnown, fn($e) => isPrivate($e['path']))))],
        'service_documentation' => $c->configUrl,
    ];
}

/**
 * /.well-known/host-meta.json: the stored file (apps add links through host_meta_endpoint,
 * the owner may edit it by hand), or a generated one that contains just the PUPS link.
 */
function hostMetaDocument(Ctx $ctx): Response
{
    $stored = readHostMeta($ctx);
    if (!$stored)
        return jsonDocument(defaultHostMeta($ctx->config));
    return new Response(200, [
        'Content-Type' => 'application/json; charset=utf-8', 'ETag' => $stored['etag'], 'Cache-Control' => 'no-cache',
        'X-Content-Type-Options' => 'nosniff',
    ], $stored['text']);
}

/** The start page of the owner pages, /pups/ (/ forwards here while the domain has no homepage). */
function startPage(Ctx $ctx): Response
{
    $c = $ctx->config;
    $owner = $ctx->state->owner();
    return page($c, "Personal Upload Server for $c->host", '<h1>Personal Upload Server</h1>
<p>This is the Personal Upload Server of <strong>' . h($c->host) . '</strong>. Apps can upload files to this domain once its owner allows them.</p>
' . ($owner ? homepageSummary($c) : '<p role="note">This server has no owner yet. <a href="' . h($c->path('/pups/setup')) . '">Set it up</a>.</p>') . '
<ul>
<li><a href="' . h($c->path('/pups/apps')) . '">Your apps</a>: see which apps have access, and remove them.</li>
' . ($c->basePath === '' ? '<li><a href="' . h($c->path('/pups/homepage')) . '">Homepage</a>: install webpup as the homepage of your domain, choose its theme, or remove it.</li>' : '') . '
<li>Discovery: <a href="/.well-known/host-meta.json">/.well-known/host-meta.json</a> → <a href="' . h($c->configUrl) . '">' . h($c->configUrl) . '</a>
· <a href="' . h(OAUTH_METADATA_PATH) . '">OAuth metadata</a></li>
</ul>');
}
