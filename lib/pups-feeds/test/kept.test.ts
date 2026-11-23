import { describe, expect, it } from 'vitest'
import { ARCHIVE_SPEC, archiveOwner, type FeedHost, FeedError, isFeedPath, postItem, putKeptFeed, readItem } from '../src'

// The PHP tests of kept feeds (pups-php/tests/feed_test.php), against the shared logic with in-memory storage.
const ORIGIN = 'https://alice.pups.test'
const FEED = `${ORIGIN}/feed.json`
const archive = (n: number) => `${ORIGIN}/feed/feed.${String(n).padStart(6, '0')}.json`
const WELL_KNOWN = [{ path: '/feed.json', rels: ['https://bigwide.net/ns/feed'] }, { path: '/feed/', rels: ['https://bigwide.net/ns/feed'] }]

function server(template?: string) {
  const files = new Map<string, string>()
  let now = Date.parse('2026-11-20T10:00:00Z')
  const host: FeedHost = {
    me: `${ORIGIN}/`, publicUrl: path => ORIGIN + path, pathFromPublicUrl: url => url.startsWith(ORIGIN + '/') ? url.slice(ORIGIN.length) : undefined,
    read: async path => files.get(path), postUrlTemplate: async () => template, now: () => now += 1000,
  }
  const write = (files_: { path: string; text: string }[]) => files_.forEach(f => files.set(f.path, f.text))
  /** A request like the server makes it: errors become statuses. */
  const answer = async (fn: () => Promise<{ status: number; body: any; headers?: Record<string, string> }>) => {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof FeedError) return { status: e.status, body: { error: e.code, message: e.message }, headers: {} }
      throw e
    }
  }
  const put = (path: string, body: unknown) => answer(async () => {
    const existing = files.get(path)
    const c = await putKeptFeed(host, path, JSON.stringify(body), existing)
    write(c.files)
    return { status: existing ? 200 : 201, body: JSON.parse(c.text) }
  })
  const post = (item: unknown, path = '/feed.json') => answer(async () => {
    const r = await postItem(host, path, readItem('application/json', JSON.stringify(item)), files.get(path))
    if (r.committed) write(r.committed.files)
    return r
  })
  const stored = (path: string) => JSON.parse(files.get(path)!)
  return { files, host, put, post, stored }
}

const feedBody = (extra: Record<string, unknown> = {}) => ({ version: 'https://jsonfeed.org/version/1.1', title: 'Notes', items: [], _pups: { pupsControlled: true }, ...extra })
const ids = (doc: any) => doc.items.map((i: any) => i.id)
const indexes = (doc: any) => doc.items.map((i: any) => i._archive?.index)
const range = (from: number, to: number) => Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => from < to ? from + i : from - i)

async function postMany(t: ReturnType<typeof server>, from: number, to: number) {
  for (let i = from; i <= to; i++) expect((await t.post({ id: `p${i}`, content_text: `Post ${i}` })).status, `post ${i}`).toBe(201)
}

