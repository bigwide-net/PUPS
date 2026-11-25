import { describe, expect, it } from 'vitest'
import { commentEndpoint, MENTION_REL, parseFeed, processQueue, RETRY_MS } from '../src'
import { setupComments } from './comments-setup'
import { COMMENTS, type WebDoc, feedDoc, inbox, ORIGIN, webmention } from './helpers'

/** host-meta.json with a mention endpoint, and the endpoint answering `status`. */
const mentionable = (web: Map<string, WebDoc>, host: string, status = 202) => {
  web.set(`https://${host}/.well-known/host-meta.json`, { status: 200, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ links: [{ rel: 'other', href: 'https://x.example/' }, { rel: MENTION_REL, href: `https://${host}/mention` }] }) })
  web.set(`https://${host}/mention`, { status, body: '' })
}

const sent = (posted: { url: string; body: string }[]) => posted.map(p => [p.url, Object.fromEntries(new URLSearchParams(p.body))])

/** A post with Bob's approved comment on it. */
async function withBob(policy: Record<string, unknown> = {}, bobItem: Record<string, unknown> = {}) {
  const s = await setupComments(policy)
  await s.app.post({ id: 'p-12', content_text: 'A post' })
  s.web.set('https://bob.example/comments.json', feedDoc([{ id: 'c-17', authors: [{ name: 'Bob' }], content_html: '<p>Agreed.</p>',
    _source: { accounts: { socialspec: '@bob.example' }, inReplyTo: `${ORIGIN}/feed.json#p-12` }, ...bobItem }]))
  const bobSubmit = async () => {
    const res = (await commentEndpoint(webmention(COMMENTS, 'https://bob.example/comments.json#c-17', `${ORIGIN}/feed.json#p-12`), s.r))!
    expect(res.status, await res.clone().text()).toBe(201)
    await processQueue(s.r)
    return s.status(res.headers.get('location')!)
  }
  await bobSubmit()
  const bob = inbox(s.files).items[0].id
  await s.action(bob, 'approve')
  await processQueue(s.r)
  const bobs = `${ORIGIN}/feed/comments/0.json#${bob}`
  return { ...s, bob, bobs, bobSubmit }
}

