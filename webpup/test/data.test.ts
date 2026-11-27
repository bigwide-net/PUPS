import { archivesOf, archiveUrl, feedNameOf, findItem, loadSite, type SiteFeed } from '../src/data';
import { feedTitle } from '../src/posts';

const O = 'https://tim.example';
const feed = (title: string, extra = {}) => JSON.stringify({version: 'https://jsonfeed.org/version/1.1', title, items: [{id: '1', content_text: 'x'}], ...extra});

function mockFetch(files: Record<string, string>) {
    globalThis.fetch = jest.fn(async (url: string) => {
        const text = files[url.replace(O, '')];
        return {ok: text != undefined, status: text != undefined ? 200 : 404, text: async () => text};
    }) as any;
}

describe('feed names', () => {
    it.each([
        ['https://tim.example/feed.json', ''],
        ['/feed.json', ''],
        ['https://tim.example/feed/photos.json', 'photos'],
        ['https://tim.example/feed/feed.000001.json', undefined], // an archive, not a feed
        ['https://tim.example/feed/images.json', undefined],
        ['https://tim.example/feed/a/b.json', undefined],
        ['https://other.example/feed.json', undefined],
        ['https://tim.example/blog.xml', undefined],
    ])('%s → %j', (url, name) => expect(feedNameOf(url, O)).toBe(name));
});

describe('archives', () => {
    it('come from _archive, with its template and size', () => {
        const json = {version: 'https://jsonfeed.org/version/1.1', items: [],
            _archive: {archive_url: `${O}/a/7.json`, archive_template: `${O}/a/{number}.json`, archive_size: 50}};
        expect(archivesOf({...json, _archive: {...json._archive, archive_url: `${O}/a/000007.json`}}, O)).toEqual({template: `${O}/a/{number}.json`, newest: 7, size: 50});
        expect(archivesOf(json, O)).toBeUndefined();
        expect(archivesOf({...json, _archive: {archive_url: `${O}/feed/feed.000003.json`, archive_template: 'https://cdn.example/{number}.json'}}, O))
            .toEqual({template: `${O}/feed/feed.{number}.json`, newest: 3, size: 20});
    });

    it('come from _pups.archive_url of earlier drafts, on this site only', () => {
        const json = {version: 'https://jsonfeed.org/version/1.1', items: [], _pups: {archive_url: `${O}/feed/photos/feed.000012.json`}};
        const archives = archivesOf(json, O);
        expect(archives).toEqual({template: `${O}/feed/photos/feed.{number}.json`, newest: 12, size: 20});
        expect(archiveUrl({url: '', json, archives}, 3)).toBe(`${O}/feed/photos/feed.000003.json`);
        expect(archivesOf({...json, _pups: {archive_url: 'https://cdn.example/feed/feed.000001.json'}}, O)).toBeUndefined();
        expect(archivesOf({...json, _pups: {}}, O)).toBeUndefined();
        expect(archivesOf({...json, _pups: undefined, next_url: `${O}/feed/feed.000001.json`}, O)).toBeUndefined();
    });
});