describe('kept feeds', () => {
  it('are the declared feed files; archives belong to them', () => {
    expect(['/feed.json', '/feed/photos.json', '/feed/images.json', '/feed/a/b.json', '/appdata/x/feed.json'].map(p => isFeedPath(p, WELL_KNOWN)))
      .toEqual([true, true, false, false, false])
    expect([archiveOwner('/feed/feed.000002.json', WELL_KNOWN), archiveOwner('/feed/photos/feed.000000.json', WELL_KNOWN), archiveOwner('/feed/x.json', WELL_KNOWN)])
      .toEqual(['/feed.json', '/feed/photos.json', undefined])
  })

  it('creating a feed sets the fixed fields and answers with the feed as stored', async () => {
    const t = server()
    const res = await t.put('/feed.json', feedBody({ home_page_url: 'https://elsewhere.example/', description: 'Mine' }))
    expect(res.status).toBe(201)
    const doc = res.body
    expect([doc.home_page_url, doc.feed_url, doc.description, doc.items, doc._pups.pupsControlled]).toEqual([`${ORIGIN}/`, FEED, 'Mine', [], true])
    expect(doc.user_comment).toContain('Personal Upload Server')
    expect(doc._archive).toBeUndefined()
    expect(t.stored('/feed.json')).toEqual(doc)
  })

  it('posted items get indexes and go into archives of 20; the feed file keeps the newest 30', async () => {
    const t = server()
    await t.put('/feed.json', feedBody())
    const res = await t.post({ id: 'p0', content_text: 'Post 0' })
    expect([res.status, res.headers!.Location, res.body.address, res.body.item._archive.index]).toEqual([201, `${archive(0)}#p0`, `${archive(0)}#p0`, 0])
    expect(res.body.item.date_published).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    await postMany(t, 1, 44)

    const feed = t.stored('/feed.json')
    expect(ids(feed)).toEqual(range(44, 15).map(i => `p${i}`))
    expect(feed._archive).toEqual({ about: ARCHIVE_SPEC, archive_url: archive(2), archive_template: `${ORIGIN}/feed/feed.{number}.json`, archive_size: 20 })
    expect(feed.next_url).toBeUndefined()
    const a = [0, 1, 2].map(n => t.stored(`/feed/feed.00000${n}.json`))
    expect(a.map(indexes)).toEqual([range(19, 0), range(39, 20), range(44, 40)])
    expect([a[0]._archive, a[2]._archive.next_index, a[2].next_url, a[1].next_url, a[0].next_url])
      .toEqual([{ about: ARCHIVE_SPEC, updates_url: FEED, number: 0 }, 45, archive(1), archive(0), undefined])
    expect(a[1]._archive.next_index).toBeUndefined()
    expect([a[1].feed_url, a[1].title, a[1]._pups.pupsControlled]).toEqual([archive(1), 'Notes', true])
    expect(a[1].user_comment).toContain(`This is an archive of ${FEED}`)
  })

  it('an item is replaced by its index, or by its id while it is among the newest', async () => {
    const t = server()
    await t.put('/feed.json', feedBody())
    await postMany(t, 0, 44)
    const old = t.stored('/feed/feed.000000.json').items[19]
    expect(old.id).toBe('p0')

    const res = await t.post({ ...old, content_text: 'Edited' })
    expect([res.status, res.body.address, res.body.item.content_text, res.body.item.date_published]).toEqual([200, `${archive(0)}#p0`, 'Edited', old.date_published])
    expect(res.body.item.date_modified).toBeTypeOf('string')
    expect(t.stored('/feed/feed.000000.json').items[19].content_text).toBe('Edited')

    // Sent again unchanged: nothing is written.
    const before = t.files.get('/feed/feed.000000.json')
    const again = await t.post(t.stored('/feed/feed.000000.json').items[19])
    expect([again.status, (again as any).committed]).toEqual([200, undefined])
    expect(t.files.get('/feed/feed.000000.json')).toBe(before)

    // A repeated request for a new item replaces it instead of adding it twice.
    expect((await t.post({ id: 'p44', content_text: 'Post 44 again' })).status).toBe(200)
    expect([t.stored('/feed/feed.000002.json').items.length, t.stored('/feed/feed.000002.json')._archive.next_index]).toEqual([5, 45])
    expect(t.stored('/feed.json').items[0].content_text).toBe('Post 44 again')

    // An index that no item has, or that belongs to another item.
    expect((await t.post({ id: 'p3', content_text: 'x', _archive: { index: 4 } })).status).toBe(404)
    expect((await t.post({ id: 'p5', content_text: 'no content', _archive: { index: 5 } })).status).toBe(200)
    expect((await t.post({ id: 'p6' })).body.error).toBe('invalid_request')
  })

  it('deleting an item leaves a gap and fills the feed file up again from the archives', async () => {
    const t = server()
    await t.put('/feed.json', feedBody())
    await postMany(t, 0, 44)
    const res = await t.post({ id: 'p30', _pups: { delete: true } })
    expect([res.status, res.body.address, res.body.item.content_text]).toEqual([200, `${archive(1)}#p30`, 'Post 30'])
    const feed = t.stored('/feed.json')
    expect([feed.items.length, feed.items.at(-1).id, ids(feed).includes('p30')]).toEqual([30, 'p14', false])
    expect(t.stored('/feed/feed.000001.json').items).toHaveLength(19)
    expect((await t.post({ id: 'p2', _pups: { delete: true } })).status).toBe(200)
    expect(t.stored('/feed/feed.000000.json').items).toHaveLength(19)
    expect((await t.post({ id: 'p2', _pups: { delete: true } })).status).toBe(404)
    expect((await t.post({ id: 'p2', content_text: 'Back', _archive: { index: 2 } })).status).toBe(404)
    expect((await t.post({ id: 'p45', content_text: 'New' })).body.item._archive.index).toBe(45)
  })

  it('a PUT of the feed file adds, changes and deletes items, and changes the settings', async () => {
    const t = server()
    await t.put('/feed.json', feedBody())
    await postMany(t, 0, 24)
    const feed = t.stored('/feed.json')
    feed.title = 'Renamed'
    feed._submissions = { url: 'https://rm.example/m' }
    feed.items[1].content_text = 'Changed'
    feed.items.splice(10, 1)
    feed.items.unshift({ id: 'n1', content_text: 'New 1' }, { id: 'n2', content_text: 'New 2' })
    feed._archive.archive_url = 'https://evil.example/x.json'
    const res = await t.put('/feed.json', feed)
    expect(res.status).toBe(200)
    const doc = res.body
    expect([doc.title, doc._archive.archive_url, doc._submissions.url]).toEqual(['Renamed', archive(1), 'https://rm.example/m'])
    expect(ids(doc).slice(0, 3)).toEqual(['n1', 'n2', 'p24'])
    expect(indexes(doc).slice(0, 2)).toEqual([26, 25])
    const a0 = t.stored('/feed/feed.000000.json'), a1 = t.stored('/feed/feed.000001.json')
    expect([ids(a0).includes('p14'), a1.items[3].content_text, ids(a1)[0]]).toEqual([false, 'Changed', 'n1'])
    expect(a1.items[3].date_modified).toBeTypeOf('string')
    expect(a1._submissions).toBeUndefined()

    doc.items[1].id = doc.items[0].id
    expect((await t.put('/feed.json', doc)).status).toBe(400)
  })

  it('refuses posts to feeds without the marker, and kept feed files that are no JSON Feed', async () => {
    const t = server()
    t.files.set('/feed/photos.json', JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'By hand', items: [] }))
    expect((await t.post({ content_text: 'Hi' }, '/feed/photos.json')).body.error).toBe('not_pups_controlled')
    expect((await t.post({ content_text: 'Hi' }, '/feed/nothing.json')).status).toBe(404)
    expect((await t.put('/feed.json', { _pups: { pupsControlled: true }, title: 'x' })).status).toBe(400)
    expect(() => readItem('text/plain', '{}')).toThrow(FeedError)
    expect(() => readItem('application/json', '[1]')).toThrow('JSON Feed item')
  })

  it('a handed-over feed gets archives with its items, oldest first, continuing its next_url', async () => {
    const t = server()
    const items = range(24, 0).map(i => ({ id: `h${i}`, content_text: `Hand ${i}` }))
    t.files.set('/feed.json', JSON.stringify({ version: 'https://jsonfeed.org/version/1', title: 'By hand', author: { name: 'Alice' },
      next_url: 'https://alice.pups.test/old/page2.json', _pups: { pupsControlled: true }, items }))
    expect((await t.post({ id: 'new', content_text: 'New' })).body.item._archive.index).toBe(25)
    const a0 = t.stored('/feed/feed.000000.json')
    expect([indexes(a0)[0], a0.items.at(-1).id, a0.items.at(-1)._archive.index, a0.next_url]).toEqual([19, 'h0', 0, 'https://alice.pups.test/old/page2.json'])
    expect(ids(t.stored('/feed/feed.000001.json'))).toEqual(['new', 'h24', 'h23', 'h22', 'h21', 'h20'])
    const feed = t.stored('/feed.json')
    expect([feed.version, feed.authors, feed.author, feed.next_url, feed.items[0].id])
      .toEqual(['https://jsonfeed.org/version/1.1', [{ name: 'Alice' }], undefined, undefined, 'new'])
  })

  it('new items get the URL of their page from the post URL template', async () => {
    const t = server(`${ORIGIN}/p/{feed}/post/{index}`)
    await t.put('/feed/photos.json', feedBody())
    const res = await t.post({ id: 'a', content_text: 'A' }, '/feed/photos.json')
    expect(res.body).toEqual({
      item: { id: 'a', content_text: 'A', date_published: t.stored('/feed/photos/feed.000000.json').items[0].date_published, _archive: { index: 0 }, url: `${ORIGIN}/p/feed/photos/post/0` },
      address: `${ORIGIN}/feed/photos/feed.000000.json#a`,
    })
    expect((await t.post({ id: 'b', content_text: 'B', url: 'https://elsewhere.example/b' }, '/feed/photos.json')).body.item.url).toBe('https://elsewhere.example/b')
    expect(t.stored('/feed/photos.json')._archive.archive_template).toBe(`${ORIGIN}/feed/photos/feed.{number}.json`)
  })

  it('gives items without an id one', async () => {
    const t = server()
    await t.put('/feed.json', feedBody())
    const res = await t.post({ content_text: 'Hi' })
    expect([res.status, res.body.item._archive.index]).toEqual([201, 0])
    expect(res.body.item.id).toMatch(/^p-[\w-]{16}$/)
    expect(Object.keys(res.body.item)[0]).toBe('id')
  })
})
