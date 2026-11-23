import { describe, expect, it } from 'vitest'
import {
  commentEndpoint, commentStatusEndpoint, dismissPage, handles, inboxActionEndpoint, inboxItem, inboxSummary, mentionEndpoint, processQueue,
  putInboxItem, visibleText,
} from '../src'
import { COMMENTS, feedDoc, inbox, jsonFeed, MENTION, ORIGIN, testReceiver, webmention } from './helpers'

const SRC = 'http://source.scripting.com/'

/** The owner's main feed, with comments at the built-in endpoint. */
function ownerFeed(files: Map<string, string>, policy: Record<string, unknown> = {}, items: unknown[] = [], extra: Record<string, unknown> = {}) {
  items = items.length ? items : [{ id: 'p-12', title: 'Is RSS the better social network?', content_html: '<p>I think so.</p>' }]
  files.set('/feed.json', jsonFeed(items, {
    ...extra, _submissions: { url: COMMENTS, republish: 'no', policies: { comments: { minLength: 2, maxLength: 200, title: 'none', ...policy } } },
  }))
}

const bobComment = (extra: Record<string, unknown> = {}) => ({
  id: 'c-17', authors: [{ name: 'Bob' }],
  content_html: '<p>Agreed, <script>alert(1)</script>but <a href="javascript:x">discovery</a> is <b onclick="x">hard</b>.</p>',
  _source: { accounts: { socialspec: '@bob.example' }, inReplyTo: `${ORIGIN}/feed.json#p-12` }, ...extra,
})

describe('handles', () => {
  it('are found as RFC-11 describes, not in e-mail and fediverse addresses or paths', () => {
    expect(handles('Great talk by @Tim.Example.com yesterday. Thanks, @alice.pups.test.')).toEqual(['tim.example.com', 'alice.pups.test'])
    expect(handles('(@a.example), "@b.example"! @c.example: @d.example;')).toEqual(['a.example', 'b.example', 'c.example', 'd.example'])
    expect(handles('tim@tim.example.com @tim@social.example @x.example/path @x-.example @nolabel @1.2 x@y.example.com .@z.example')).toEqual([])
    expect(handles('@x.example.com- @x.example_y @a.example.com.au @b.example.com-y')).toEqual(['a.example.com.au', 'b.example.com-y'])
    expect(handles('@foo.com,@bar.com;@baz.com (@x.example, @y.example).')).toEqual(['foo.com', 'bar.com', 'baz.com', 'x.example', 'y.example'])
    expect(handles('I did this thanks to @foo.com. And @bar.com!\nAlso @baz.com.')).toEqual(['foo.com', 'bar.com', 'baz.com'])
    expect(handles('Thanks to @a.example/@b.example/@c.example! @d.example/@e.example/path x/@f.example @g.example/@nodot'))
      .toEqual(['a.example', 'b.example', 'c.example'])
    expect(handles('Grüße an @müller.example')).toEqual(['xn--mller-kva.example'])
    expect(visibleText('<p>Hi <a href="https://alice.pups.test/">@alice.pups.test</a></p><pre>@code.example</pre>', true)).toBe('Hi @alice.pups.test')
  })
})

