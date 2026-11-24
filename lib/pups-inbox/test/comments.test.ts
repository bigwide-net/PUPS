import { commentFeeds, type FeedHost, FeedError, isFeedPath, keptFileOwner, postItem, putKeptFeed, readItem } from 'pups-feeds'
import { describe, expect, it } from 'vitest'
import { commentEndpoint, commentStatusEndpoint, dismissPage, inboxActionEndpoint, processQueue } from '../src'
import { COMMENTS, feedDoc, inbox, ORIGIN, testReceiver, webmention } from './helpers'

// The PHP tests of comment feeds (pups-php/tests/comment_feed_test.php): the receiver with the kept feeds of pups-feeds.
const SOURCE_SPEC = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md'
const WELL_KNOWN = [{ path: '/feed.json', rels: ['https://bigwide.net/ns/feed'] }, { path: '/feed/', rels: ['https://bigwide.net/ns/feed'] }]

const submissions = (policy: Record<string, unknown> = {}, republish = 'full') =>
  ({ url: COMMENTS, republish, policies: { comments: { minLength: 2, maxLength: 200, ...policy } } })

/** A receiver whose server keeps the main feed, which takes comments at the built-in endpoint; `app` writes it like an app. */
async function setup(policy: Record<string, unknown> = {}, republish = 'full') {
  const t = await testReceiver()
  const { r, files } = t
  const host: FeedHost = {
    me: `${ORIGIN}/`, publicUrl: path => ORIGIN + path, pathFromPublicUrl: url => url.startsWith(ORIGIN + '/') ? url.slice(ORIGIN.length) : undefined,
    read: async path => files.get(path), postUrlTemplate: async () => undefined, now: () => t.t.now, commentEndpoint: COMMENTS,
  }
  r.commentFeeds = commentFeeds({
    host, wellKnown: WELL_KNOWN, ownerPath: url => r.feeds.ownerPath(url), withLock: (_, fn) => fn(),
    write: async c => {
      for (const f of c.files) files.set(f.path, f.text)
      for (const p of c.deletes) files.delete(p)
    },
  })
  const answer = async (fn: () => Promise<{ status: number; body?: any }>) => {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof FeedError) return { status: e.status, body: { error: e.code } }
      throw e
    }
  }
  const app = {
    put: (doc: Record<string, unknown>) => answer(async () => {
      const c = await putKeptFeed(host, '/feed.json', JSON.stringify(doc), files.get('/feed.json'))
      c.files.forEach(f => files.set(f.path, f.text))
      c.deletes.forEach(p => files.delete(p))
      return { status: 200 }
    }),
    post: (item: unknown) => answer(async () => {
      const res = await postItem(host, '/feed.json', readItem('application/json', JSON.stringify(item)), files.get('/feed.json'))
      res.committed?.files.forEach(f => files.set(f.path, f.text))
      res.committed?.deletes.forEach(p => files.delete(p))
      return res
    }),
  }
  await app.put({ version: 'https://jsonfeed.org/version/1.1', title: 'Notes', items: [], _pups: { pupsControlled: true }, _submissions: submissions(policy, republish) })
  const stored = (path: string) => JSON.parse(files.get(path)!)
  const post = (id = 'p-12') => stored('/feed.json').items.find((i: any) => i.id == id)
  const status = async (url: string) => (await commentStatusEndpoint(new Request(url), url.split('/').pop()!, r))!.json() as Promise<any>
  /** Bob's comment on the post `p`, submitted and processed. Returns the status URL. */
  const comment = async (id = 'c-17', html = '<p>Agreed, but discovery is <b>hard</b>.</p>', p = 'p-12') => {
    t.web.set('https://bob.example/comments.json', feedDoc([{
      id, authors: [{ name: 'Bob' }], url: `https://bob.example/c/${id}`, content_html: html,
      _source: { accounts: { socialspec: '@bob.example' }, inReplyTo: `${ORIGIN}/feed.json#${p}` },
    }]))
    const res = (await commentEndpoint(webmention(COMMENTS, `https://bob.example/comments.json#${id}`, `${ORIGIN}/feed.json#${p}`), r))!
    expect(res.status, await res.clone().text()).toBe(201)
    await processQueue(r)
    return res.headers.get('location')!
  }
  /** A reply by `host` to `target`, submitted and processed. Returns the status URL. */
  const replyTo = async (host: string, target: string, id = 'r-1', html = '<p>Indeed, it is.</p>') => {
    const name = host.split('.')[0]!
    t.web.set(`https://${host}/comments.json`, feedDoc([{
      id, authors: [{ name: name[0]!.toUpperCase() + name.slice(1) }], url: `https://${host}/c/${id}`, content_html: html,
      _source: { accounts: { socialspec: `@${host}` }, inReplyTo: target },
    }]))
    const res = (await commentEndpoint(webmention(COMMENTS, `https://${host}/comments.json#${id}`, target), r))!
    expect(res.status, await res.clone().text()).toBe(201)
    await processQueue(r)
    return res.headers.get('location')!
  }
  const action = (id: string, what: 'approve' | 'dismiss') => inboxActionEndpoint(new Request(
    inbox(files)._actions.templates[what].action.replace('{id}', encodeURIComponent(id)), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), r)
  return { ...t, host, app, stored, post, status, comment, replyTo, action }
}

