import { commentFeeds, type FeedHost, FeedError, postItem, putKeptFeed, readItem } from 'pups-feeds'
import { expect } from 'vitest'
import { commentEndpoint, commentStatusEndpoint, inboxActionEndpoint, processQueue } from '../src'
import { COMMENTS, feedDoc, inbox, ORIGIN, testReceiver, webmention } from './helpers'

/** A receiver with the kept feeds of pups-feeds, for the tests of comment feeds and auto-moderation. */
export const WELL_KNOWN = [{ path: '/feed.json', rels: ['https://bigwide.net/ns/feed'] }, { path: '/feed/', rels: ['https://bigwide.net/ns/feed'] }]

export const submissions = (policy: Record<string, unknown> = {}, republish = 'full') =>
  ({ url: COMMENTS, republish, policies: { comments: { minLength: 2, maxLength: 200, ...policy } } })

/** A receiver whose server keeps the main feed, which takes comments at the built-in endpoint; `app` writes it like an app. */
export async function setupComments(policy: Record<string, unknown> = {}, republish = 'full') {
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

