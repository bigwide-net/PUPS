import request from 'supertest';
import { escapeUnsafe, isCspOrigin, isHostName, sanitizeText, visible } from 'pups-ui';
import { authorizeUrl, connect, ORIGIN, PASSWORD, pkce, put, setup } from './helpers';

describe('sanitize', () => {
    it('cleans self-declared text like Downread', () => {
        expect(sanitizeText(' a\u202eb\u200b\n\tc\u0007 \ufeff', 100)).toBe('ab c');
        expect(sanitizeText('👨‍👩‍👧 family', 100)).toBe('👨‍👩‍👧 family');
        expect(sanitizeText('😀😀😀😀', 3)).toBe('😀😀…');
        expect(sanitizeText('\u200b', 10)).toBeUndefined();
        expect(sanitizeText(42, 10)).toBeUndefined();
    });

    it('makes unsafe characters visible or escapes them', () => {
        expect(visible('/a\u202eb')).toBe('/a\\u{202e}b');
        expect(escapeUnsafe('x\u001b[31m\u009b')).toBe('x\\u001b[31m\\u009b');
    });

    it('checks host names and CSP origins strictly', () => {
        expect(isHostName('app.example')).toBe(true);
        expect(isHostName('xn--bcher-kva.example')).toBe(true);
        for (const h of ['x;sandbox', "a'b.example", 'a$b.example', '-a.example', 'localhost', 'App.example'])
            expect([h, isHostName(h)]).toEqual([h, false]);
        expect(isCspOrigin('https://app.example')).toBe(true);
        expect(isCspOrigin('http://127.0.0.1:5173')).toBe(true);
        expect(isCspOrigin('https://x;sandbox')).toBe(false);
        expect(isCspOrigin('http://app.example')).toBe(false);
    });
});

describe('untrusted input in pages, headers and files', () => {
    it('sanitizes and encodes the self-declared name on the consent screen and the apps page', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example', { client_name: 'Good\u202e App\n<script>alert(1)</script>\u200b"x"' });
        const page = await request(app).get(authorizeUrl(c, 'write:/appdata/app.example/', pkce().challenge));
        expect(page.status).toBe(200);
        expect(page.text).toContain('Did you mean to log in with “<bdi>Good App &lt;script&gt;alert(1)&lt;/script&gt;&quot;x&quot;</bdi>”?');
        // The only script is the page's own owner.js.
        expect(page.text).not.toMatch(/<script(?! src="\/pups\/assets\/owner\.js")|\u202e|\u200b/);
        await connect(app, c, 'write:/appdata/app.example/');
        const apps = await request(app).post('/pups/apps').type('form').send({ show: '1', password: PASSWORD });
        expect(apps.text).toContain('<bdi>Good App &lt;script&gt;');
        expect(apps.text).not.toMatch(/<script(?! src="\/pups\/assets\/owner\.js")|\u202e/);
    });

    it('rejects unsafe URLs and host names in client metadata', async () => {
        const { app, registerClient } = setup();
        const { challenge } = pkce();
        for (const extra of [{ logo_uri: 'javascript:alert(1)' }, { logo_uri: 'https://app.example/a b.png' },
            { logo_uri: 'https://app.example/\u202egnp.png' }, { redirect_uris: ['https://app.example;sandbox/cb'] }]) {
            const c = registerClient('app.example', extra);
            const res = await request(app).get(authorizeUrl({ ...c, redirectUri: 'https://app.example;sandbox/cb' }, 'identify', challenge));
            expect([extra, res.status]).toEqual([extra, 400]);
        }
        const res = await request(app).get(authorizeUrl(registerClient('x;sandbox.example'), 'identify', challenge));
        expect(res.status).toBe(400);
        expect(res.text).toContain('may contain only letters, digits, hyphens and dots');
    });

    it('keeps the consent page CSP to plain origins', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example', { redirect_uris: ['http://127.0.0.1/cb'] });
        const res = await request(app).get(authorizeUrl({ ...c, redirectUri: 'http://127.0.0.1:5173/cb' }, 'identify', pkce().challenge));
        expect(res.headers['content-security-policy']).toContain("form-action 'self' http://127.0.0.1:5173;");
    });

    it('rejects invisible characters in paths, scopes and host-meta values', async () => {
        const { app, registerClient } = setup({
            PUPS_WELL_KNOWN_PATHS: JSON.stringify([
                { path: '/.well-known/about.md', url: `${ORIGIN}/.well-known/about.md`, properties: ['https://bigwide.net/ns/name'] },
                { path: '/feeds/' }]),
        });
        const c = registerClient('app.example');
        const res = await request(app).get(authorizeUrl(c, 'write:/feeds/%E2%80%AEx/', pkce().challenge));
        expect(new URL(res.headers.location).searchParams.get('error')).toBe('invalid_scope');
        const tok = (await connect(app, c, 'write:/appdata/app.example/ write:/.well-known/about.md')).access_token;
        expect((await put(app, '/appdata/app.example/%E2%80%AEnosj.json', tok, '{}')).status).toBe(400);
        expect((await put(app, '/appdata/app.example/a%E2%81%A6.json', tok, '{}')).status).toBe(400);
        const hm = (body: object) =>
            request(app).post('/pups/host-meta').set({ authorization: `Bearer ${tok}`, 'content-type': 'application/json' }).send(JSON.stringify(body));
        expect((await hm({ action: 'set-property', property: 'https://bigwide.net/ns/name', value: 'Alice\u202e' })).status).toBe(400);
        expect((await hm({ action: 'add', rel: 'https://app.example/r\u200b', href: `${ORIGIN}/appdata/app.example/a.json` })).status).toBe(400);
        // hrefs are stored in canonical form.
        expect((await hm({ action: 'add', rel: 'https://app.example/r', href: `${ORIGIN}/appdata/app.example/a<b>.json` })).status).toBe(201);
        expect((await request(app).get('/.well-known/host-meta.json')).body.links[1].href).toBe(`${ORIGIN}/appdata/app.example/a%3Cb%3E.json`);
    });
});