describe('mentions', () => {
  it('reach the inbox when the post names the owner, attributed and with Dismiss', async () => {
    const { r, files, web } = await testReceiver()
    const src = 'https://bob.example/feed/feed.000004.json'
    web.set(src, feedDoc([{
      id: 'p-81', url: 'https://bob.example/2026/feeds', title: 'Feeds are back', date_published: '2026-11-19T09:00:00Z',
      content_html: '<p>Great talk by <a href="https://alice.pups.test/">@alice.pups.test</a> yesterday.</p>', authors: [{ name: 'Bob' }],
      _source: { accounts: { socialspec: '@bob.example' } },
    }]))
    const res = (await mentionEndpoint(webmention(MENTION, `${src}#p-81`, `${ORIGIN}/`), r))!
    expect(res.status).toBe(202)
    expect(inbox(files)).toBeUndefined()
    expect(await processQueue(r)).toBe(1)
    const feed = inbox(files)
    expect([feed._inbox.writer, feed._inbox.categories]).toEqual(['pups', ['mentions', 'moderation']])
    const item = feed.items[0]
    expect(item._inbox).toMatchObject({ type: 'mention', source: `${src}#p-81`, target: `${ORIGIN}/`, postDate: '2026-11-19T09:00:00Z' })
    expect([item.title, item.url, item.authors[0].name, item._source.accounts.socialspec])
      .toEqual(['Feeds are back', 'https://bob.example/2026/feeds', 'Bob', '@bob.example'])
    expect(item.content_html).toContain('<p>Great talk by @alice.pups.test yesterday.</p><p class="without-extension-actions">Mention from @bob.example at ' +
      `<a href="${src}#p-81">bob.example/feed/feed.000004.json#p-81</a></p>` +
      `<p class="without-extension-actions"><a href="${ORIGIN}/pups/inbox/dismiss?id=${item.id}&amp;key=`)
    expect(item._actions.actions).toEqual([
      { type: 'display', text: 'Mention from @bob.example at bob.example/feed/feed.000004.json#p-81', url: `${src}#p-81` }, { template: 'dismiss' }])
    expect(feed._actions.templates.dismiss.action).toContain(`${ORIGIN}/pups/inbox/action?id={id}&key=`)

    // The same webmention again changes nothing; once the handle is gone, the mention is removed.
    await mentionEndpoint(webmention(MENTION, `${src}#p-81`, `${ORIGIN}/`), r)
    await processQueue(r)
    expect(inbox(files).items).toHaveLength(1)
    web.set(src, feedDoc([{ id: 'p-81', content_html: '<p>Great talk yesterday.</p>' }]))
    await mentionEndpoint(webmention(MENTION, `${src}#p-81`, `${ORIGIN}/`), r)
    await processQueue(r)
    expect(inbox(files).items).toEqual([])
  })

  it('never reach the inbox when invalid; deleted posts withdraw theirs; errors change nothing', async () => {
    const { r, files, web } = await testReceiver()
    const src = 'https://bob.example/feed.json'
    web.set(src, feedDoc([{ id: 'a', content_html: '<p>mail me: x@alice.pups.test, <code>@alice.pups.test</code></p>' },
      { id: 'b', content_text: 'Hello @alice.pups.test', _source: { accounts: { socialspec: '@mallory.example' } } }]))
    for (const s of ['a', 'missing', 'b']) await mentionEndpoint(webmention(MENTION, `${src}#${s}`, `${ORIGIN}/`), r)
    await processQueue(r)
    const items = inbox(files).items
    expect(items).toHaveLength(1)
    expect(items[0]._source).toBeUndefined()
    expect(items[0].authors[0].name).toBe('bob.example')

    web.get(src)!.status = 500
    await mentionEndpoint(webmention(MENTION, `${src}#b`, `${ORIGIN}/`), r)
    await processQueue(r)
    expect(inbox(files).items).toHaveLength(1)
    web.get(src)!.status = 410
    await mentionEndpoint(webmention(MENTION, `${src}#b`, `${ORIGIN}/`), r)
    await processQueue(r)
    expect(inbox(files).items).toEqual([])

    // The owner's own posts, and documents that aren't feeds, are ignored.
    files.set('/elsewhere.json', jsonFeed([{ id: 'x', content_text: '@alice.pups.test' }]))
    web.set('https://bob.example/x.txt', { status: 200, headers: { 'content-type': 'text/plain' }, body: 'hi @alice.pups.test' })
    await mentionEndpoint(webmention(MENTION, `${ORIGIN}/elsewhere.json#x`, `${ORIGIN}/`), r)
    await mentionEndpoint(webmention(MENTION, 'https://bob.example/x.txt', `${ORIGIN}/`), r)
    await processQueue(r)
    expect(inbox(files).items).toEqual([])
  })

  it('are checked at once; the queue is limited per host and in total', async () => {
    const { r } = await testReceiver()
    for (const [s, t] of [['https://bob.example/f.json', 'https://bob.example/f.json'], ['ftp://bob.example/f', `${ORIGIN}/`],
      ['https://bob.example/f.json#1', `${ORIGIN}/about`], ['https://bob.example/f.json#1', 'https://other.example/'],
      ['https://bob.example/f‮.json', `${ORIGIN}/`]]) {
      const res = (await mentionEndpoint(webmention(MENTION, s!, t!), r))!
      expect([res.status, typeof (await res.json()).message]).toEqual([400, 'string'])
    }
    expect((await mentionEndpoint(new Request(MENTION), r))!.status).toBe(405)
    const json = new Request(MENTION, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'https://bob.example/f.json#1', target: `${ORIGIN}/` }),
    })
    expect((await mentionEndpoint(json, r))!.status).toBe(202)
    for (let i = 2; i <= 5; i++) expect((await mentionEndpoint(webmention(MENTION, `https://bob.example/f.json#${i}`, `${ORIGIN}/`), r))!.status).toBe(202)
    expect((await mentionEndpoint(webmention(MENTION, 'https://bob.example/f.json#1', `${ORIGIN}/`), r))!.status).toBe(202)
    const full = (await mentionEndpoint(webmention(MENTION, 'https://bob.example/f.json#6', `${ORIGIN}/`), r))!
    expect([full.status, full.headers.get('retry-after')]).toEqual([429, '60'])
    expect((await mentionEndpoint(webmention(MENTION, 'https://carol.example/f.json#1', `${ORIGIN}/`), r))!.status).toBe(202)
    const off = await testReceiver({ mentions: false })
    expect(await mentionEndpoint(webmention(MENTION, 'https://bob.example/f.json#1', `${ORIGIN}/`), off.r)).toBeUndefined()
  })

  it('come from RSS, HTML pages with h-entry and redirects; never from the own endpoints', async () => {
    const { r, files, web, fetched } = await testReceiver()
    web.set('https://bob.example/rss.xml', {
      status: 200, headers: { 'content-type': 'application/rss+xml' }, body: `<?xml version="1.0"?>
<rss version="2.0" xmlns:source="${SRC}" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Bob</title>
<source:account service="socialspec">@bob.example</source:account>
<item><guid>r1</guid><title>Hello</title><dc:creator>Bob</dc:creator><description>&lt;p&gt;Hi @alice.pups.test!&lt;/p&gt;</description><pubDate>Thu, 19 Nov 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`,
    })
    web.set('https://carol.example/post', {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<!doctype html><html><head><title>Carol's blog</title></head>
<body><nav>@nav.example</nav><article class="h-entry"><h1 class="p-name">Shout-out</h1><a class="p-author h-card" href="/"><span class="p-name">Carol</span></a>
<div class="e-content"><p>Thanks <a href="https://alice.pups.test/">@alice.pups.test</a>!</p></div></article></body></html>`,
    })
    web.set('https://dave.example/old', { status: 301, headers: { location: '/new' }, body: '' })
    web.set('https://dave.example/new', feedDoc([{ id: 'd', content_text: 'cc @alice.pups.test' }]))
    web.set('https://loop.example/a', { status: 302, headers: { location: 'https://loop.example/a' }, body: '' })
    for (const s of ['https://bob.example/rss.xml#r1', 'https://carol.example/post', 'https://dave.example/old#d', 'https://loop.example/a#x', `${MENTION}?x#y`])
      await mentionEndpoint(webmention(MENTION, s, `${ORIGIN}/`), r)
    await processQueue(r)
    const by = Object.fromEntries(inbox(files).items.map((i: any) => [i._inbox.source, i]))
    expect(Object.keys(by).sort()).toEqual(['https://bob.example/rss.xml#r1', 'https://carol.example/post', 'https://dave.example/old#d'])
    const rss = by['https://bob.example/rss.xml#r1']
    expect([rss.title, rss._source.accounts.socialspec, rss._inbox.postDate, rss.content_html.split('<p class')[0]])
      .toEqual(['Hello', '@bob.example', '2026-11-19T09:00:00Z', '<p>Hi @alice.pups.test!</p>'])
    const page = by['https://carol.example/post']
    expect([page.title, page.authors[0].name, page.url]).toEqual(['Shout-out', 'Carol', 'https://carol.example/post'])
    expect(fetched.filter(u => u == 'https://loop.example/a')).toHaveLength(4)
    expect(fetched).not.toContain(`${MENTION}?x`)
  })

  it("arrive as replies to the owner's items, also in archives, and to items republished for the owner", async () => {
    const { r, files, web, fetched } = await testReceiver()
    files.set('/feed.json', jsonFeed([{ id: 'p-12', content_text: 'Mine' }], { _archive: { archive_url: `${ORIGIN}/feed/feed.000000.json` } }))
    files.set('/feed/feed.000000.json', jsonFeed([{ id: 'p-1', url: 'https://alice.pups.test/2025/old', content_text: 'Old' }]))
    const group = 'https://rm.example/groups/two/posts.json'
    web.set(group, feedDoc([{ id: 'g1', content_text: 'By Alice', _source: { accounts: { socialspec: '@alice.pups.test' } } },
      { id: 'g2', content_text: 'By someone else', _source: { accounts: { socialspec: '@x.example' } } }], { _submissions: { url: 'https://rm.example/m' } }))
    web.set('https://plain.example/feed.json', feedDoc([{ id: 'g1', content_text: 'No submissions', _source: { accounts: { socialspec: '@alice.pups.test' } } }]))
    const comments = 'https://rm.example/groups/two/comments/g1.json'
    web.set(comments, feedDoc([
      { id: 'r1', content_text: 'Re', _source: { inReplyTo: `${ORIGIN}/feed.json#p-12` } },
      { id: 'r2', content_text: 'Re old', _source: { inReplyTo: `${ORIGIN}/feed/feed.000000.json#p-1` } },
      { id: 'r3', authors: [{ name: 'Bob' }], content_text: 'Re group', _source: { inReplyTo: `${group}#g1`, accounts: { socialspec: '@bob.example' } } },
      { id: 'r4', content_text: 'Re other', _source: { inReplyTo: `${group}#g2` } },
      { id: 'r5', content_text: 'Re plain', _source: { inReplyTo: 'https://plain.example/feed.json#g1' } },
      { id: 'r6', content_text: 'Wrong target', _source: { inReplyTo: `${ORIGIN}/feed.json#p-99` } },
    ], { _submissions: { url: 'https://rm.example/m' } }))
    const page = 'https://erin.example/reply'
    web.set(page, { status: 200, headers: { 'content-type': 'text/html' }, body: `<html><body><div class="h-entry"><div class="e-content">
<p>In reply to <a class="u-in-reply-to" href="https://alice.pups.test/2025/old">this</a>.</p></div></div></body></html>` })
    for (const [id, target] of Object.entries({
      r1: `${ORIGIN}/feed.json#p-12`, r2: `${ORIGIN}/feed/feed.000000.json#p-1`, r3: `${group}#g1`, r4: `${group}#g2`,
      r5: 'https://plain.example/feed.json#g1', r6: `${ORIGIN}/feed.json#p-99`,
    })) await mentionEndpoint(webmention(MENTION, `${comments}#${id}`, target), r)
    await mentionEndpoint(webmention(MENTION, page, `${ORIGIN}/feed/feed.000000.json#p-1`), r)
    await processQueue(r)
    const items = inbox(files).items
    expect(items.map((i: any) => i._inbox.source).sort()).toEqual([page, `${comments}#r1`, `${comments}#r2`, `${comments}#r3`])
    expect(items.every((i: any) => i._inbox.type == 'reply')).toBe(true)
    expect(fetched).not.toContain(`${ORIGIN}/feed.json`)
    const r3 = items.find((i: any) => i._inbox.source == `${comments}#r3`)
    const r1 = items.find((i: any) => i._inbox.source == `${comments}#r1`)
    expect(r3._source.accounts.socialspec).toBe('@bob.example')
    expect([r3._actions.actions[0].text, r1._actions.actions[0].text]).toEqual([
      'Reply from @bob.example at rm.example/groups/two/comments/g1.json#r3', 'Reply from rm.example at rm.example/groups/two/comments/g1.json#r1'])
  })
})

