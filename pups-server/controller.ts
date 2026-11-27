import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import express from 'express';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { adminRoutes } from './handler/admin';
import { discoveryRoutes } from './handler/discovery';
import { fileRoutes } from './handler/files';
import { hostMetaRoutes } from './handler/hostmeta';
import { oauthRoutes, signingKey } from './handler/oauth';
import { ClientLoader, FetchDoc } from './lib/cimd';
import { loadConfig, PupsConfig } from './lib/config';
import { Ctx } from './lib/context';
import { assetRoutes } from './lib/html';
import { corsMiddleware, errorMiddleware, HttpError } from './lib/http';
import { requestLog } from './lib/log';
import { OwnerAuth } from './lib/owner';
import { State } from './lib/state';
import { FileStore } from './lib/storage';

export interface AppDeps {
    /** Replaces the HTTPS fetch of client metadata documents (tests). */
    fetchClientDoc?: FetchDoc;
}

/**
 * The Personal Upload Server (RFC-6) as an Express app: discovery, OAuth, the upload API,
 * host-meta.json editing and the owner pages. See README.md.
 */
export function createApp(config: PupsConfig = loadConfig(), deps: AppDeps = {}) {
    const ctx: Ctx = {
        config,
        state: new State(path.join(config.dataDir, 'state.json')),
        files: new FileStore(path.join(config.dataDir, 'files')),
        clients: new ClientLoader(config, deps.fetchClientDoc),
        owner: new OwnerAuth(config),
    };
    // The key that signs identity tokens (RFC-10), made at the start, before any app can ask for one.
    void signingKey(ctx);
    const app = express();
    app.disable('x-powered-by');
    app.disable('etag');
    app.use(requestLog);
    if (config.origin.startsWith('https:'))
        app.use((_req, res, next) => (res.set('Strict-Transport-Security', 'max-age=31536000'), next()));
    app.use(corsMiddleware);
    app.use(assetRoutes());
    app.use(discoveryRoutes(ctx));
    app.use(oauthRoutes(ctx));
    app.use(adminRoutes(ctx));
    app.use(hostMetaRoutes(ctx));
    app.use(fileRoutes(ctx));
    app.use(() => {
        throw new HttpError(404, 'not_found', 'Not found');
    });
    app.use(errorMiddleware);
    return app;
}

export function startServer(config = loadConfig()) {
    const app = createApp(config);
    const server = config.tlsCert
        ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey!) }, app)
        : http.createServer(app);
    // Listen on all interfaces, but unless allowed, drop connections that don't come from this machine.
    if (!config.allowRemote)
        server.on('connection', socket => /^(127\.|::1$|::ffff:127\.)/.test(socket.remoteAddress ?? '') || socket.destroy());
    server.listen(config.port, () => {
        console.log(`PUPS test server for ${config.origin}`);
        console.log(`  listening on port ${config.port} (${config.tlsCert ? 'HTTPS' : 'HTTP'}), ${config.allowRemote ? 'open to other machines' : 'local connections only'}`);
        console.log(`  data in ${config.dataDir}`);
        console.log(`  apps page: ${config.origin}/pups/apps`);
        if (config.origin.startsWith('http:'))
            console.warn('  WARNING: plain HTTP. RFC-6 clients require HTTPS; use this only for tests that allow it.');
        if (config.allowPrivateClients)
            console.warn('  WARNING: PUPS_ALLOW_PRIVATE_CLIENTS is on: client metadata may be fetched from private addresses.');
    });
    server.on('error', (e: any) => {
        console.error(e.code == 'EACCES'
            ? `No permission to listen on port ${config.port}. See README.md, "Port 443".`
            : e.code == 'EADDRINUSE' ? `Port ${config.port} is already in use.` : e);
        process.exit(1);
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 120_000;
    return server;
}