describe('findItem', () => {
    // 47 items: archive 0 holds 0–19, 1 holds 20–39, 2 holds 40–46; the feed file the newest 30.
    const item = (i: number) => ({id: `p${i}`, content_text: `Post ${i}`, _archive: {index: i}});
    const range = (from: number, to: number) => Array.from({length: to - from + 1}, (_, k) => item(to - k));
    const archive = (from: number, to: number) => JSON.stringify({version: 'https://jsonfeed.org/version/1.1', items: range(from, to)});
    const withArchives = (prefix = `${O}/feed/feed.`): SiteFeed => ({url: `${O}/feed.json`, archives: {template: `${prefix}{number}.json`, newest: 2, size: 20},
        json: {version: 'https://jsonfeed.org/version/1.1', items: range(17, 46)}});

    it('finds the item in the feed file, then in the archive of its index', async () => {
        mockFetch({'/feed/feed.000000.json': archive(0, 19), '/feed/feed.000001.json': archive(20, 39), '/feed/feed.000002.json': archive(40, 46)});
        expect((await findItem(withArchives(), 30))?.id).toBe('p30');
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect((await findItem(withArchives(), 3))?.id).toBe('p3');
        expect((globalThis.fetch as jest.Mock).mock.calls.map(c => c[0])).toEqual([`${O}/feed/feed.000000.json`]);
        expect(await findItem(withArchives(), 99)).toBeUndefined();
    });

    it('goes down or up when the archives don’t start at multiples of 20', async () => {
        // Indexed after deletions: archive 0 holds 0–9, 1 holds 10–29, 2 holds 30–46.
        mockFetch({'/f2/feed.000000.json': archive(0, 9), '/f2/feed.000001.json': archive(10, 29), '/f2/feed.000002.json': archive(30, 46)});
        expect((await findItem(withArchives(`${O}/f2/feed.`), 12))?.id).toBe('p12'); // ⌊12/20⌋ = 0, then up
        mockFetch({'/f3/feed.000000.json': archive(0, 25), '/f3/feed.000001.json': archive(26, 39), '/f3/feed.000002.json': archive(40, 46)});
        expect((await findItem(withArchives(`${O}/f3/feed.`), 22))?.id).toBe('p22'); // ⌊22/20⌋ = 1, then down
    });

    it('looks only in the feed file of a feed without archives', async () => {
        mockFetch({});
        const f: SiteFeed = {url: `${O}/feed.json`, json: {version: 'https://jsonfeed.org/version/1.1', items: [item(5), {id: 'x', content_text: 'no index'}]}};
        expect((await findItem(f, 5))?.id).toBe('p5');
        expect(await findItem(f, 4)).toBeUndefined();
    });
});

