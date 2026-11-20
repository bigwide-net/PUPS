import { httpsFetchDoc, isPublicAddress } from '../lib/cimd';
import { loadConfig, parseWellKnown } from '../lib/config';
import { isPrivate, parsePath, parseScope, readPrefixes } from '../lib/paths';

const config = loadConfig({ PUPS_ORIGIN: 'https://alice.pups.test', PUPS_PASSWORD: '12345678', PUPS_DATA_DIR: '/tmp/unused' });

describe('SSRF protection', () => {
    it('classifies addresses', () => {
        for (const [a, f] of [['127.0.0.1', 4], ['10.1.2.3', 4], ['192.168.1.1', 4], ['169.254.169.254', 4], ['::1', 6], ['fd00::1', 6], ['::ffff:127.0.0.1', 6]] as const)
            expect([a, isPublicAddress(a, f)]).toEqual([a, false]);
        for (const [a, f] of [['1.1.1.1', 4], ['93.184.215.14', 4], ['2606:4700::1111', 6]] as const)
            expect([a, isPublicAddress(a, f)]).toEqual([a, true]);
    });

    it('refuses to fetch from names that resolve to private addresses', async () => {
        await expect(httpsFetchDoc(config)('https://localhost/client.json')).rejects.toThrow(/non-public/);
    });
});

describe('configuration', () => {
    it('requires a password', () => {
        expect(() => loadConfig({ PUPS_PASSWORD: 'short' })).toThrow(/PUPS_PASSWORD/);
    });

    it('rejects dangerous well-known paths', () => {
        const origin = 'https://alice.pups.test';
        for (const path of ['/.well-known/host-meta.json', '/.well-known/acme-challenge/', '/.well-known/x/y.json', '/appdata/x/', '/.hidden/', '/oauth/', '/pups/x.json', '/pups/', '/pups/apps', '/pups/imagesx/', '/personal-storage.json'])
            expect(() => parseWellKnown(JSON.stringify([{ path }]), origin)).toThrow();
        expect(parseWellKnown(JSON.stringify([{ path: '/feeds/bigwide/', rels: ['https://bigwide.net/ns/feed'] }]), origin)[0].rels)
            .toEqual(['https://bigwide.net/ns/feed']);
        expect(parseWellKnown(JSON.stringify([{ path: '/pups/images/' }]), origin)[0].path).toBe('/pups/images/');
        expect(parseWellKnown(JSON.stringify([{ path: '/pups/pages/', link_properties: ['https://bigwide.net/ns/webpup-hidden'] }]), origin)[0].linkProperties)
            .toEqual(['https://bigwide.net/ns/webpup-hidden']);
        expect(() => parseWellKnown(JSON.stringify([{ path: '/pups/pages/', link_properties: ['https://bigwide.net/ns/pups#client'] }]), origin)).toThrow();
        expect(() => parseWellKnown(JSON.stringify([{ path: '/pups/pagesx/' }]), origin)).toThrow();
    });

    it('accepts paths inside /pups/private/ only without url, rels and properties', () => {
        const origin = 'https://alice.pups.test';
        for (const path of ['/pups/private/inbox/', '/pups/private/settings.json'])
            expect(parseWellKnown(JSON.stringify([{ path }]), origin)[0]).toMatchObject({ path, url: undefined, rels: [], properties: [] });
        for (const path of ['/pups/private/', '/pups/privatex/'])
            expect(() => parseWellKnown(JSON.stringify([{ path }]), origin)).toThrow();
        for (const extra of [{ url: `${origin}/pups/private/inbox/` }, { rels: ['https://bigwide.net/ns/feed'] }, { properties: ['https://bigwide.net/ns/name'] },
            { link_properties: ['https://bigwide.net/ns/webpup-hidden'] }, { url_properties: ['https://bigwide.net/ns/avatar'] }])
            expect(() => parseWellKnown(JSON.stringify([{ path: '/pups/private/inbox/', ...extra }]), origin)).toThrow(/Private paths/);
        expect(config.wellKnown.some(e => isPrivate(e.path))).toBe(false);
    });

    it('declares the list of well-known paths by default', () => {
        const images = config.wellKnown.find(e => e.path == '/pups/images/')!;
        expect(images.urlProperties).toEqual(['https://bigwide.net/ns/avatar', 'https://bigwide.net/ns/banner']);
        expect(config.wellKnown.filter(e => e.rels.includes('https://bigwide.net/ns/feed')).map(e => e.path)).toEqual(['/feed.json', '/feed/']);
        expect(config.wellKnown.every(e => !e.singleRels.length)).toBe(true);
    });
});

describe('paths and scopes', () => {
    it('allows dot segments only for declared /.well-known/ files', () => {
        expect(parsePath('/.well-known/about.md', config)).toEqual({ path: '/.well-known/about.md' });
        expect(parsePath('/.well-known/other.md', config)).toHaveProperty('error');
        expect(parsePath('/a/%E2%82%AC.json', config)).toEqual({ path: '/a/€.json' });
    });

    it('accepts only the own directory and declared well-known paths', () => {
        expect(parseScope('write:/appdata/app.example/', 'app.example', config)).toBeTruthy();
        expect(parseScope('write:/appdata/app.example/sub/', 'app.example', config)).toBeUndefined();
        expect(parseScope('write:/.well-known/about.md', 'app.example', config)?.kind).toBe('write');
        expect(parseScope('write:/', 'app.example', config)).toBeUndefined();
    });

    it('knows the private areas', () => {
        for (const p of ['/pups/private/inbox/a.json', '/pups/private/inbox/', '/appdata/app.example/private/a.json', '/appdata/other.example/private/x/y.json', '/APPDATA/app.example/PRIVATE/a.json', '/Pups/Private/inbox/a.json'])
            expect([p, isPrivate(p)]).toEqual([p, true]);
        for (const p of ['/pups/privatex/a.json', '/pups/images/a.png', '/appdata/app.example/private', '/appdata/app.example/private.json',
            '/appdata/app.example/x/private/a.json', '/appdata/private/a.json', '/feed/private/a.json'])
            expect([p, isPrivate(p)]).toEqual([p, false]);
    });

    it('accepts read scopes only for declared paths in /pups/private/', () => {
        const c = { ...config, wellKnown: parseWellKnown(JSON.stringify([{ path: '/pups/private/inbox/' }, { path: '/feed.json' }]), config.origin) };
        expect(parseScope('read:/pups/private/inbox/', 'app.example', c)).toMatchObject({ kind: 'read', prefix: '/pups/private/inbox/' });
        expect(parseScope('read:/pups/private/inbox/2026/a.json', 'app.example', c)?.kind).toBe('read');
        expect(parseScope('write:/pups/private/inbox/', 'app.example', c)?.kind).toBe('write');
        for (const s of ['read:/pups/private/', 'read:/pups/private/other/', 'read:/feed.json', 'read:/appdata/app.example/',
            'read:/appdata/app.example/private/', 'read:/', 'read:', 'write:/pups/private/other/'])
            expect([s, parseScope(s, 'app.example', c)]).toEqual([s, undefined]);
        expect(readPrefixes('identify write:/appdata/app.example/ read:/pups/private/inbox/')).toEqual(['/appdata/app.example/', '/pups/private/inbox/']);
    });
});