describe('size limits', () => {
    it('rejects oversized authorization parameters with an error page', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        const { challenge } = pkce();
        for (const extra of [{ state: 'x'.repeat(1025) }, { scope: 'identify '.repeat(300) }] as Record<string, string>[]) {
            const res = await request(app).get(authorizeUrl(c, 'identify', challenge, extra));
            expect(res.status).toBe(400);
            expect(res.headers['content-type']).toMatch(/^text\/html/);
            expect(res.text).toContain('is longer than');
        }
        const res = await request(app).get(authorizeUrl(c, Array.from({ length: 21 }, () => 'identify').join(' '), challenge));
        expect(new URL(res.headers.location).searchParams.get('error')).toBe('invalid_scope');
    });

    it('rejects oversized client metadata', async () => {
        const { app, registerClient } = setup();
        const { challenge } = pkce();
        for (const extra of [{ client_name: 'n'.repeat(1001) },
            { redirect_uris: Array.from({ length: 21 }, (_, i) => `https://app.example/cb${i}`) },
            { logo_uri: `https://app.example/${'l'.repeat(2048)}.png` }]) {
            const res = await request(app).get(authorizeUrl(registerClient('app.example', extra), 'identify', challenge));
            expect(res.status).toBe(400);
        }
        // A long but allowed name is shortened for display.
        const page = await request(app).get(authorizeUrl(registerClient('app.example', { client_name: 'n'.repeat(1000) }), 'identify', challenge));
        expect(page.text).toContain(`<bdi>${'n'.repeat(99)}…</bdi>`);
    });

    it('rejects oversized token requests, headers, paths and host-meta values', async () => {
        const { app, registerClient } = setup();
        const c = registerClient('app.example');
        let res = await request(app).post('/oauth/token').type('form').send({ grant_type: 'refresh_token', client_id: c.clientId, refresh_token: 't'.repeat(257) });
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('refresh_token is longer than 256');
        const tok = (await connect(app, c, 'write:/appdata/app.example/')).access_token;
        expect((await put(app, '/appdata/app.example/a.json', tok, '{}', { 'if-match': `"${'e'.repeat(1100)}"` })).status).toBe(400);
        expect((await put(app, `/appdata/app.example/${'p'.repeat(600)}.json`, tok, '{}')).status).toBe(400);
        res = await request(app).put('/appdata/app.example/a.json').set({ authorization: `Bearer ${'t'.repeat(2000)}`, 'content-type': 'application/json' }).send('{}');
        expect(res.status).toBe(401);
        res = await request(app).post('/pups/host-meta').set({ authorization: `Bearer ${tok}`, 'content-type': 'application/json' })
            .send(JSON.stringify({ action: 'set-property', property: `https://${'p'.repeat(600)}`, value: 'x' }));
        expect(res.status).toBe(400);
    });

    it('rejects oversized passwords on the apps page with an error page', async () => {
        const { app } = setup();
        const res = await request(app).post('/pups/apps').type('form').send({ show: '1', password: 'p'.repeat(1025) });
        expect(res.status).toBe(400);
        expect(res.text).toContain('password is longer than 1024 characters');
    });
});
