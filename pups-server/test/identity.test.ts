import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { authorizeUrl, connect, ORIGIN, PASSWORD, pkce, put, setup } from './helpers';

// Identity tokens (RFC-10): the scope, the token exchange, the JWK Set and the log on the apps page.

const { app, dataDir, registerClient } = setup();
const reader = registerClient('reader.example');
const writer = registerClient('writer.example');
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS = 'urn:ietf:params:oauth:token-type:access_token';

const exchange = (subject: string, fields: Record<string, string> | [string, string][] = {}, client = reader) =>
    request(app).post('/oauth/token').type('form').send(new URLSearchParams([
        ['grant_type', TOKEN_EXCHANGE], ['client_id', client.clientId], ['subject_token', subject], ['subject_token_type', ACCESS],
        ...Array.isArray(fields) ? fields : Object.entries({ audience: 'https://polls.example.com', ...fields }),
    ]).toString());
const part = (token: string, i: number) => JSON.parse(Buffer.from(token.split('.')[i], 'base64url').toString());
const jwks = async () => (await request(app).get('/pups/jwks.json')).body.keys;
const appsPage = (fields: Record<string, string>) => request(app).post('/pups/apps').type('form').send({ ...fields, password: PASSWORD });

/** Whether the token's signature checks out with the published key of its kid. */
async function verifies(token: string) {
    const jwk = (await jwks()).find((k: any) => k.kid == part(token, 0).kid);
    if (!jwk)
        return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const [h, p, sig] = token.split('.');
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Buffer.from(sig, 'base64url'), new TextEncoder().encode(`${h}.${p}`));
}

