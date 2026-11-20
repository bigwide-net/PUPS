import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createApp } from '../controller';
import { FetchedDoc } from '../lib/cimd';
import { loadConfig, PupsConfig } from '../lib/config';
import { randomToken, s256 } from '../lib/crypto';

export const ORIGIN = 'https://alice.pups.test';
export const PASSWORD = 'correct horse battery staple';

export interface TestClient {
    clientId: string;
    redirectUri: string;
    host: string;
}

/** A fresh server with its own data directory, and a fake network for client metadata documents. */
export function setup(env: Record<string, string> = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pups-test-'));
    const config: PupsConfig = loadConfig({ PUPS_ORIGIN: ORIGIN, PUPS_PASSWORD: PASSWORD, PUPS_DATA_DIR: dataDir, ...env });
    const docs = new Map<string, FetchedDoc>();
    const app = createApp(config, {
        fetchClientDoc: async url => docs.get(url) ?? { status: 404, body: 'not found' },
    });
    const registerClient = (host: string, extra: object = {}): TestClient => {
        const clientId = `https://${host}/oauth/client.json`;
        const redirectUri = `https://${host}/callback`;
        docs.set(clientId, { status: 200, body: JSON.stringify({ client_id: clientId, client_name: 'Test App', redirect_uris: [redirectUri], ...extra }) });
        return { clientId, redirectUri, host };
    };
    return { app, config, dataDir, docs, registerClient };
}

export type App = ReturnType<typeof setup>['app'];

export function pkce() {
    const verifier = randomToken(32);
    return { verifier, challenge: s256(verifier) };
}

export function authorizeUrl(c: TestClient, scope: string, challenge: string, extra: Record<string, string> = {}) {
    return `/oauth/authorize?${new URLSearchParams({
        response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri, scope, state: 'xyz',
        code_challenge: challenge, code_challenge_method: 'S256', ...extra,
    })}`;
}

export const signedRequest = (html: string) => /name="request" value="([^"]+)"/.exec(html)![1];

const form = (pairs: [string, string][]) => new URLSearchParams(pairs).toString();

/** Runs the authorization request and approves it. Returns the redirect to the app. */
export async function approve(app: App, c: TestClient, scope: string, opts: { grant?: string[]; password?: string } = {}) {
    const { verifier, challenge } = pkce();
    const page = await request(app).get(authorizeUrl(c, scope, challenge));
    expect(page.status).toBe(200);
    const pairs: [string, string][] = [['request', signedRequest(page.text)], ['decision', 'approve'], ['password', opts.password ?? PASSWORD]];
    for (const sc of opts.grant ?? scope.split(' '))
        pairs.push(['scope', sc]);
    const res = await request(app).post('/oauth/authorize').type('form').send(form(pairs));
    return { res, verifier };
}

export const exchange = (app: App, c: TestClient, code: string, verifier: string) =>
    request(app).post('/oauth/token').type('form').send({
        grant_type: 'authorization_code', code, client_id: c.clientId, redirect_uri: c.redirectUri, code_verifier: verifier,
    });

export const codeOf = (location: string) => new URL(location).searchParams.get('code')!;

/** Connects an app: authorization, approval and code exchange. Returns the token response. */
export async function connect(app: App, c: TestClient, scope: string, grant?: string[]) {
    const { res, verifier } = await approve(app, c, scope, { grant });
    expect(res.status).toBe(303);
    const t = await exchange(app, c, codeOf(res.headers.location), verifier);
    expect(t.status).toBe(200);
    return t.body as { access_token: string; refresh_token?: string; scope: string; me: string; expires_in: number };
}

export const refresh = (app: App, c: TestClient, token: string) =>
    request(app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', refresh_token: token, client_id: c.clientId });

export const put = (app: App, path: string, token: string, body: string, headers: Record<string, string> = {}) =>
    request(app).put(path).set({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }).send(body);
