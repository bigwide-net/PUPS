import express from 'express';
import { CONFIG_PATH, IMPLEMENTATION, PupsConfig, SPEC_VERSION } from '../lib/config';
import { Ctx } from '../lib/context';
import { escapeHtml as h, page } from 'pups-ui';
import { send } from '../lib/html';
import { isPrivate } from '../lib/paths';
import { defaultHostMeta, readHostMeta } from './hostmeta';

const endpoints = (c: PupsConfig) => ({
    authorization_endpoint: `${c.issuer}/oauth/authorize`,
    token_endpoint: `${c.issuer}/oauth/token`,
    revocation_endpoint: `${c.issuer}/oauth/revoke`,
});

/** The PUPS configuration document (RFC-6 "Configuration document"). */
export const configDocument = (c: PupsConfig) => ({
    issuer: c.issuer,
    ...endpoints(c),
    storage_base: c.storageBase,
    public_base: c.publicBase,
    scopes_supported: ['identify', 'write:/appdata/'],
    well_known_paths: c.wellKnown.map(e => ({
        path: e.path,
        ...e.url && { url: e.url },
        ...e.rels.length && { rels: e.rels },
        ...e.properties.length && { properties: e.properties },
        ...e.linkProperties.length && { link_properties: e.linkProperties },
    })),
    host_meta_endpoint: `${c.origin}/pups/host-meta`,
    ...c.postFallback && { post_endpoint: `${c.origin}/pups/post` },
    max_upload_bytes: c.maxUploadBytes,
    spec_version: SPEC_VERSION,
    implementation: IMPLEMENTATION,
});

/** RFC 8414 metadata, for generic OAuth tooling. */
export const oauthMetadata = (c: PupsConfig) => ({
    issuer: c.issuer,
    ...endpoints(c),
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    scopes_supported: ['identify', 'write:/appdata/', ...c.wellKnown.map(e => `write:${e.path}`),
        ...c.wellKnown.filter(e => isPrivate(e.path)).map(e => `read:${e.path}`)],
    service_documentation: c.configUrl,
});

const sendJson = (res: express.Response, body: unknown) =>
    res.set({ 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }).type('application/json').send(JSON.stringify(body, null, 2));

export function discoveryRoutes(ctx: Ctx): express.Router {
    const { config } = ctx;
    const router = express.Router();

    // The stored file (apps add links through host_meta_endpoint, the owner may edit it by hand),
    // or a generated one that contains just the PUPS link.
    router.get('/.well-known/host-meta.json', (_req, res) => {
        const stored = readHostMeta(ctx);
        if (stored)
            return res.set({ ETag: stored.etag, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
                .type('application/json').send(stored.text);
        sendJson(res, defaultHostMeta(config));
    });
    router.get(CONFIG_PATH, (_req, res) => sendJson(res, configDocument(config)));
    router.get('/.well-known/oauth-authorization-server', (_req, res) => sendJson(res, oauthMetadata(config)));

    // A start page for the owner, handy to check the setup.
    router.get('/', (_req, res) => send(res, page(`PUPS test server for ${config.host}`, `<h1>PUPS test server</h1>
<p>This is the Personal Upload Server of <strong>${h(config.host)}</strong>.</p>
<p><a href="/pups/apps">Your apps</a>: see which apps have access, and remove them.</p>
<section aria-labelledby="discovery">
<h2 id="discovery">Discovery</h2>
<p><a href="/.well-known/host-meta.json">/.well-known/host-meta.json</a> → <a href="${h(CONFIG_PATH)}">${h(CONFIG_PATH)}</a>,
<a href="/.well-known/oauth-authorization-server">OAuth metadata</a></p>
<p>Data directory: <code>${h(config.dataDir)}</code></p>
</section>`, { site: config.host })));
    return router;
}