describe('loadSite', () => {
    it('loads the main feed, the registered feeds of this site and the properties', async () => {
        mockFetch({
            '/.well-known/host-meta.json': JSON.stringify({
                links: [
                    {rel: 'https://bigwide.net/ns/personal-storage', href: `${O}/personal-storage.json`},
                    {rel: 'https://bigwide.net/ns/feed', href: `${O}/feed/photos.json`},
                    {rel: 'https://bigwide.net/ns/feed', href: `${O}/feed.json`},
                    {rel: 'https://bigwide.net/ns/feed', href: 'https://elsewhere.example/feed.json'},
                    {rel: 'https://bigwide.net/ns/feed', href: `${O}/feed/missing.json`},
                ],
                properties: {
                    'https://bigwide.net/ns/name': 'Tim', 'https://bigwide.net/ns/title': ' ', 'https://bigwide.net/ns/avatar': `${O}/pups/images/a.png`,
                    'https://bigwide.net/ns/banner': 'javascript:alert(1)', 'https://bigwide.net/ns/theme-color': '#336699',
                },
            }),
            '/feed.json': feed('Notes', {_pups: {pupsControlled: true}, _archive: {archive_url: `${O}/feed/feed.000002.json`}}),
            '/feed/photos.json': feed('Photos'),
            '/.well-known/about.md': '---\nsummary: Hi there\n---\n# About',
            '/webpup-config.json': '{"embeds":"consent"}',
        });
        const site = await loadSite(O);
        expect(site.feeds.map(f => [f.name, f.json.title, !!f.archives])).toEqual([[undefined, 'Notes', true], ['photos', 'Photos', false]]);
        expect(site.props).toEqual({name: 'Tim', title: undefined, summary: undefined, avatar: `${O}/pups/images/a.png`, banner: undefined, themeColor: '#336699', language: undefined});
        expect(site.about?.summary).toBe('Hi there');
        expect(site.following).toBeUndefined();
        expect(site.config).toEqual({embeds: 'consent', themeSelector: false});
    });

    it('leaves out feeds that need an identity token (RFC-10), and shows optional ones', async () => {
        const access = (href: string, level: string) => ({rel: 'https://bigwide.net/ns/feed', href, properties: {'https://bigwide.net/ns/access': level}});
        mockFetch({
            '/.well-known/host-meta.json': JSON.stringify({links: [
                access(`${O}/feed.json`, 'restricted'), access(`${O}/feed/queue.json`, 'personal'), access(`${O}/feed/poll.json`, 'optional'),
                access(`${O}/feed/odd.json`, 'friends-only'), access(`${O}/feed/photos.json`, 'public'),
            ]}),
            '/feed.json': feed('Notes'), '/feed/queue.json': feed('Queue'), '/feed/poll.json': feed('Poll'),
            '/feed/odd.json': feed('Odd'), '/feed/photos.json': feed('Photos'),
        });
        expect((await loadSite(O)).feeds.map(f => f.json.title)).toEqual(['Poll', 'Photos']);
    });

    it('takes the feeds\' titles from their links, in the site\'s language, else the feed\'s own', async () => {
        const link = (href: string, titles?: Record<string, string>) => ({rel: 'https://bigwide.net/ns/feed', href, titles});
        mockFetch({
            '/.well-known/host-meta.json': JSON.stringify({
                links: [link(`${O}/feed.json`, {default: 'Notes from Tim'}), link(`${O}/feed/photos.json`, {default: 'Photos', de: 'Fotos'}), link(`${O}/feed/links.json`)],
                properties: {'https://bigwide.net/ns/language': 'de'},
            }),
            '/feed.json': feed('Notes'), '/feed/photos.json': feed('Pictures'), '/feed/links.json': feed('Links'),
        });
        const feeds = (await loadSite(O)).feeds;
        expect(feeds.map(f => [f.title, feedTitle(f)])).toEqual([['Notes from Tim', 'Notes from Tim'], ['Fotos', 'Fotos'], [undefined, 'Links']]);
    });

    it('works without host-meta.json and config: /feed.json only, embeds on', async () => {
        mockFetch({'/feed.json': feed('Notes'), '/webpup-config.json': '{"embeds": "maybe"}'});
        const site = await loadSite(O);
        expect(site.feeds.length).toBe(1);
        expect(site.config.embeds).toBe('on');
        expect(site.props.name).toBeUndefined();
    });

    it('loads the pages in the order of host-meta.json, with titles, unique names and hidden ones, and the footer', async () => {
        mockFetch({
            '/.well-known/host-meta.json': JSON.stringify({
                links: [
                    {rel: 'https://bigwide.net/ns/webpup-pages', href: `${O}/pups/pages/Über uns.md`},
                    {rel: 'https://bigwide.net/ns/webpup-pages', href: `${O}/a/imprint.md`, titles: {default: 'Impressum', en: 'Imprint'},
                        properties: {'https://bigwide.net/ns/webpup-hidden': 'true'}},
                    {rel: 'https://bigwide.net/ns/webpup-pages', href: `${O}/b/imprint.md`},
                    {rel: 'https://bigwide.net/ns/webpup-pages', href: `${O}/missing.md`},
                    {rel: 'https://bigwide.net/ns/webpup-pages', href: 'https://elsewhere.example/x.md'},
                ],
                properties: {'https://bigwide.net/ns/webpup-footer': `${O}/pups/footer.md`, 'https://bigwide.net/ns/language': 'en'},
            }),
            '/pups/pages/%C3%9Cber%20uns.md': '# About *us*\n\nText',
            '/a/imprint.md': 'Address',
            '/b/imprint.md': 'No heading',
            '/pups/footer.md': '© Tim',
        });
        const site = await loadSite(O);
        expect(site.pages.map(p => [p.name, p.title, p.hidden])).toEqual([
            ['uber-uns', 'About us', false],
            ['imprint', 'Imprint', true],
            ['imprint-2', 'Imprint', false],
        ]);
        expect(site.footer).toEqual({url: `${O}/pups/footer.md`, markdown: '© Tim'});
    });

    it('shows the theme selector without a webpup-config.json, and with one only if it says so', async () => {
        mockFetch({});
        expect((await loadSite(O)).config.themeSelector).toBe(true);
        mockFetch({'/webpup-config.json': '{}'});
        expect((await loadSite(O)).config.themeSelector).toBe(false);
        mockFetch({'/webpup-config.json': '{"theme-selector": true}'});
        expect((await loadSite(O)).config.themeSelector).toBe(true);
    });

    it('takes the owner link and the settings URL only as paths on the site', async () => {
        mockFetch({'/webpup-config.json': '{"owner-link": "/pups/", "settings-url": "/pups/homepage"}'});
        expect((await loadSite(O)).config).toEqual({embeds: 'on', themeSelector: false, ownerLink: '/pups/', settingsUrl: '/pups/homepage'});
        mockFetch({'/webpup-config.json': '{"owner-link": "//evil.example/", "settings-url": "https://evil.example/"}'});
        expect((await loadSite(O)).config).toEqual({embeds: 'on', themeSelector: false});
    });
});
