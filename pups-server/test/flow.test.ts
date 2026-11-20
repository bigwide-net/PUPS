import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { approve, codeOf, connect, exchange, ORIGIN, PASSWORD, pkce, authorizeUrl, put, refresh, setup, signedRequest } from './helpers';

const noCookie = (res: request.Response) => expect(res.headers['set-cookie']).toBeUndefined();

describe('discovery', () => {
    it('links host-meta.json to the configuration document, with CORS', async () => {
        const { app } = setup();
        const hm = await request(app).get('/.well-known/host-meta.json');
        expect(hm.status).toBe(200);
        expect(hm.headers['access-control-allow-origin']).toBe('*');
        expect(hm.body.links[0]).toEqual({ rel: 'https://bigwide.net/ns/personal-storage', type: 'application/json', href: `${ORIGIN}/personal-storage.json` });
        const cfg = await request(app).get('/personal-storage.json');
        expect(cfg.headers['content-type']).toMatch(/^application\/json/);
        expect(cfg.headers['access-control-allow-origin']).toBe('*');
        expect(cfg.body).toMatchObject({
            issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`,
            storage_base: `${ORIGIN}/`, public_base: `${ORIGIN}/`, spec_version: '0.1', max_upload_bytes: 26214400,
            host_meta_endpoint: `${ORIGIN}/pups/host-meta`,
        });
        expect(cfg.body.post_endpoint).toBeUndefined();
        const feed = ['https://bigwide.net/ns/feed'];
        expect(cfg.body.well_known_paths).toEqual([
            { path: '/.well-known/following.opml', url: `${ORIGIN}/.well-known/following.opml` },
            { path: '/.well-known/about.md', url: `${ORIGIN}/.well-known/about.md`, properties: ['name', 'title', 'summary', 'theme-color', 'language'].map(p => `https://bigwide.net/ns/${p}`) },
            { path: '/.well-known/contact.vcf', url: `${ORIGIN}/.well-known/contact.vcf` },
            { path: '/feed.json', url: `${ORIGIN}/feed.json`, rels: feed },
            { path: '/feed/', url: `${ORIGIN}/feed/`, rels: feed },
            { path: '/pups/images/', url: `${ORIGIN}/pups/images/`, properties: ['https://bigwide.net/ns/avatar', 'https://bigwide.net/ns/banner'] },
            { path: '/pups/pages/', url: `${ORIGIN}/pups/pages/`, rels: ['https://bigwide.net/ns/webpup-pages'],
                properties: ['https://bigwide.net/ns/webpup-footer'], link_properties: ['https://bigwide.net/ns/webpup-hidden'] },
        ]);
        const meta = await request(app).get('/.well-known/oauth-authorization-server');
        expect(meta.body.code_challenge_methods_supported).toEqual(['S256']);
    });

    it('answers preflights', async () => {
        const { app } = setup();
        const res = await request(app).options('/appdata/x/a.json');
        expect(res.status).toBe(204);
        expect(res.headers['access-control-allow-methods']).toContain('PUT');
        expect(res.headers['access-control-allow-headers']).toContain('If-Match');
    });
});