const ids = (doc: any) => doc.items.map((i: any) => i.id)

describe('comment feeds', () => {
  it('posts carry _source.comments while the feed takes comments here', async () => {
    const { app, post, stored } = await setup()
    await app.post({ id: 'p-12', content_text: 'Open', _source: { comments: { count: 99, feedUrl: 'https://x.example/' } } })
    await app.post({ id: 'p-13', content_text: 'Closed', _commenting: { allowComments: false } })
    expect(post()._source).toEqual({ about: SOURCE_SPEC, comments: { count: 0, total: 0 } })
    expect(post('p-13')._source).toBeUndefined()
    expect(post()._archive.index).toBe(0)

    // Off: the posts lose it, also in the archives; on again: they get it back.
    const { _submissions, ...off } = stored('/feed.json')
    await app.put(off)
    expect([post()._source, stored('/feed/feed.000000.json').items[1]._source]).toEqual([undefined, undefined])
    await app.put({ ...stored('/feed.json'), _submissions: submissions() })
    expect(stored('/feed/feed.000000.json').items[1]._source.comments).toEqual({ count: 0, total: 0 })

    // Another comment server keeps its own counts.
    await app.put({ ...stored('/feed.json'), _submissions: { ...submissions(), url: 'https://comments.example.org/mention' } })
    await app.post({ id: 'p-14', content_text: 'Elsewhere', _source: { comments: { count: 3, feedUrl: 'https://comments.example.org/14.json' } } })
    expect(post('p-14')._source.comments).toEqual({ count: 3, feedUrl: 'https://comments.example.org/14.json' })
    expect(post()._source).toBeUndefined()

    // "comments" is no feed name: /feed/comments/ holds the main feed's comment feeds.
    expect([isFeedPath('/feed/comments.json', WELL_KNOWN), keptFileOwner('/feed/comments/0.json', WELL_KNOWN), keptFileOwner('/feed/photos/comments/3.json', WELL_KNOWN)])
      .toEqual([false, '/feed.json', '/feed/photos.json'])
  })

  it('Publish Comment publishes the comment, counts it, and tells its author', async () => {
    const { r, files, t, web, app, stored, post, status, comment, action } = await setup({ allowEdit: true, allowDelete: true })
    await app.post({ id: 'p-12', title: 'Is RSS the better social network?', content_text: 'I think so.' })
    let statusUrl = await comment()
    expect((await status(statusUrl)).status).toBe('pending')
    const item = inbox(files).items[0]
    expect(item._actions.actions.map((a: any) => a.template ?? a.type)).toEqual(['display', 'approve', 'dismiss'])
    expect(item._actions.actions.map((a: any) => a.group)).toEqual(['origin', 'decide', 'decide'])
    expect(inbox(files)._actions.templates.approve).toMatchObject({ label: 'Publish Comment', style: 'major' })
    expect(item.content_html).toContain(`>Comment from @bob.example.</a></p><p class="without-extension-actions"><a href="${ORIGIN}/pups/inbox/approve?`)
    expect(item.content_html).toContain(`>Publish Comment</a></p><p class="without-extension-actions"><a href="${ORIGIN}/pups/inbox/dismiss?`)

    const res = await action(item.id, 'approve')
    const address = `${ORIGIN}/feed/comments/0.json#${item.id}`
    expect([res.status, (await res.json()).actions]).toEqual([200, [{ type: 'display', text: 'Comment published.', url: address }]])
    expect(inbox(files).items).toEqual([])
    expect(await status(statusUrl)).toEqual({ status: 'success', pubDate: item._inbox.postDate, pubUrl: address, guid: item.id })
    const feed = stored('/feed/comments/0.json')
    expect([feed.title, feed.feed_url, feed.home_page_url]).toEqual(['Comments on “Is RSS the better social network?”', `${ORIGIN}/feed/comments/0.json`, `${ORIGIN}/`])
    expect(feed.items).toEqual([{
      id: item.id, url: 'https://bob.example/c/c-17', content_html: '<p>Agreed, but discovery is <b>hard</b>.</p>',
      date_published: item._inbox.postDate, authors: [{ name: 'Bob' }],
      _source: { about: SOURCE_SPEC, inReplyTo: `${ORIGIN}/feed.json#p-12`, accounts: { socialspec: '@bob.example' }, comments: { count: 0, total: 0 } },
    }])
    expect(post()._source.comments).toEqual({ feedUrl: `${ORIGIN}/feed/comments/0.json`, count: 1, total: 1 })
    expect(post().date_modified).toBeUndefined()
    expect((await action(item.id, 'approve')).status).toBe(404)

    // The second, approved on the fallback page, comes first.
    t.now += 60_000
    await comment('c-18', '<p>Me too.</p>')
    const second = inbox(files).items[0]
    const link = /href="([^"]+)">Publish Comment</.exec(second.content_html)![1]!.replace(/&amp;/g, '&')
    const html = await (await dismissPage(new Request(link), r, 'alice.pups.test', 'approve')).text()
    expect(html).toContain('Publish this comment?')
    expect(inbox(files).items).toHaveLength(1)
    const hidden = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)![1]!
    const done = await dismissPage(new Request(`${ORIGIN}/pups/inbox/approve`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: hidden('id'), key: hidden('key') }),
    }), r, 'alice.pups.test', 'approve')
    expect(await done.text()).toContain('The comment is published.')
    expect(ids(stored('/feed/comments/0.json'))).toEqual([second.id, item.id])
    expect(post()._source.comments.count).toBe(2)

    // An edit waits for approval; the published version stays until then.
    t.now += 120_000
    await comment('c-17', '<p>Agreed, discovery is hard.</p>')
    const edit = inbox(files).items[0]
    expect([edit.id, edit._actions.actions[0].text]).toEqual([item.id, 'Edited comment from @bob.example.'])
    expect(stored('/feed/comments/0.json').items[1].content_html).toContain('but discovery')
    await action(edit.id, 'approve')
    const c = stored('/feed/comments/0.json').items[1]
    expect([c.content_html, c.date_published, !!c.date_modified]).toEqual(['<p>Agreed, discovery is hard.</p>', item._inbox.postDate, true])
    expect(post()._source.comments.count).toBe(2)

    // Sent again unchanged: nothing to approve.
    statusUrl = await comment('c-17', '<p>Agreed, discovery is hard.</p>')
    expect([inbox(files).items, (await status(statusUrl)).status]).toEqual([[], 'success'])

    // Deleted by its author: gone from the comment feed and the counts.
    web.set('https://bob.example/comments.json', feedDoc([]))
    await commentEndpoint(webmention(COMMENTS, 'https://bob.example/comments.json#c-17', `${ORIGIN}/feed.json#p-12`), r)
    await processQueue(r)
    expect(ids(stored('/feed/comments/0.json'))).toEqual([second.id])
    expect(post()._source.comments).toEqual({ feedUrl: `${ORIGIN}/feed/comments/0.json`, count: 1, total: 1 })

    // A deleted post takes its comments along.
    expect((await app.post({ id: 'p-12', _pups: { delete: true } })).status).toBe(200)
    expect(files.has('/feed/comments/0.json')).toBe(false)
  })

  it('replies to comments, as deep as the policy allows, counted up to the post', async () => {
    const { r, files, web, app, stored, post, status, comment, replyTo, action } = await setup({ allowDelete: true, maxDepth: 3, commentLimit: 3 })
    await app.post({ id: 'p-12', title: 'Is RSS the better social network?', content_text: 'I think so.' })
    await comment()
    const bob = inbox(files).items[0].id
    await action(bob, 'approve')
    const top = `${ORIGIN}/feed/comments/0.json`

    // Carol answers Bob: her reply goes into the comment feed of Bob's comment.
    const statusUrl = await replyTo('carol.example', `${top}#${bob}`)
    expect(inbox(files).items[0]._actions.actions[0].text).toBe('Reply from @carol.example.')
    const carol = inbox(files).items[0].id
    await action(carol, 'approve')
    const bobs = `${ORIGIN}/feed/comments/0/${bob}.json`
    expect((await status(statusUrl)).pubUrl).toBe(`${bobs}#${carol}`)
    const feed = stored(`/feed/comments/0/${bob}.json`)
    expect([feed.title, feed.feed_url, feed.home_page_url, feed._pups.inReplyTo])
      .toEqual(['Replies to a comment by Bob on “Is RSS the better social network?”', bobs, 'https://bob.example/c/c-17', `${top}#${bob}`])
    expect([feed.items[0]._source.inReplyTo, feed.items[0]._source.comments]).toEqual([`${top}#${bob}`, { count: 0, total: 0 }])
    expect(stored('/feed/comments/0.json').items[0]._source.comments).toEqual({ feedUrl: bobs, count: 1, total: 1 })
    expect(post()._source.comments).toEqual({ feedUrl: top, count: 1, total: 2 })

    // Dave answers Carol, at the deepest level: no replies to his.
    await replyTo('dave.example', `${bobs}#${carol}`)
    const dave = inbox(files).items[0].id
    await action(dave, 'approve')
    const carols = `${ORIGIN}/feed/comments/0/${carol}.json`
    expect(stored(`/feed/comments/0/${carol}.json`).items[0]._source.comments).toBeUndefined()
    expect(stored(`/feed/comments/0/${bob}.json`).items[0]._source.comments).toEqual({ feedUrl: carols, count: 1, total: 1 })
    expect(stored('/feed/comments/0.json').items[0]._source.comments).toEqual({ feedUrl: bobs, count: 1, total: 2 })
    expect(post()._source.comments).toEqual({ feedUrl: top, count: 1, total: 3 })
    for (const [target, error] of [[`${carols}#${dave}`, 'max-depth'], [`${top}#s-unpublished`, 'target-gone']]) {
      const res = (await commentEndpoint(webmention(COMMENTS, 'https://erin.example/comments.json#r-1', target!), r))!
      expect([res.status, (await res.json()).error]).toEqual([400, error])
    }

    // The comment limit counts all levels.
    await replyTo('erin.example', `${ORIGIN}/feed.json#p-12`)
    const erin = inbox(files).items[0].id
    expect((await (await action(erin, 'approve')).json()).message).toBe('The post has 3 comments, as many as the feed allows.')

    // Bob deletes his comment: the replies go with it.
    web.set('https://bob.example/comments.json', feedDoc([]))
    await commentEndpoint(webmention(COMMENTS, 'https://bob.example/comments.json#c-17', `${ORIGIN}/feed.json#p-12`), r)
    await processQueue(r)
    expect(['/feed/comments/0.json', `/feed/comments/0/${bob}.json`, `/feed/comments/0/${carol}.json`].filter(p => files.has(p))).toEqual([])
    expect(post()._source.comments).toEqual({ count: 0, total: 0 })
    expect((await action(erin, 'approve')).status).toBe(200)

    // A deleted post takes the whole thread along.
    await replyTo('carol.example', `${top}#${erin}`, 'r-2')
    await action(inbox(files).items[0].id, 'approve')
    expect(files.has(`/feed/comments/0/${erin}.json`)).toBe(true)
    await app.post({ id: 'p-12', _pups: { delete: true } })
    expect([...files.keys()].filter(p => p.startsWith('/feed/comments/'))).toEqual([])
  })

  it('Dismiss rejects; the comment limit; feeds that only deliver comments', async () => {
    const { files, app, status, comment, action } = await setup({ commentLimit: 1 })
    await app.post({ id: 'p-12', content_text: 'A post' })
    const statusUrl = await comment()
    await action(inbox(files).items[0].id, 'dismiss')
    expect(await status(statusUrl)).toMatchObject({ status: 'failure', code: 'moderation-rejected' })
    expect(files.has('/feed/comments/0.json')).toBe(false)

    await comment('c-18')
    await comment('c-19')
    const [b, a] = inbox(files).items
    expect((await action(a.id, 'approve')).status).toBe(200)
    const res = await action(b.id, 'approve')
    expect([res.status, (await res.json()).message]).toEqual([409, 'The post has 1 comments, as many as the feed allows.'])
    expect(inbox(files).items.map((i: any) => i.id)).toEqual([b.id])

    // republish: no: the owner only reads the comments.
    const u = await setup({}, 'no')
    await u.app.post({ id: 'p-12', content_text: 'A post' })
    const s = await u.comment()
    expect(inbox(u.files).items[0]._actions.actions.map((x: any) => x.template).filter(Boolean)).toEqual(['dismiss'])
    expect((await u.status(s)).status).toBe('success')
    expect((await u.action(inbox(u.files).items[0].id, 'approve')).status).toBe(409)
  })

  it('republish summary publishes an abstract, linked to the full text', async () => {
    const { files, app, stored, status, comment, action, web, r } = await setup({ maxLength: 1000 }, 'summary')
    await app.post({ id: 'p-12', content_text: 'A post' })
    await comment('c-17', `<p>${'Feeds are <b>great</b>, '.repeat(12)}really.</p>`)
    const item = inbox(files).items[0]
    expect(item._pups).toEqual({ republish: 'summary' })
    expect(item.content_html).toContain('<b>great</b>')
    await action(item.id, 'approve')
    const c = stored('/feed/comments/0.json').items[0]
    expect(c.content_html).toBeUndefined()
    expect([[...c.content_text].length, c.content_text.at(-1), c.url]).toEqual([150, '…', 'https://bob.example/c/c-17'])
    expect(c.content_text.startsWith('Feeds are great, Feeds are great,')).toBe(true)

    // Without a link to the full text, the comment is refused.
    web.set('https://bob.example/comments.json', feedDoc([{ id: 'c-18', content_text: 'No link', _source: { inReplyTo: `${ORIGIN}/feed.json#p-12` } }]))
    const res = (await commentEndpoint(webmention(COMMENTS, 'https://bob.example/comments.json#c-18', `${ORIGIN}/feed.json#p-12`), r))!
    await processQueue(r)
    expect((await status(res.headers.get('location')!)).code).toBe('link-missing')

    // Submitted for full republishing, approved after the feed changed to summary: an abstract.
    const u = await setup()
    await u.app.post({ id: 'p-12', content_text: 'A post' })
    await u.comment()
    await u.app.put({ ...u.stored('/feed.json'), _submissions: submissions({}, 'summary') })
    await u.action(inbox(u.files).items[0].id, 'approve')
    expect(u.stored('/feed/comments/0.json').items[0].content_text).toBe('Agreed, but discovery is hard.')

    // And when it no longer publishes comments at all, nothing is published.
    await u.comment('c-18')
    await u.app.put({ ...u.stored('/feed.json'), _submissions: submissions({}, 'no') })
    const no = await u.action(inbox(u.files).items[0].id, 'approve')
    expect([no.status, (await no.json()).message]).toEqual([409, "The feed doesn't publish comments anymore."])
  })
})