describe('comments', () => {
  it("on the owner's posts are checked against the feed's rules and put into the inbox, not published", async () => {
    const { r, files, web } = await testReceiver()
    ownerFeed(files, { requireSocialSpec: true })
    web.set('https://bob.example/comments.json', feedDoc([bobComment(), bobComment({ id: 'c-18', content_text: 'x', content_html: null }),
      bobComment({ id: 'c-19', _source: { inReplyTo: `${ORIGIN}/feed.json#p-12`, accounts: { socialspec: '@mallory.example' } } }),
      bobComment({ id: 'c-20', _source: { accounts: { socialspec: '@bob.example' }, inReplyTo: `${ORIGIN}/feed.json#other` } }),
      bobComment({ id: 'c-21', title: 'A title' })]))
    const res = (await commentEndpoint(webmention(COMMENTS, 'https://bob.example/comments.json#c-17', `${ORIGIN}/feed.json#p-12`), r))!
    const body = await res.json()
    expect([res.status, body.status]).toEqual([201, 'waiting'])
    const statusUrl = res.headers.get('location')!
    expect(body.statusUrl).toBe(statusUrl)
    const status = async (url: string) => (await commentStatusEndpoint(new Request(url), url.split('/').pop()!, r))!.json()
    expect((await status(statusUrl)).status).toBe('waiting')
    const urls: Record<string, string> = {}
    for (const id of ['c-18', 'c-19', 'c-20', 'c-21'])
      urls[id] = (await commentEndpoint(webmention(COMMENTS, `https://bob.example/comments.json#${id}`, `${ORIGIN}/feed.json#p-12`), r))!.headers.get('location')!
    await processQueue(r)
    const s = await status(statusUrl)
    expect([s.status, s.pubUrl]).toEqual(['success', undefined])
    const codes: Record<string, string> = {}
    for (const [id, url] of Object.entries(urls)) codes[id] = (await status(url)).code
    expect(codes).toEqual({ 'c-18': 'too-short', 'c-19': 'socialspec-mismatch', 'c-20': 'in-reply-to-mismatch', 'c-21': 'title-not-allowed' })
    const items = inbox(files).items
    expect(items).toHaveLength(1)
    const item = items[0]
    expect([item._inbox.type, item._inbox.target, item.authors[0].name, item._source.accounts.socialspec])
      .toEqual(['submission', `${ORIGIN}/feed.json#p-12`, 'Bob', '@bob.example'])
    expect(item.content_html).toContain('<p>Agreed, but discovery is <b>hard</b>.</p>')
    expect(item._actions.actions[0]).toEqual({
      type: 'display', text: 'Comment from @bob.example at bob.example/comments.json#c-17', url: 'https://bob.example/comments.json#c-17',
    })
    expect(item.content_html).not.toMatch(/script|onclick/)
    expect(files.get('/feed.json')).not.toContain('Agreed')

    // Without allowEdit, the same source can't be sent again.
    const again = (await commentEndpoint(webmention(COMMENTS, 'https://bob.example/comments.json#c-17', `${ORIGIN}/feed.json#p-12`), r))!
    expect((await again.json()).error).toBe('edit-not-allowed')
  })

  it('are accepted only on posts of feeds that name the endpoint; edits and deletes as the feed allows', async () => {
    const { r, files, web, t } = await testReceiver()
    ownerFeed(files, { allowEdit: true, allowDelete: true }, [{ id: 'p-12', content_text: 'Open' },
      { id: 'p-13', content_text: 'Closed', _commenting: { allowComments: false } }])
    files.set('/feed/photos.json', jsonFeed([{ id: 'q', content_text: 'No comments here' }]))
    const src = 'https://bob.example/comments.json#c-17'
    for (const [target, code] of Object.entries({
      [`${ORIGIN}/feed.json`]: 'invalid_request', [`${ORIGIN}/feed.json#p-13`]: 'comments-disabled', [`${ORIGIN}/feed.json#p-99`]: 'target-gone',
      [`${ORIGIN}/feed/photos.json#q`]: 'invalid_request', 'https://other.example/feed.json#p-12': 'invalid_request',
    })) {
      const res = (await commentEndpoint(webmention(COMMENTS, src, target), r))!
      expect([res.status, (await res.json()).error]).toEqual([400, code])
    }
    web.set('https://bob.example/comments.json', feedDoc([bobComment()]))
    await commentEndpoint(webmention(COMMENTS, src, `${ORIGIN}/feed.json#p-12`), r)
    await processQueue(r)
    const first = inbox(files).items[0]
    web.set('https://bob.example/comments.json', feedDoc([bobComment({ content_html: '<p>Edited.</p>' })]))
    t.now += 60_000
    expect((await commentEndpoint(webmention(COMMENTS, src, `${ORIGIN}/feed.json#p-12`), r))!.status).toBe(201)
    await processQueue(r)
    const edited = inbox(files).items[0]
    expect([edited.id, edited.date_published]).toEqual([first.id, first.date_published])
    expect(edited.content_html).toContain('<p>Edited.</p>')
    web.set('https://bob.example/comments.json', feedDoc([]))
    const res = (await commentEndpoint(webmention(COMMENTS, src, `${ORIGIN}/feed.json#p-12`), r))!
    await processQueue(r)
    const statusUrl = res.headers.get('location')!
    expect((await (await commentStatusEndpoint(new Request(statusUrl), statusUrl.split('/').pop()!, r))!.json()).status).toBe('deleted')
    expect(inbox(files).items).toEqual([])
    expect((await commentStatusEndpoint(new Request(`${COMMENTS}/status/s-AAAAAAAAAAAAAAAA`), 's-AAAAAAAAAAAAAAAA', r))!.status).toBe(404)
  })

  it('on archived posts follow the feed file, whatever the archive says (RFC-7)', async () => {
    const { r, files, web } = await testReceiver()
    const archive = `${ORIGIN}/feed/feed.000000.json`
    ownerFeed(files, {}, [], { _archive: { archive_url: archive } })
    files.set('/feed/feed.000000.json', jsonFeed([{ id: 'p-1', content_text: 'Old' }], { _archive: { updates_url: `${ORIGIN}/feed.json` } }))
    web.set('https://bob.example/comments.json', feedDoc([bobComment({ _source: { accounts: { socialspec: '@bob.example' }, inReplyTo: `${archive}#p-1` } })]))
    expect((await commentEndpoint(webmention(COMMENTS, 'https://bob.example/comments.json#c-17', `${archive}#p-1`), r))!.status).toBe(201)
    await processQueue(r)
    expect(inbox(files).items.map((i: any) => i._inbox.target)).toEqual([`${archive}#p-1`])

    // Comments turned off in the feed file; the archive still has a copy from earlier.
    files.set('/feed.json', jsonFeed([], { _archive: { archive_url: archive } }))
    files.set('/feed/feed.000000.json', jsonFeed([{ id: 'p-2', content_text: 'Old' }],
      { _archive: { updates_url: `${ORIGIN}/feed.json` }, _submissions: { url: COMMENTS, republish: 'no', policies: { comments: {} } } }))
    const res = (await commentEndpoint(webmention(COMMENTS, 'https://bob.example/comments.json#c-18', `${archive}#p-2`), r))!
    expect([res.status, (await res.json()).error]).toEqual([400, 'invalid_request'])
  })
})