describe('authorization', () => {
    it('groups the permissions: identity, then one checkbox each for app data, feeds and profile, with the details collapsed', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        const scope = 'identify write:/appdata/app.example/ write:/feed.json write:/feed/photos.json write:/.well-known/following.opml write:/.well-known/about.md write:/pups/images/';
        const html = (await request(app).get(authorizeUrl(c, scope, pkce().challenge))).text;
        expect(html).toContain('<input type="checkbox" checked disabled> <span>Learn that you are <strong>alice.pups.test</strong></span>');
        expect(html).toContain('<input type="hidden" name="scope" value="identify">');
        expect(html).toContain('value="write:/appdata/app.example/" checked> <span>Store its own data</span>');
        expect(html).toContain('value="write:/feed.json write:/feed/photos.json write:/.well-known/following.opml" checked> <span>Manage your feeds</span>');
        expect(html).toContain('value="write:/.well-known/about.md write:/pups/images/" checked> <span>Manage your profile</span>');
        expect(html).toContain('<li>its own folder (<code>/appdata/app.example/</code>)</li>');
        expect(html).toContain('<li><code>/feed/photos.json</code></li>');
        expect(html).toContain('Add links to your <code>host-meta.json</code>: <code>https://bigwide.net/ns/feed</code>');
        expect(html).toContain('Set in your <code>host-meta.json</code>: <code>https://bigwide.net/ns/name</code>');
        expect([html.split('<details>').length - 1, html.split('name="scope"').length - 1, html.includes('will learn your domain')]).toEqual([3, 4, false]);

        // Dropping the feeds and the app data keeps identity and the profile.
        const t = await connect(app, c, scope, ['identify', 'write:/.well-known/about.md write:/pups/images/']);
        expect(t.scope).toBe('identify write:/.well-known/about.md write:/pups/images/');
    });

    it('groups the permissions on the apps page as on the consent screen', async () => {
        const { app, registerClient } = setup();
        await connect(app, registerClient('app.example'), 'identify write:/appdata/app.example/ write:/feed.json write:/.well-known/about.md');
        const html = (await request(app).post('/pups/apps').type('form').send({ show: '1', password: PASSWORD })).text;
        expect(html).toContain('<li>Learn that you are <strong>alice.pups.test</strong></li>');
        expect(html).toContain('<li>Store its own data\n<details>');
        expect(html).toContain('<li>Manage your feeds\n<details>');
        expect(html).toContain('<li><code>/feed.json</code></li>');
        expect(html).toContain('Set in your <code>host-meta.json</code>: <code>https://bigwide.net/ns/name</code>');
    });

    it('runs the full flow with PKCE, iss and me', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        const { verifier, challenge } = pkce();
        const page = await request(app).get(authorizeUrl(c, 'identify write:/appdata/app.example/', challenge));
        noCookie(page);
        expect(page.status).toBe(200);
        expect(page.headers['x-frame-options']).toBe('DENY');
        expect(page.headers['access-control-allow-origin']).toBeUndefined();
        expect(page.text).toContain('New app');
        expect(page.text).toContain('<legend>app.example may then</legend>');
        expect(page.text).not.toContain('outside');
        const res = await request(app).post('/oauth/authorize').type('form').send(new URLSearchParams([
            ['request', signedRequest(page.text)], ['decision', 'approve'], ['password', PASSWORD],
            ['scope', 'identify'], ['scope', 'write:/appdata/app.example/'],
        ]).toString());
        noCookie(res);
        expect(res.status).toBe(303);
        const loc = new URL(res.headers.location);
        expect(loc.origin + loc.pathname).toBe(c.redirectUri);
        expect(loc.searchParams.get('state')).toBe('xyz');
        expect(loc.searchParams.get('iss')).toBe(ORIGIN);
        const t = await exchange(app, c, loc.searchParams.get('code')!, verifier);
        expect(t.status).toBe(200);
        expect(t.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'identify write:/appdata/app.example/', me: `${ORIGIN}/` });
        expect(t.body.refresh_token).toBeTruthy();
        // The second time, the app isn't new any more.
        expect((await request(app).get(authorizeUrl(c, 'identify', challenge))).text).not.toContain('New app');
    });

    it('rejects a wrong password and does not issue a code', async () => {
        const { app, registerClient } = setup();
        const { res } = await approve(app, registerClient('app.example'), 'identify', { password: 'wrong' });
        expect(res.status).toBe(401);
        expect(res.text).toContain('Wrong password');
    });

    it('treats denial and dropping every scope as access_denied', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        const { res } = await approve(app, c, 'write:/appdata/app.example/', { grant: [] });
        expect(new URL(res.headers.location).searchParams.get('error')).toBe('access_denied');
    });

    it('shows an error page instead of redirecting for bad clients and redirect URIs', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example', { client_uri: 'https://example/' });
        const { challenge } = pkce();
        let res = await request(app).get(authorizeUrl(c, 'identify', challenge));
        expect(res.status).toBe(400);
        expect(res.text).toContain('client_uri must be on the client host');
        const d = registerClient('other.example');
        res = await request(app).get(authorizeUrl({ ...d, redirectUri: 'https://evil.example/cb' }, 'identify', challenge));
        expect(res.status).toBe(400);
        expect(res.headers.location).toBeUndefined();
        res = await request(app).get(authorizeUrl({ ...d, clientId: 'https://127.0.0.1/client.json' }, 'identify', challenge));
        expect(res.status).toBe(400);
    });

    it('accepts loopback redirects with any port, not localhost', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example', { redirect_uris: ['http://127.0.0.1/callback'] });
        const { challenge } = pkce();
        let res = await request(app).get(authorizeUrl({ ...c, redirectUri: 'http://127.0.0.1:5173/callback' }, 'identify', challenge));
        expect(res.status).toBe(200);
        expect(res.text).toContain('runs on this computer');
        res = await request(app).get(authorizeUrl({ ...c, redirectUri: 'http://localhost:5173/callback' }, 'identify', challenge));
        expect(res.status).toBe(400);
    });

    it('rejects plain PKCE and invalid scopes with a redirect', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        const { challenge } = pkce();
        let res = await request(app).get(authorizeUrl(c, 'identify', challenge, { code_challenge_method: 'plain' }));
        expect(new URL(res.headers.location).searchParams.get('error')).toBe('invalid_request');
        for (const scope of ['write:/', 'write:/appdata/other.example/', 'write:/appdata/', 'write:/elsewhere/', 'write:/.well-known/host-meta.json']) {
            res = await request(app).get(authorizeUrl(c, scope, challenge));
            expect(new URL(res.headers.location).searchParams.get('error')).toBe('invalid_scope');
        }
    });

    it('rejects a wrong verifier, and a reused code revokes its tokens', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        let { res } = await approve(app, c, 'write:/appdata/app.example/');
        expect((await exchange(app, c, codeOf(res.headers.location), pkce().verifier)).body.error).toBe('invalid_grant');

        let verifier: string;
        ({ res, verifier } = await approve(app, c, 'write:/appdata/app.example/'));
        const code = codeOf(res.headers.location);
        const t = await exchange(app, c, code, verifier);
        expect(t.status).toBe(200);
        expect((await put(app, '/appdata/app.example/a.json', t.body.access_token, '{}')).status).toBe(201);
        expect((await exchange(app, c, code, verifier)).status).toBe(400);
        expect((await put(app, '/appdata/app.example/a.json', t.body.access_token, '{}')).status).toBe(401);
    });

    it('enforces the granted scope, not the requested one', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        const t = await connect(app, c, 'write:/appdata/app.example/ write:/.well-known/about.md', ['write:/appdata/app.example/']);
        expect(t.scope).toBe('write:/appdata/app.example/');
        const res = await put(app, '/.well-known/about.md', t.access_token, '# Alice', { 'content-type': 'text/markdown' });
        expect(res.status).toBe(403);
        expect(res.headers['www-authenticate']).toContain('insufficient_scope');
    });

    it('gives identify-only grants no refresh token and no write access', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        const t = await connect(app, c, 'identify');
        expect(t.refresh_token).toBeUndefined();
        expect((await put(app, '/appdata/app.example/a.json', t.access_token, '{}')).status).toBe(403);
    });
});