describe('sending mentions (RFC-11)', () => {
  it('a published reply notifies the author of the comment it answers, and the handles it names', async () => {
    const { r, web, posted, jobs, replyTo, action, files, bob, bobs, status } = await withBob({ allowCode: true })
    expect(posted).toEqual([])
    for (const host of ['bob.example', 'dave.example']) mentionable(web, host)
    const statusUrl = await replyTo('carol.example', bobs, 'r-1',
      '<p>Right, ask @dave.example, not @carol.example or @alice.pups.test. <code>@erin.example</code></p>')
    // Nothing is sent before the owner approves.
    expect(posted).toEqual([])
    await action(inbox(files).items[0].id, 'approve')
    await processQueue(r)
    const carol = (await status(statusUrl)).pubUrl
    expect(carol.startsWith(`${ORIGIN}/feed/comments/0/${bob}.json#s-`)).toBe(true)
    expect(sent(posted)).toEqual([
      ['https://bob.example/mention', { source: carol, target: bobs }],
      ['https://dave.example/mention', { source: carol, target: 'https://dave.example/' }],
    ])
    expect(jobs.size).toBe(0)
  })

  it('notifyReplies: false is republished, and stops reply mentions but not mentions by name', async () => {
    const { r, web, posted, stored, replyTo, action, files, bobs } = await withBob({}, { _commenting: { notifyReplies: false } })
    expect(stored('/feed/comments/0.json').items[0]._commenting).toEqual({ about: 'https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md', notifyReplies: false })
    mentionable(web, 'bob.example')
    await replyTo('carol.example', bobs, 'r-1', '<p>I agree.</p>')
    await action(inbox(files).items[0].id, 'approve')
    await processQueue(r)
    expect(posted).toEqual([])
    await replyTo('carol.example', bobs, 'r-2', '<p>Did you see this, @bob.example?</p>')
    await action(inbox(files).items[0].id, 'approve')
    await processQueue(r)
    expect(sent(posted).map(([, b]) => (b as any).target)).toEqual(['https://bob.example/'])
  })

  it('notifyReplies can be changed without allowEdit and without approval; other changes cannot', async () => {
    const { web, stored, files, bobSubmit, jobs } = await withBob()
    const bobFeed = (extra: Record<string, unknown>) => web.set('https://bob.example/comments.json', feedDoc([{ id: 'c-17', authors: [{ name: 'Bob' }],
      content_html: '<p>Agreed.</p>', _source: { accounts: { socialspec: '@bob.example' }, inReplyTo: `${ORIGIN}/feed.json#p-12` }, ...extra }]))
    bobFeed({ _commenting: { notifyReplies: false } })
    const s = await bobSubmit()
    expect([s.status, inbox(files).items, stored('/feed/comments/0.json').items[0]._commenting?.notifyReplies, jobs.size]).toEqual(['success', [], false, 0])
    bobFeed({ content_html: '<p>Agreed, mostly.</p>' })
    expect(await bobSubmit()).toMatchObject({ status: 'failure', code: 'edit-not-allowed' })
    expect(stored('/feed/comments/0.json').items[0]._commenting?.notifyReplies).toBe(false)
  })

  it('edits and deletes send the mentions again, also for the replies removed with a comment', async () => {
    const { r, web, posted, replyTo, action, files, bob, bobs } = await withBob({ allowEdit: true, allowDelete: true })
    for (const host of ['bob.example', 'dave.example']) mentionable(web, host)
    await replyTo('carol.example', bobs, 'r-1', '<p>Ask @dave.example.</p>')
    await action(inbox(files).items[0].id, 'approve')
    await processQueue(r)
    const carol = (sent(posted)[0]![1] as any).source
    posted.length = 0
    // Carol drops the handle: Dave is told again, and finds no mention anymore.
    await replyTo('carol.example', bobs, 'r-1', '<p>Ask someone else.</p>')
    await action(inbox(files).items[0].id, 'approve')
    await processQueue(r)
    expect(sent(posted)).toEqual([
      ['https://bob.example/mention', { source: carol, target: bobs }],
      ['https://dave.example/mention', { source: carol, target: 'https://dave.example/' }],
    ])
    posted.length = 0
    // Bob deletes his comment, and Carol's reply goes with it: Bob is told again about her reply.
    web.set('https://bob.example/comments.json', feedDoc([]))
    await commentEndpoint(webmention(COMMENTS, 'https://bob.example/comments.json#c-17', `${ORIGIN}/feed.json#p-12`), r)
    await processQueue(r)
    expect(files.has(`/feed/comments/0/${bob}.json`)).toBe(false)
    expect(sent(posted)).toEqual([['https://bob.example/mention', { source: carol, target: bobs }]])
  })

  it('retries after 5xx, not after 4xx; remembers domains without an endpoint', async () => {
    const { r, web, posted, fetched, jobs, replyTo, action, files, bobs, t } = await withBob()
    mentionable(web, 'bob.example', 503)
    await replyTo('carol.example', bobs, 'r-1', '<p>Hello @dave.example and @erin.example.</p>')
    mentionable(web, 'erin.example', 400)
    await action(inbox(files).items[0].id, 'approve')
    await processQueue(r)
    expect(sent(posted).map(([u]) => u)).toEqual(['https://bob.example/mention', 'https://erin.example/mention'])
    expect([...jobs.values()].map(j => [j.host, j.tries])).toEqual([['bob.example', 1]])
    // Not due yet: nothing is sent.
    await processQueue(r)
    expect(posted.length).toBe(2)
    t.now += RETRY_MS[0]!
    web.set('https://bob.example/mention', { status: 202, body: '' })
    await processQueue(r)
    expect([posted.length, jobs.size]).toEqual([3, 0])
    // dave.example has no host-meta.json: asked once, and remembered.
    expect(fetched.filter(u => u == 'https://dave.example/.well-known/host-meta.json').length).toBe(1)
    await replyTo('carol.example', bobs, 'r-2', '<p>Hello again @dave.example.</p>')
    await action(inbox(files).items[0].id, 'approve')
    await processQueue(r)
    expect(fetched.filter(u => u == 'https://dave.example/.well-known/host-meta.json').length).toBe(1)
  })

  it("the owner's own reply notifies the commenter at once", async () => {
    const { r, web, posted, files, bob, bobs } = await withBob()
    mentionable(web, 'bob.example')
    files.set('/feed/mine.json', JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Mine', _pups: { pupsControlled: true },
      items: [{ id: 'a-1', content_html: '<p>Thanks, Bob!</p>', authors: [{ name: 'Alice' }], _source: { inReplyTo: bobs } }] }))
    await commentEndpoint(webmention(COMMENTS, `${ORIGIN}/feed/mine.json#a-1`, bobs), r)
    await processQueue(r)
    expect(sent(posted)).toEqual([['https://bob.example/mention', { source: expect.stringContaining(`${ORIGIN}/feed/comments/0/${bob}.json#s-`), target: bobs }]])
  })
})

describe('notifyReplies in author feeds', () => {
  it('is read from JSON Feed and RSS', () => {
    expect(parseFeed('{"version":"https://jsonfeed.org/version/1.1","items":[{"id":"a","_commenting":{"notifyReplies":false}},{"id":"b"}]}')!.items.map(i => i.notifyReplies))
      .toEqual([false, undefined])
    const rss = `<rss version="2.0" xmlns:rm="https://rssmention.bigwide.net/"><channel><title>T</title>
      <item><guid>a</guid><rm:commenting><rm:notifyReplies>false</rm:notifyReplies></rm:commenting></item><item><guid>b</guid></item></channel></rss>`
    expect(parseFeed(rss)!.items.map(i => [i.notifyReplies, i.allowComments])).toEqual([[false, true], [undefined, true]])
  })
})