describe('identity tokens', () => {
    it('are announced, with the key set', async () => {
        const cfg = (await request(app).get('/personal-storage.json')).body;
        expect([cfg.scopes_supported, cfg.jwks_uri]).toEqual([['identify', 'write:/appdata/', 'identity-tokens'], `${ORIGIN}/pups/jwks.json`]);
        const m = (await request(app).get('/.well-known/oauth-authorization-server')).body;
        expect([m.jwks_uri, m.grant_types_supported, m.scopes_supported.includes('identity-tokens')])
            .toEqual([`${ORIGIN}/pups/jwks.json`, ['authorization_code', 'refresh_token', TOKEN_EXCHANGE], true]);
        const r = await request(app).get('/pups/jwks.json');
        expect([r.status, r.headers['access-control-allow-origin'], r.headers['cache-control']]).toEqual([200, '*', 'public, max-age=600']);
        expect(r.body.keys).toEqual([{ kty: 'RSA', use: 'sig', alg: 'RS256', kid: expect.any(String), n: expect.any(String), e: 'AQAB' }]);
        expect(await jwks()).toEqual(r.body.keys);
        expect((await request(app).head('/pups/jwks.json')).status).toBe(200);
        expect((await request(app).put('/pups/jwks.json').send('{}')).status).toBe(405);
        // The key is in the server's state, never in the storage.
        const key = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).signingKey;
        expect(key.kid).toBe(r.body.keys[0].kid);
        expect(fs.readdirSync(path.join(dataDir, 'files'), { recursive: true }).join(' ')).not.toContain('jwks');
    });

    it('need their own consent group, with confirmation, and come with a refresh token', async () => {
        const page = (await request(app).get(authorizeUrl(reader, 'identify identity-tokens', pkce().challenge))).text;
        expect(page).toContain('name="scope" value="identity-tokens" checked> <span>Act as <strong>alice.pups.test</strong> on other sites');
        expect(page).toContain('name="password"');
        const t = await connect(app, reader, 'identify identity-tokens');
        expect([t.scope, !!t.refresh_token]).toEqual(['identify identity-tokens', true]);
    });

    it('are signed tokens for one audience, which the published key checks', async () => {
        const t = await connect(app, reader, 'identify identity-tokens');
        const r = await exchange(t.access_token);
        expect([r.status, r.headers['cache-control']]).toEqual([200, 'no-store']);
        expect(r.body).toMatchObject({ issued_token_type: 'urn:ietf:params:oauth:token-type:jwt', token_type: 'Bearer', expires_in: 60 });
        const token = r.body.access_token;
        expect(part(token, 0)).toEqual({ typ: 'at+jwt', alg: 'RS256', kid: (await jwks())[0].kid });
        const claims = part(token, 1);
        expect(claims).toMatchObject({ iss: ORIGIN, sub: `${ORIGIN}/`, aud: 'https://polls.example.com', client_id: reader.clientId });
        expect(claims.exp - claims.iat).toBe(60);
        expect(await verifies(token)).toBe(true);
        expect(part((await exchange(t.access_token)).body.access_token, 1).jti).not.toBe(claims.jti);

        // Never accepted by the upload API.
        expect((await put(app, '/appdata/reader.example/x.json', token, '{}')).status).toBe(401);

        // A read token, for fetching personal feeds: scope read, 24 hours.
        const read = (await exchange(t.access_token, { audience: 'https://comments.example.org', scope: 'read' })).body;
        expect(read).toMatchObject({ issued_token_type: 'urn:ietf:params:oauth:token-type:jwt', token_type: 'Bearer', expires_in: 86400, scope: 'read' });
        const rc = part(read.access_token, 1);
        expect([rc.scope, rc.aud, rc.exp - rc.iat, await verifies(read.access_token)]).toEqual(['read', 'https://comments.example.org', 86400, true]);
        expect(claims.scope).toBeUndefined();
        expect((await request(app).get('/appdata/reader.example/x.json').set('authorization', `Bearer ${token}`)).status).toBe(401);
    });

    it('are refused without the scope, for another app, a bad audience or extra parameters, and after revocation', async () => {
        const plain = await connect(app, writer, 'write:/appdata/writer.example/');
        expect((await exchange(plain.access_token, {}, writer)).body).toMatchObject({ error: 'invalid_scope' });
        const t = await connect(app, reader, 'identity-tokens');
        expect((await exchange(t.access_token, {}, writer)).body).toMatchObject({ error: 'invalid_grant' });
        expect((await exchange('nonsense')).body).toMatchObject({ error: 'invalid_grant' });
        for (const audience of ['https://polls.example.com/', 'https://polls.example.com/vote', 'http://polls.example.com', 'https://127.0.0.1', 'https://localhost'])
            expect([audience, (await exchange(t.access_token, { audience })).body.error]).toEqual([audience, 'invalid_target']);
        expect((await exchange(t.access_token, [['audience', 'https://a.example'], ['audience', 'https://b.example']])).body).toMatchObject({ error: 'invalid_target' });
        for (const extra of [{ resource: 'https://polls.example.com' }, { actor_token: 'x' }] as Record<string, string>[])
            expect((await exchange(t.access_token, extra)).body).toMatchObject({ error: 'invalid_request' });
        for (const scope of ['identify', 'read write', 'write'])
            expect((await exchange(t.access_token, { scope })).body).toMatchObject({ error: 'invalid_scope' });
        expect((await exchange(t.access_token)).status).toBe(200);
        await request(app).post('/oauth/revoke').type('form').send({ token: t.refresh_token, client_id: reader.clientId });
        expect((await exchange(t.access_token)).body).toMatchObject({ error: 'invalid_grant' });
    });

    it('are limited per minute, logged on the apps page, and the owner can replace the key', async () => {
        const t = await connect(app, reader, 'identity-tokens');
        for (let i = 0; i < 59; i++)
            expect((await exchange(t.access_token, { audience: 'https://groups.example.com', ...i < 2 && { scope: 'read' } })).status).toBe(200);
        const last = (await exchange(t.access_token)).body.access_token;
        const limited = await exchange(t.access_token);
        expect([limited.status, limited.body.error, limited.headers['retry-after']]).toEqual([429, 'slow_down', '60']);

        let html = (await appsPage({ show: '1' })).text;
        expect(html).toContain('<li><code>polls.example.com</code>: once, last');
        expect(html).toContain('<li><code>groups.example.com</code>: 59 times (2 times for reading), last');
        const kid = (await jwks())[0].kid;
        expect(html).toContain(`<code>${kid}</code>`);
        // Only with the password.
        let res = await request(app).post('/pups/apps').type('form').send({ replace_signing_key: '1', password: 'nope' });
        expect([res.status, res.text.includes('Nothing was changed'), (await jwks())[0].kid]).toEqual([401, true, kid]);
        html = (await appsPage({ replace_signing_key: '1' })).text;
        const keys = await jwks();
        expect([keys.length, keys[0].kid == kid, html.includes(`The signing key was replaced; the new one is ${keys[0].kid}.`)]).toEqual([1, false, true]);
        expect(await verifies(last)).toBe(false);
    });

    it('use one key, also when the first uses come at once, and keep it across restarts', async () => {
        const fresh = setup();
        const kids = (await Promise.all([1, 2, 3].map(() => request(fresh.app).get('/pups/jwks.json')))).map(r => r.body.keys[0].kid);
        expect(new Set(kids).size).toBe(1);
        const again = setup({ PUPS_DATA_DIR: fresh.dataDir });
        expect((await request(again.app).get('/pups/jwks.json')).body.keys[0].kid).toBe(kids[0]);
    });
});