describe('refresh tokens', () => {
    afterEach(() => jest.restoreAllMocks());

    it('rotates, and reuse of a replaced token revokes the grant', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        const t = await connect(app, c, 'write:/appdata/app.example/');
        const r1 = await refresh(app, c, t.refresh_token!);
        expect(r1.status).toBe(200);
        expect(r1.body.me).toBe(`${ORIGIN}/`);
        expect(r1.body.refresh_token).not.toBe(t.refresh_token);
        // The new access token is used, so the grace period no longer applies.
        expect((await put(app, '/appdata/app.example/a.json', r1.body.access_token, '{}')).status).toBe(201);
        expect((await refresh(app, c, t.refresh_token!)).status).toBe(400);
        expect((await refresh(app, c, r1.body.refresh_token)).status).toBe(400);
        expect((await put(app, '/appdata/app.example/a.json', r1.body.access_token, '{}')).status).toBe(401);
    });

    it('allows a retry within the grace period while the successors are unused', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        const t = await connect(app, c, 'write:/appdata/app.example/');
        const lost = await refresh(app, c, t.refresh_token!);
        const retry = await refresh(app, c, t.refresh_token!);
        expect(retry.status).toBe(200);
        // The lost tokens are revoked, without revoking the grant.
        expect((await put(app, '/appdata/app.example/a.json', lost.body.access_token, '{}')).status).toBe(401);
        expect((await refresh(app, c, lost.body.refresh_token)).status).toBe(400);
        expect((await put(app, '/appdata/app.example/a.json', retry.body.access_token, '{}')).status).toBe(201);
        expect((await refresh(app, c, retry.body.refresh_token)).status).toBe(200);
    });

    it('revokes the grant on reuse after the grace period', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        const t = await connect(app, c, 'write:/appdata/app.example/');
        const r1 = await refresh(app, c, t.refresh_token!);
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now + 61_000);
        expect((await refresh(app, c, t.refresh_token!)).status).toBe(400);
        expect((await refresh(app, c, r1.body.refresh_token)).status).toBe(400);
    });

    it('revokes the grant through the revocation endpoint', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        const t = await connect(app, c, 'write:/appdata/app.example/');
        const res = await request(app).post('/oauth/revoke').type('form').send({ token: t.refresh_token, client_id: c.clientId });
        expect(res.status).toBe(200);
        expect((await put(app, '/appdata/app.example/a.json', t.access_token, '{}')).status).toBe(401);
    });
});