describe('the inbox', () => {
  it('holds 100 items, 10 per source host; old mentions make room, waiting comments never', async () => {
    const { r, files, t } = await testReceiver()
    const put = (id: string, host: string, type: 'mention' | 'submission' = 'mention') =>
      putInboxItem(r, inboxItem(r, id, type, `https://${host}/f.json#${id}`, `${ORIGIN}/`, {}, '<p>x</p>', undefined, undefined))
    for (let i = 0; i < 10; i++) await put(`m${i}`, 'spam.example')
    await expect(put('m10', 'spam.example')).rejects.toThrow('already has 10 items from spam.example')
    for (let h = 0; h < 9; h++)
      for (let i = 0; i < 10; i++) {
        t.now += 1000
        await put(`h${h}-${i}`, `host${h}.example`, h < 5 ? 'submission' : 'mention')
      }
    expect(inbox(files).items).toHaveLength(100)
    t.now += 1000
    await put('new', 'fresh.example')
    const ids: string[] = inbox(files).items.map((i: any) => i.id)
    expect([ids.length, ids.includes('new'), ids.filter(id => id[0] == 'm').length]).toEqual([100, true, 9])
    expect(inbox(files).items.filter((i: any) => i._inbox.type == 'submission')).toHaveLength(50)

    // A comment from a host with 10 items is refused at once.
    ownerFeed(files)
    const res = (await commentEndpoint(webmention(COMMENTS, 'https://host0.example/c.json#c', `${ORIGIN}/feed.json#p-12`), r))!
    expect([res.status, (await res.json()).error]).toEqual([400, 'moderation-unavailable'])
    expect(await inboxSummary(r)).toMatchObject({ mentions: 50, comments: 50, queued: 0 })
  })

  it('dismisses items with the RFC-9 action and the inbox key, and on the fallback page that asks first', async () => {
    const { r, files, web } = await testReceiver()
    web.set('https://bob.example/f.json', feedDoc([{ id: 'a', title: 'Hi', content_text: 'Hello @alice.pups.test' }, { id: 'b', content_text: 'Again @alice.pups.test' }]))
    await mentionEndpoint(webmention(MENTION, 'https://bob.example/f.json#a', `${ORIGIN}/`), r)
    await mentionEndpoint(webmention(MENTION, 'https://bob.example/f.json#b', `${ORIGIN}/`), r)
    await processQueue(r)
    const bySource = Object.fromEntries(inbox(files).items.map((i: any) => [i._inbox.source, i]))
    const [a, b] = [bySource['https://bob.example/f.json#a'], bySource['https://bob.example/f.json#b']]
    const action: string = inbox(files)._actions.templates.dismiss.action.replace('{id}', encodeURIComponent(a.id))
    const post = (url: string, body = '{}') => inboxActionEndpoint(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }), r)
    expect((await post(action.replace(/key=[\w-]+/, 'key=wrong'))).status).toBe(403)
    const res = await post(action)
    expect([res.status, (await res.json()).actions]).toEqual([200, [{ type: 'display', text: 'Dismissed' }]])
    expect(inbox(files).items.map((i: any) => i.id)).toEqual([b.id])
    expect((await post(action)).status).toBe(200)

    const link = /href="([^"]+)">Dismiss</.exec(b.content_html)![1]!.replace(/&amp;/g, '&')
    const page = await dismissPage(new Request(link), r, 'alice.pups.test')
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain('Dismiss this mention?')
    expect(html).toContain('Again @alice.pups.test')
    expect(inbox(files).items.map((i: any) => i.id)).toEqual([b.id])
    const hidden = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)![1]!
    const done = await dismissPage(new Request(`${ORIGIN}/pups/inbox/dismiss`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: hidden('id'), key: hidden('key') }),
    }), r, 'alice.pups.test')
    expect(await done.text()).toContain('The item was removed from your inbox.')
    expect(inbox(files).items).toEqual([])
    expect((await dismissPage(new Request(link.replace(/key=[\w-]+/, 'key=nope')), r, 'alice.pups.test')).status).toBe(403)
  })

  it("leaves another writer's inbox alone", async () => {
    const { r, files, web } = await testReceiver()
    files.set('/pups/private/inbox.json', jsonFeed([], { _inbox: { writer: 'https://other.example/client.json', categories: [] } }))
    web.set('https://bob.example/f.json', feedDoc([{ id: 'b', content_text: 'Hello again @alice.pups.test' }]))
    await mentionEndpoint(webmention(MENTION, 'https://bob.example/f.json#b', `${ORIGIN}/`), r)
    await processQueue(r)
    expect(inbox(files).items).toEqual([])
    expect(inbox(files)._inbox.writer).toBe('https://other.example/client.json')
    expect((await inboxSummary(r))!.error).toContain('managed by https://other.example/client.json')
  })
})