describe('uploads', () => {
    it('creates, replaces with ETags, serves and deletes', async () => {
        const { app, registerClient, dataDir } = setup();
        const t = await connect(app, registerClient('app.example'), 'write:/appdata/app.example/');
        const tok = t.access_token;
        let res = await put(app, '/appdata/app.example/feed.json', tok, '{"v":1}', { 'if-none-match': '*', 'content-type': 'application/feed+json' });
        expect(res.status).toBe(201);
        expect(res.headers.location).toBe(`${ORIGIN}/appdata/app.example/feed.json`);
        const etag = res.headers.etag;
        expect(fs.readFileSync(path.join(dataDir, 'files/appdata/app.example/feed.json'), 'utf8')).toBe('{"v":1}');

        expect((await put(app, '/appdata/app.example/feed.json', tok, '{}', { 'if-none-match': '*' })).status).toBe(412);
        res = await put(app, '/appdata/app.example/feed.json', tok, '{"v":2}', { 'if-match': etag });
        expect(res.status).toBe(200);
        expect(res.headers.etag).not.toBe(etag);
        const etag2 = res.headers.etag;
        expect((await put(app, '/appdata/app.example/feed.json', tok, '{"v":3}', { 'if-match': etag })).status).toBe(412);

        res = await request(app).get('/appdata/app.example/feed.json');
        expect(res.status).toBe(200);
        expect(res.text).toBe('{"v":2}');
        expect(res.headers).toMatchObject({
            'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff',
            'content-security-policy': 'sandbox', 'access-control-allow-origin': '*', etag: etag2,
        });
        expect((await request(app).get('/appdata/app.example/feed.json').set('if-none-match', etag2)).status).toBe(304);
        expect((await request(app).get('/appdata/app.example/feed.json').set('service-worker', 'script')).status).toBe(403);

        res = await request(app).delete('/appdata/app.example/feed.json').set({ authorization: `Bearer ${tok}`, 'if-match': etag });
        expect(res.status).toBe(412);
        res = await request(app).delete('/appdata/app.example/feed.json').set({ authorization: `Bearer ${tok}` });
        expect(res.status).toBe(204);
        expect((await request(app).get('/appdata/app.example/feed.json')).status).toBe(404);
    });

    it('rejects missing tokens, bad paths and bad types, storing nothing', async () => {
        const { app, registerClient, dataDir } = setup({ PUPS_MAX_UPLOAD_BYTES: '100' });
        const tok = (await connect(app, registerClient('app.example'), 'write:/appdata/app.example/')).access_token;
        const res = await request(app).put('/appdata/app.example/a.json').set('content-type', 'application/json').send('{}');
        expect(res.status).toBe(401);
        expect(res.headers['access-control-allow-origin']).toBe('*');
        expect(res.body.error).toBe('invalid_token');
        for (const p of ['/appdata/app.example/../x.json', '/appdata/app.example/%2e%2e/x.json', '/appdata/app.example/a%5Cb.json',
            '/appdata/app.example/.htaccess', '/appdata/app.example/feed.json.', '/appdata/app.example//a.json'])
            expect([p, (await put(app, p, tok, '{}')).status]).toEqual([p, 400]);
        for (const p of ['/appdata/app.example/a.php', '/appdata/app.example/a.phtml', '/appdata/app.example/feed.php.json',
            '/appdata/app.example/a.html', '/appdata/app.example/a.js', '/appdata/app.example/a.css'])
            expect([p, (await put(app, p, tok, '{}')).status]).toEqual([p, 415]);
        expect((await put(app, '/appdata/app.example/a.json', tok, '{}', { 'content-type': 'text/html' })).status).toBe(415);
        expect((await put(app, '/appdata/app.example/a.json', tok, 'x'.repeat(101))).status).toBe(413);
        expect((await put(app, '/appdata/other.example/a.json', tok, '{}')).status).toBe(403);
        expect(fs.existsSync(path.join(dataDir, 'files/appdata'))).toBe(false);
    });

    it('writes and serves declared well-known files at the domain root', async () => {
        const { app, registerClient } = setup();
        const t = await connect(app, registerClient('app.example'), 'write:/.well-known/about.md');
        const res = await put(app, '/.well-known/about.md', t.access_token, '# Alice', { 'content-type': 'text/markdown' });
        expect(res.status).toBe(201);
        const got = await request(app).get('/.well-known/about.md');
        expect(got.text).toBe('# Alice');
        expect(got.headers['content-type']).toBe('text/markdown; charset=utf-8');
        expect(got.headers['content-security-policy']).toBe('sandbox');
    });

    it('accepts writes through the POST fallback when configured', async () => {
        const { app, registerClient } = setup({ PUPS_POST_FALLBACK: 'true' });
        expect((await request(app).get('/personal-storage.json')).body.post_endpoint).toBe(`${ORIGIN}/pups/post`);
        const tok = (await connect(app, registerClient('app.example'), 'write:/appdata/app.example/')).access_token;
        let res = await request(app).post('/pups/post?method=PUT&path=%2Fappdata%2Fapp.example%2Fa.json')
            .set({ authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'if-none-match': '*' }).send('{}');
        expect(res.status).toBe(201);
        res = await request(app).post('/pups/post?method=PUT&path=%2Fappdata%2Fapp.example%2F..%2Fa.json')
            .set({ authorization: `Bearer ${tok}`, 'content-type': 'application/json' }).send('{}');
        expect(res.status).toBe(400);
        res = await request(app).post('/pups/post?method=DELETE&path=%2Fappdata%2Fapp.example%2Fa.json').set({ authorization: `Bearer ${tok}` });
        expect(res.status).toBe(204);
    });

    it('serves fresh reads with any valid token, and rejects invalid ones', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        const t = await connect(app, c, 'write:/appdata/app.example/');
        const idTok = (await connect(app, registerClient('other.example'), 'identify')).access_token;
        const url = '/appdata/app.example/feed.json';
        const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
        const fresh = (tok: string) => request(app).get(url).set(bearer(tok));
        const etag = (await put(app, url, t.access_token, '{"v":1}')).headers.etag;

        // Public reads are unchanged, but vary by Authorization.
        let res = await request(app).get(url);
        expect(res.headers).toMatchObject({ 'cache-control': 'no-cache', vary: 'Authorization', etag });

        // Any valid token, the identify-only one included.
        for (const tok of [t.access_token, idTok]) {
            res = await fresh(tok);
            expect(res.status).toBe(200);
            expect(res.text).toBe('{"v":1}');
            expect(res.headers).toMatchObject({
                'cache-control': 'private, no-store', etag, 'content-type': 'application/json; charset=utf-8',
                'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'access-control-allow-origin': '*',
            });
            expect(res.headers['last-modified']).toBeDefined();
        }
        res = await request(app).head(url).set(bearer(idTok));
        expect(res.status).toBe(200);
        expect(res.headers).toMatchObject({ 'cache-control': 'private, no-store', etag });

        // Read-your-writes, with the ETag that a following If-Match is compared with.
        const etag2 = (await put(app, url, t.access_token, '{"v":2}', { 'if-match': etag })).headers.etag;
        res = await fresh(idTok);
        expect([res.text, res.headers.etag]).toEqual(['{"v":2}', etag2]);
        expect((await put(app, url, t.access_token, '{"v":3}', { 'if-match': res.headers.etag })).status).toBe(200);
        res = await fresh(t.access_token);
        expect(res.text).toBe('{"v":3}');
        const etag3 = res.headers.etag;

        // Conditional requests and ranges as in public reads.
        res = await fresh(idTok).set('if-none-match', etag3);
        expect(res.status).toBe(304);
        expect(res.headers).toMatchObject({ 'cache-control': 'private, no-store', etag: etag3 });
        expect((await fresh(idTok).set('if-none-match', etag2)).status).toBe(200);
        res = await fresh(idTok).set('range', 'bytes=5-5');
        expect([res.status, res.text, res.headers['content-range']]).toEqual([206, '3', 'bytes 5-5/7']);
        expect((await request(app).get('/appdata/app.example/missing.json').set(bearer(idTok))).status).toBe(404);

        // Invalid tokens get 401, never a public read.
        const rejected = (res: request.Response) => {
            expect(res.status).toBe(401);
            expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
            expect(res.headers['access-control-allow-origin']).toBe('*');
        };
        rejected(await request(app).get(url).set({ authorization: 'Bearer invalid' }));
        // Basic credentials of a password-protected site aren't a token: a public read.
        const basic = await request(app).get(url).set({ authorization: 'Basic YWxpY2U6c2VjcmV0' });
        expect([basic.status, basic.headers['cache-control']]).toEqual([200, 'no-cache']);
        rejected(await request(app).get('/appdata/app.example/missing.json').set(bearer('invalid')));
        expect((await request(app).post('/oauth/revoke').type('form').send({ token: t.refresh_token, client_id: c.clientId })).status).toBe(200);
        rejected(await fresh(t.access_token));
        rejected(await request(app).head(url).set(bearer(t.access_token)));
        expect((await request(app).get(url)).status).toBe(200);

        // Expired tokens, too.
        const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3601_000);
        rejected(await fresh(idTok));
        spy.mockRestore();
    });
});

describe('host-meta.json', () => {
    const hm = (app: any, tok: string, body: object) =>
        request(app).post('/pups/host-meta').set({ authorization: `Bearer ${tok}`, 'content-type': 'application/json' }).send(JSON.stringify(body));

    it('adds and removes app links, keeps owner entries, and cleans up on revocation', async () => {
        const { app, registerClient, dataDir } = setup();
        const file = path.join(dataDir, 'files/.well-known/host-meta.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ subject: 'acct:alice', links: [{ rel: 'https://bigwide.net/ns/personal-storage', href: `${ORIGIN}/personal-storage.json` }, { rel: 'me', href: 'https://x' }] }));
        const c = registerClient('app.example');
        const tok = (await connect(app, c, 'write:/appdata/app.example/')).access_token;
        const href = `${ORIGIN}/appdata/app.example/feed.json`;
        expect((await hm(app, tok, { action: 'add', rel: 'https://app.example/rel/feed', href })).status).toBe(201);
        expect((await hm(app, tok, { action: 'add', rel: 'me', href })).status).toBe(403);
        expect((await hm(app, tok, { action: 'add', rel: 'https://other.example/rel', href })).status).toBe(403);
        expect((await hm(app, tok, { action: 'add', rel: 'https://app.example/rel/feed', href: 'https://evil.example/x.json' })).status).toBe(403);
        let doc = (await request(app).get('/.well-known/host-meta.json')).body;
        expect(doc.subject).toBe('acct:alice');
        expect(doc.links).toHaveLength(3);
        expect(doc.links[2].properties['https://bigwide.net/ns/pups#client']).toBe(c.clientId);

        // Revoking on the apps page removes the app's /appdata/ links.
        const page = await request(app).post('/pups/apps').type('form').send({ show: '1', password: PASSWORD });
        const grantId = /name="revoke" value="([^"]+)"/.exec(page.text)![1];
        const res = await request(app).post('/pups/apps').type('form').send({ revoke: grantId, password: PASSWORD });
        expect(res.text).toContain('app.example can no longer write to your domain.');
        doc = (await request(app).get('/.well-known/host-meta.json')).body;
        expect(doc.links).toHaveLength(2);
        expect((await put(app, '/appdata/app.example/a.json', tok, '{}')).status).toBe(401);
    });

    it('sets only declared properties of granted well-known paths', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        let tok = (await connect(app, c, 'write:/appdata/app.example/')).access_token;
        expect((await hm(app, tok, { action: 'set-property', property: 'https://bigwide.net/ns/name', value: 'Alice' })).status).toBe(403);
        tok = (await connect(app, c, 'write:/.well-known/about.md')).access_token;
        expect((await hm(app, tok, { action: 'set-property', property: 'https://bigwide.net/ns/name', value: 'Alice' })).status).toBe(201);
        expect((await hm(app, tok, { action: 'set-property', property: 'https://bigwide.net/ns/name', value: 'a\u0001' })).status).toBe(400);
        expect((await request(app).get('/.well-known/host-meta.json')).body.properties).toEqual({ 'https://bigwide.net/ns/name': 'Alice' });
    });

    it('registers feeds with the default well-known paths', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        const rel = 'https://bigwide.net/ns/feed', type = 'application/feed+json';
        let tok = (await connect(app, c, 'write:/feed/')).access_token;
        expect((await hm(app, tok, { action: 'add', rel, href: `${ORIGIN}/feed/photos.json`, type })).status).toBe(201);
        expect((await hm(app, tok, { action: 'add', rel, href: `${ORIGIN}/feed.json`, type })).status).toBe(403);
        expect((await hm(app, tok, { action: 'add', rel: 'https://bigwide.net/ns/other', href: `${ORIGIN}/feed/photos.json` })).status).toBe(403);
        tok = (await connect(app, c, 'write:/feed.json')).access_token;
        expect((await hm(app, tok, { action: 'add', rel, href: `${ORIGIN}/feed.json`, type })).status).toBe(201);
        const links = (await request(app).get('/.well-known/host-meta.json')).body.links;
        expect(links.filter((l: any) => l.rel == rel).map((l: any) => l.href)).toEqual([`${ORIGIN}/feed/photos.json`, `${ORIGIN}/feed.json`]);
    });

    it('sets the profile properties of about.md', async () => {
        const { app, registerClient } = setup();
        const tok = (await connect(app, registerClient('app.example'), 'write:/.well-known/about.md')).access_token;
        const props = { title: 'Notes', summary: 'About me', 'theme-color': '#336699', language: 'en' };
        for (const [p, value] of Object.entries(props))
            expect((await hm(app, tok, { action: 'set-property', property: `https://bigwide.net/ns/${p}`, value })).status).toBe(201);
        expect((await hm(app, tok, { action: 'set-property', property: 'https://bigwide.net/ns/avatar', value: `${ORIGIN}/pups/images/a.png` })).status).toBe(403);
        expect(Object.keys((await request(app).get('/.well-known/host-meta.json')).body.properties)).toHaveLength(4);
    });

    it('stores profile images in /pups/images/ and sets them as URL properties', async () => {
        const { app, registerClient } = setup();
        const tok = (await connect(app, registerClient('app.example'), 'write:/pups/images/')).access_token;
        const res = await put(app, '/pups/images/x.png', tok, 'PNG', { 'content-type': 'image/png' });
        expect(res.status).toBe(201);
        expect(res.headers.location).toBe(`${ORIGIN}/pups/images/x.png`);
        const got = await request(app).get('/pups/images/x.png');
        expect(got.status).toBe(200);
        expect(got.body.toString()).toBe('PNG');
        expect(got.headers).toMatchObject({
            'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'access-control-allow-origin': '*',
        });
        const avatar = 'https://bigwide.net/ns/avatar', banner = 'https://bigwide.net/ns/banner';
        expect((await hm(app, tok, { action: 'set-property', property: avatar, value: `${ORIGIN}/pups/images/x.png` })).status).toBe(201);
        expect((await hm(app, tok, { action: 'set-property', property: banner, value: `${ORIGIN}/pups/images/sub/b.jpg` })).status).toBe(201);
        for (const value of [`${ORIGIN}/feed/x.png`, `${ORIGIN}/pups/x.png`, 'https://evil.example/pups/images/x.png'])
            expect([value, (await hm(app, tok, { action: 'set-property', property: avatar, value })).status]).toEqual([value, 403]);
        expect((await hm(app, tok, { action: 'set-property', property: 'https://bigwide.net/ns/name', value: 'Alice' })).status).toBe(403);
        expect((await request(app).get('/.well-known/host-meta.json')).body.properties)
            .toEqual({ [avatar]: `${ORIGIN}/pups/images/x.png`, [banner]: `${ORIGIN}/pups/images/sub/b.jpg` });
        // Nothing else under /pups/ is writable, and the server's own routes still work.
        for (const p of ['/pups/x.png', '/pups/apps', '/pups/host-meta', '/pups/imagesx/a.png'])
            expect([p, (await put(app, p, tok, 'PNG', { 'content-type': 'image/png' })).status]).toEqual([p, 403]);
        expect((await request(app).get('/pups/apps')).status).toBe(200);
    });

    it('publishes pages with titles, hidden flags and a footer, and orders them', async () => {
        const { app, registerClient, dataDir } = setup();
        const pages = 'https://bigwide.net/ns/webpup-pages', hidden = 'https://bigwide.net/ns/webpup-hidden', client = 'https://bigwide.net/ns/pups#client';
        const page = (n: string) => `${ORIGIN}/pups/pages/${n}.md`;
        const file = path.join(dataDir, 'files/.well-known/host-meta.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ links: [{ rel: pages, href: page('owner') }, { rel: 'me', href: 'https://x' }] }));
        const c = registerClient('app.example');
        const tok = (await connect(app, c, 'write:/pups/pages/')).access_token;
        expect((await put(app, '/pups/pages/now.md', tok, '# Now', { 'content-type': 'text/markdown' })).status).toBe(201);
        expect((await request(app).get('/pups/pages/now.md')).text).toBe('# Now');
        expect((await hm(app, tok, { action: 'add', rel: pages, href: page('now'), type: 'text/markdown' })).status).toBe(201);
        expect((await hm(app, tok, { action: 'add', rel: pages, href: page('imprint'), titles: { default: 'Imprint', de: 'Impressum' }, properties: { [hidden]: 'true' } })).status).toBe(201);
        // Undeclared link properties, the ownership marker, bad titles
        expect((await hm(app, tok, { action: 'add', rel: pages, href: page('x'), properties: { 'https://bigwide.net/ns/other': 'x' } })).status).toBe(403);
        expect((await hm(app, tok, { action: 'add', rel: pages, href: page('x'), properties: { [client]: 'https://evil.example/' } })).status).toBe(403);
        expect((await hm(app, tok, { action: 'add', rel: pages, href: page('x'), titles: { default: 'a'.repeat(256) } })).status).toBe(400);
        expect((await hm(app, tok, { action: 'add', rel: pages, href: page('x'), titles: { 'not a tag': 'x' } })).status).toBe(400);
        // Changing the app's own link replaces titles and properties; the owner's can't be changed.
        expect((await hm(app, tok, { action: 'add', rel: pages, href: page('now'), type: 'text/markdown', titles: { default: 'Now' } })).status).toBe(201);
        expect((await hm(app, tok, { action: 'add', rel: pages, href: page('owner'), titles: { default: 'Mine' } })).status).toBe(409);
        expect((await hm(app, tok, { action: 'add', rel: pages, href: page('owner') })).status).toBe(201);
        let links = (await request(app).get('/.well-known/host-meta.json')).body.links;
        expect(links).toEqual([
            { rel: pages, href: page('owner') },
            { rel: 'me', href: 'https://x' },
            { rel: pages, href: page('now'), type: 'text/markdown', titles: { default: 'Now' }, properties: { [client]: c.clientId } },
            { rel: pages, href: page('imprint'), titles: { default: 'Imprint', de: 'Impressum' }, properties: { [hidden]: 'true', [client]: c.clientId } },
        ]);
        // The footer
        const footer = 'https://bigwide.net/ns/webpup-footer';
        expect((await hm(app, tok, { action: 'set-property', property: footer, value: page('footer') })).status).toBe(201);
        expect((await hm(app, tok, { action: 'set-property', property: footer, value: `${ORIGIN}/feed/footer.md` })).status).toBe(403);
        // Order: all links of the rel, each once, in their slots; the owner's link moves too.
        for (const hrefs of [[page('now'), page('owner')], [page('now'), page('now'), page('owner'), page('imprint')], [page('now'), page('owner'), page('imprint'), page('x')]])
            expect((await hm(app, tok, { action: 'order', rel: pages, hrefs })).status).toBe(409);
        expect((await hm(app, tok, { action: 'order', rel: 'https://bigwide.net/ns/feed', hrefs: [] })).status).toBe(403);
        expect((await hm(app, tok, { action: 'order', rel: pages, hrefs: [page('imprint'), page('owner'), page('now')] })).status).toBe(204);
        links = (await request(app).get('/.well-known/host-meta.json')).body.links;
        expect(links.map((l: any) => l.href)).toEqual([page('imprint'), 'https://x', page('owner'), page('now')]);
        expect(links[2]).toEqual({ rel: pages, href: page('owner') });
    });

    it('refuses to change an invalid host-meta.json', async () => {
        const { app, registerClient, dataDir } = setup();
        const file = path.join(dataDir, 'files/.well-known/host-meta.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{ not json');
        const tok = (await connect(app, registerClient('app.example'), 'write:/appdata/app.example/')).access_token;
        const res = await hm(app, tok, { action: 'add', rel: 'https://app.example/rel', href: `${ORIGIN}/appdata/app.example/a.json` });
        expect(res.status).toBe(409);
        expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
    });
});

describe('private areas', () => {
    const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });
    /** Every response for a private path carries no-store (private, no-store as a fresh read) and varies by Authorization. */
    const privateResponse = (res: request.Response, status: number, error?: string) => {
        expect(res.status).toBe(status);
        expect(res.headers['cache-control']).toBe(status == 200 || status == 304 ? 'private, no-store' : 'no-store');
        expect(res.headers.vary).toContain('Authorization');
        expect(res.headers['access-control-allow-origin']).toBe('*');
        if (error)
            expect(res.body.error).toBe(error);
    };
    const hm = (app: any, tok: string, body: object) =>
        request(app).post('/pups/host-meta').set({ authorization: `Bearer ${tok}`, 'content-type': 'application/json' }).send(JSON.stringify(body));

    it("keeps an app's private folder to the app", async () => {
        const { app, registerClient } = setup();
        const tok = (await connect(app, registerClient('app.example'), 'write:/appdata/app.example/')).access_token;
        const other = (await connect(app, registerClient('other.example'), 'write:/appdata/other.example/')).access_token;
        const idTok = (await connect(app, registerClient('id.example'), 'identify')).access_token;
        const url = '/appdata/app.example/private/notes.json', missing = '/appdata/app.example/private/missing.json';

        let res = await put(app, url, tok, '{"secret":1}', { 'if-none-match': '*' });
        privateResponse(res, 201);
        const etag = res.headers.etag;
        res = await request(app).get(url).set(bearer(tok));
        privateResponse(res, 200);
        expect(res.text).toBe('{"secret":1}');
        expect(res.headers).toMatchObject({
            etag, 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox',
        });
        privateResponse(await request(app).head(url).set(bearer(tok)), 200);
        privateResponse(await request(app).get(url).set({ ...bearer(tok), 'if-none-match': etag }), 304);

        // The token is checked before the file is looked up: the answer never tells whether it exists.
        for (const p of [url, missing]) {
            res = await request(app).get(p);
            privateResponse(res, 401, 'invalid_token');
            expect(res.headers['www-authenticate']).toBe('Bearer');
            // Basic credentials aren't a token.
            privateResponse(await request(app).get(p).set({ authorization: 'Basic YWxpY2U6c2VjcmV0' }), 401, 'invalid_token');
            res = await request(app).get(p).set(bearer('invalid'));
            privateResponse(res, 401, 'invalid_token');
            expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
            for (const t of [other, idTok]) {
                res = await request(app).get(p).set(bearer(t));
                privateResponse(res, 403, 'insufficient_scope');
                expect(res.headers['www-authenticate']).toBe('Bearer error="insufficient_scope"');
            }
            privateResponse(await request(app).head(p), 401);
        }
        privateResponse(await request(app).get(missing).set(bearer(tok)), 404, 'not_found');
        // Another app can't write there either.
        privateResponse(await put(app, url, other, '{}'), 403, 'insufficient_scope');

        // Public files are unchanged, also next to the private folder.
        for (const p of ['/appdata/app.example/public.json', '/appdata/app.example/private.json']) {
            await put(app, p, tok, '{}');
            res = await request(app).get(p);
            expect([res.status, res.headers['cache-control'], res.headers.vary]).toEqual([200, 'no-cache', 'Authorization']);
            res = await request(app).get(p).set(bearer(idTok));
            expect([res.status, res.headers['cache-control']]).toEqual([200, 'private, no-store']);
        }

        privateResponse(await request(app).delete(url).set(bearer(tok)), 204);
        privateResponse(await request(app).get(url).set(bearer(tok)), 404);
    });

    it('declares paths in /pups/private/ for read: and write: scopes', async () => {
        const avatar = 'https://bigwide.net/ns/avatar';
        const { app, registerClient } = setup({
            PUPS_POST_FALLBACK: 'true',
            PUPS_WELL_KNOWN_PATHS: JSON.stringify([
                { path: '/feed.json', rels: ['https://bigwide.net/ns/feed'] },
                { path: '/pups/images/', properties: [avatar], url_properties: [avatar] },
                { path: '/pups/private/inbox/' },
            ]),
        });
        expect((await request(app).get('/personal-storage.json')).body.well_known_paths[2]).toEqual({ path: '/pups/private/inbox/' });
        expect((await request(app).get('/.well-known/oauth-authorization-server')).body.scopes_supported).toContain('read:/pups/private/inbox/');

        // The consent screen: the group "private data", after the others, and not part of the profile.
        const w = registerClient('writer.example'), r = registerClient('reader.example');
        let html = (await request(app).get(authorizeUrl(r, 'identify read:/pups/private/inbox/', pkce().challenge))).text;
        expect(html).toContain('Allow reader.example to access alice.pups.test?');
        expect(html).toContain('value="read:/pups/private/inbox/" checked> <span>Read your private data</span>');
        expect(html).toContain('<ul>\n<li>read files under <code>/pups/private/inbox/</code></li>\n</ul>');
        expect(html).not.toContain('Manage your profile');
        html = (await request(app).get(authorizeUrl(w, 'write:/pups/private/inbox/ write:/pups/images/ read:/pups/private/inbox/old/', pkce().challenge))).text;
        expect(html).toContain('Allow writer.example to write to alice.pups.test?');
        expect(html).toContain('value="write:/pups/images/" checked> <span>Manage your profile</span>');
        expect(html).toContain('value="write:/pups/private/inbox/ read:/pups/private/inbox/old/" checked> <span>Manage your private data</span>');
        expect(html.indexOf('Manage your profile')).toBeLessThan(html.indexOf('Manage your private data'));
        expect(html).toContain('<ul>\n<li>read, create, replace and delete files under <code>/pups/private/inbox/</code></li>\n<li>read files under <code>/pups/private/inbox/old/</code></li>\n</ul>');

        // Only declared private paths can be read with a read: scope.
        for (const scope of ['read:/pups/private/other/', 'read:/pups/private/', 'read:/feed.json', 'read:/pups/images/',
            'read:/appdata/reader.example/', 'read:/appdata/reader.example/private/', 'write:/pups/private/other/']) {
            const res = await request(app).get(authorizeUrl(r, scope, pkce().challenge));
            expect([scope, new URL(res.headers.location).searchParams.get('error')]).toEqual([scope, 'invalid_scope']);
        }

        const writer = (await connect(app, w, 'write:/pups/private/inbox/ write:/pups/images/')).access_token;
        const reader = await connect(app, r, 'identify read:/pups/private/inbox/');
        expect(reader.scope).toBe('identify read:/pups/private/inbox/');
        const other = (await connect(app, registerClient('other.example'), 'write:/appdata/other.example/')).access_token;
        const url = '/pups/private/inbox/n1.json';

        privateResponse(await put(app, url, writer, '{"n":1}', { 'if-none-match': '*' }), 201);
        for (const t of [writer, reader.access_token]) {
            const res = await request(app).get(url).set(bearer(t));
            privateResponse(res, 200);
            expect(res.text).toBe('{"n":1}');
        }
        privateResponse(await request(app).get(url), 401);
        privateResponse(await request(app).get(url).set(bearer(other)), 403, 'insufficient_scope');
        privateResponse(await request(app).get('/pups/private/inbox/missing.json').set(bearer(reader.access_token)), 404);

        // A read: scope never writes, not through the POST fallback and not in host-meta.json.
        privateResponse(await put(app, url, reader.access_token, '{}'), 403, 'insufficient_scope');
        privateResponse(await request(app).delete(url).set(bearer(reader.access_token)), 403, 'insufficient_scope');
        let res = await request(app).post('/pups/post?method=PUT&path=%2Fpups%2Fprivate%2Finbox%2Fn1.json')
            .set({ ...bearer(reader.access_token), 'content-type': 'application/json' }).send('{}');
        expect(res.status).toBe(403);
        expect((await request(app).get(url).set(bearer(writer))).text).toBe('{"n":1}');

        // The apps page groups the scope as the consent screen does.
        html = (await request(app).post('/pups/apps').type('form').send({ show: '1', password: PASSWORD })).text;
        expect(html).toContain('<li>Read your private data\n<details>');
        expect(html).toContain('<li>Manage your private data\n<details>');

        // Private files can't be linked or used as URL properties in host-meta.json.
        res = await hm(app, writer, { action: 'set-property', property: avatar, value: `${ORIGIN}/pups/private/inbox/a.png` });
        expect([res.status, res.body.error]).toEqual([403, 'forbidden']);
        expect((await hm(app, writer, { action: 'set-property', property: avatar, value: `${ORIGIN}/pups/images/a.png` })).status).toBe(201);
        res = await hm(app, other, { action: 'add', rel: 'https://other.example/rel/notes', href: `${ORIGIN}/appdata/other.example/private/notes.json` });
        expect([res.status, res.body.error]).toEqual([403, 'forbidden']);
        res = await hm(app, other, { action: 'remove', rel: 'https://other.example/rel/notes', href: `${ORIGIN}/appdata/other.example/private/notes.json` });
        expect(res.status).toBe(403);
        expect((await hm(app, other, { action: 'add', rel: 'https://other.example/rel/notes', href: `${ORIGIN}/appdata/other.example/notes.json` })).status).toBe(201);
    });
});

describe('apps page', () => {
    it('needs the password to view and to revoke, and never sets a cookie', async () => {
        const { app, registerClient } = setup();
        await connect(app, registerClient('app.example'), 'write:/appdata/app.example/');
        let res = await request(app).get('/pups/apps');
        noCookie(res);
        expect(res.text).not.toContain('app.example');
        res = await request(app).post('/pups/apps').type('form').send({ show: '1', password: 'nope' });
        expect(res.status).toBe(401);
        expect(res.text).not.toContain('app.example');
        res = await request(app).post('/pups/apps').type('form').send({ show: '1', password: PASSWORD });
        noCookie(res);
        expect(res.text).toContain('app.example');
        const grant = /name="revoke" value="([^"]+)"/.exec(res.text)![1];
        // A revocation without the password reveals nothing and revokes nothing.
        for (const password of [undefined, 'nope']) {
            res = await request(app).post('/pups/apps').type('form').send({ revoke: grant, password });
            expect(res.status).toBe(401);
            expect(res.text).toContain('Nothing was changed');
            expect(res.text).not.toContain('app.example');
            expect(res.text).not.toContain(grant);
        }
        res = await request(app).post('/pups/apps').type('form').send({ show: '1', password: PASSWORD });
        expect(res.text).toContain(grant);
    });

    it('can delete the files of a revoked app', async () => {
        const { app, registerClient, dataDir } = setup();
        const tok = (await connect(app, registerClient('app.example'), 'write:/appdata/app.example/')).access_token;
        await put(app, '/appdata/app.example/a.json', tok, '{}');
        const page = await request(app).post('/pups/apps').type('form').send({ show: '1', password: PASSWORD });
        const grant = /name="revoke" value="([^"]+)"/.exec(page.text)![1];
        await request(app).post('/pups/apps').type('form').send({ revoke_delete: grant, password: PASSWORD });
        expect(fs.existsSync(path.join(dataDir, 'files/appdata/app.example'))).toBe(false);
    });

    it('shows host-meta.json and removes links and properties, only with the password', async () => {
        const { app, dataDir } = setup();
        const file = path.join(dataDir, 'files/.well-known/host-meta.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ links: [{ rel: 'me', href: 'https://x.example/' }, { rel: 'me', href: 'https://y.example/' }], properties: { 'https://p.example/a': 'b' } }));
        const page = await request(app).post('/pups/apps').type('form').send({ show: '1', password: PASSWORD });
        expect(page.text).toContain('<code>https://x.example/</code>');
        const link = /name="remove_link" value="([^"]+)"/.exec(page.text)![1].replace(/&quot;/g, '"');
        expect(JSON.parse(link)).toEqual(['me', 'https://x.example/']);
        let res = await request(app).post('/pups/apps').type('form').send({ remove_link: link, password: 'nope' });
        expect([res.status, res.text.includes('Nothing was changed')]).toEqual([401, true]);
        res = await request(app).post('/pups/apps').type('form').send({ remove_link: link, password: PASSWORD });
        expect(res.text).toContain('The link was removed.');
        await request(app).post('/pups/apps').type('form').send({ remove_property: 'https://p.example/a', password: PASSWORD });
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ links: [{ rel: 'me', href: 'https://y.example/' }], properties: {} });
        res = await request(app).post('/pups/apps').type('form').send({ remove_link: '["me"]', password: PASSWORD });
        expect(res.text).toContain('Invalid link.');
    });
});

describe('owner pages', () => {
    it('serve their stylesheet and script, and allow no other script', async () => {
        const { app } = setup();
        const page = await request(app).get('/');
        expect(page.text).toContain('<link rel="stylesheet" href="/pups/assets/owner.css">');
        expect(page.headers['content-security-policy']).toContain("script-src 'self'; style-src 'self';");
        for (const [file, type] of [['owner.css', 'text/css'], ['owner.js', 'text/javascript']]) {
            const res = await request(app).get(`/pups/assets/${file}`);
            expect([res.status, res.headers['content-type'].split(';')[0], res.headers['x-content-type-options']]).toEqual([200, type, 'nosniff']);
        }
        expect((await request(app).get('/pups/assets/missing.css')).status).toBe(404);
    });
});

describe('persistence', () => {
    it('keeps grants and tokens across restarts', async () => {
        const first = setup();
        const c = first.registerClient('app.example');
        const t = await connect(first.app, c, 'write:/appdata/app.example/');
        const second = setup({ PUPS_DATA_DIR: first.dataDir });
        expect((await put(second.app, '/appdata/app.example/a.json', t.access_token, '{}')).status).toBe(201);
        const state = JSON.parse(fs.readFileSync(path.join(first.dataDir, 'state.json'), 'utf8'));
        expect(JSON.stringify(state)).not.toContain(t.access_token);
    });
});
