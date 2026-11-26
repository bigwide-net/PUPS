import { describe, expect, it } from 'vitest'
import { dismissPage, moderationFromForm, moderationSettings, type ModerationStore, moderationView, parseModeration, saveModeration } from '../src'
import { inbox, ORIGIN } from './helpers'
import { setupComments } from './comments-setup'

// The PHP tests of auto-moderation (pups-php/tests/moderation_test.php): the settings, and the receiver with a model.

/** Settings and token counts in memory; the model answers with `answer` (a rating, a string as the message, or an error). */
function memoryStore(answer: unknown, opts: { status?: number; raw?: boolean; tokens?: number } = {}) {
  let json: string | undefined
  const used = new Map<string, number>()
  const calls: { url: string; headers: Record<string, string>; body: any }[] = []
  const store: ModerationStore & { calls: typeof calls; answer: unknown; used: typeof used } = {
    calls, answer, used,
    load: async () => json,
    save: async j => void (json = j),
    tokens: async day => used.get(day) ?? 0,
    addTokens: async (day, n) => void used.set(day, (used.get(day) ?? 0) + n),
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
      const a = store.answer
      if (a instanceof Error) throw a
      return new Response(opts.raw ? String(a) : JSON.stringify({
        choices: [{ message: { role: 'assistant', content: typeof a == 'string' ? a : JSON.stringify(a) } }],
        ...opts.tokens != undefined && { usage: { total_tokens: opts.tokens } },
      }), { status: opts.status ?? 200 })
    }) as typeof fetch,
  }
  return store
}

const formOf = (fields: Record<string, string>) => new URLSearchParams(fields)

describe('auto-moderation', () => {
  it('settings: off by default, checked, the key kept and forgotten', async () => {
    const m = memoryStore({ safe: 1 })
    expect(moderationSettings(await m.load())).toEqual({
      enabled: false, endpoint: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-nano', threshold: 90, criteria: '', dailyTokens: 500, notify: true,
    })
    const off = moderationSettings(undefined)
    expect(moderationFromForm(formOf({ moderation_enabled: '1' }), off)).toEqual({ error: 'Auto-moderation needs an API key.' })
    expect(moderationFromForm(formOf({ moderation_key: 'k', moderation_threshold: '30' }), off)).toMatchObject({ error: expect.stringContaining('from 50 to 100') })
    expect(moderationFromForm(formOf({ moderation_key: 'k', moderation_daily_tokens: '10001' }), off)).toMatchObject({ error: expect.stringContaining('from 1 to 10000') })
    expect(moderationFromForm(formOf({ moderation_key: 'k', moderation_endpoint: 'ftp://x.example' }), off)).toMatchObject({ error: expect.stringContaining('https URL') })
    expect(moderationFromForm(formOf({ moderation_key: 'k', moderation_criteria: 'x'.repeat(2001) }), off)).toMatchObject({ error: expect.stringContaining('2000 characters') })

    expect(await saveModeration(m, formOf({
      moderation_enabled: '1', moderation_notify: '1', moderation_key: 'sk-or-v1-secret1234', moderation_threshold: '85', moderation_criteria: 'No cats.',
    }))).toEqual({ message: 'Auto-moderation is on: comments rated at least 85 % likely acceptable are published at once, and shown in your inbox.' })
    const view = await moderationView(m, Date.now())
    expect(view).toMatchObject({ enabled: true, notify: true, keyEnding: '1234', threshold: 85, criteria: 'No cats.', dailyTokens: 500, usedToday: 0 })
    expect(JSON.stringify(view)).not.toContain('secret')
    // An unchecked box turns the notifications off.
    expect(await saveModeration(m, formOf({ moderation_enabled: '1' })))
      .toEqual({ message: 'Auto-moderation is on: comments rated at least 90 % likely acceptable are published at once.' })
    expect(moderationSettings(await m.load())).toMatchObject({ apiKey: 'sk-or-v1-secret1234', notify: false })
    expect((await moderationView(m, Date.now(), formOf({ moderation_notify: '1' }))).notify).toBe(true)
    expect(await saveModeration(m, formOf({ moderation_forget_key: '1' }))).toEqual({ message: 'Auto-moderation is off.' })
    expect(moderationSettings(await m.load()).apiKey).toBeUndefined()
  })

  it('parses ratings, also wrapped in text or as a percentage', () => {
    expect(parseModeration('{"safe": 0.4, "categories": ["spam"], "reason": "Promotes a shop."}')).toEqual({ safe: 0.4, categories: ['spam'], reason: 'Promotes a shop.' })
    expect(parseModeration('Here:\n```json\n{"safe": 95}\n```')).toEqual({ safe: 0.95, categories: [], reason: '' })
    for (const bad of ['not json', '{"verdict": "fine"}', '{"safe": 7500}', '{"safe": "high"}']) expect(parseModeration(bad)).toBeUndefined()
  })

  it('publishes comments rated likely acceptable at once; others wait with the rating', async () => {
    const t = await setupComments()
    const { r, files, app, stored, status, comment, action } = t
    await app.post({ id: 'p-12', title: 'Is RSS the better social network?', content_text: 'I think so.' })
    const m = r.moderation = memoryStore({ safe: 0.97, categories: [], reason: 'A genuine remark.' })
    await saveModeration(m, formOf({ moderation_enabled: '1', moderation_key: 'sk-test', moderation_criteria: 'Only comments in English.' }))

    const s = await status(await comment())
    expect([files.has('/pups/private/inbox.json') ? inbox(files).items : [], s.status, s.pubUrl]).toEqual([[], 'success', `${ORIGIN}/feed/comments/0.json#${s.guid}`])
    expect(stored('/feed/comments/0.json').items.map((i: any) => i.id)).toEqual([s.guid])
    expect([m.calls.length, m.calls[0]!.url, m.calls[0]!.headers.authorization]).toEqual([1, 'https://openrouter.ai/api/v1/chat/completions', 'Bearer sk-test'])
    const req = m.calls[0]!.body
    expect([req.model, req.reasoning, req.max_tokens, req.temperature, req.messages.map((x: any) => x.role)])
      .toEqual(['openai/gpt-5-nano', { effort: 'minimal' }, 1000, undefined, ['system', 'user']])
    expect(req.messages[0].content).toContain('<owner-criteria>\nOnly comments in English.\n</owner-criteria>')
    const data = JSON.parse(req.messages[1].content)
    expect([data.post.title, data.comment.text, data.comment.account, data.comment.author])
      .toEqual(['Is RSS the better social network?', 'Agreed, but discovery is hard.', '@bob.example', 'Bob'])

    // Rated lower than the threshold: into the inbox, with the rating.
    m.answer = { safe: 0.4, categories: ['spam'], reason: 'Promotes a shop.' }
    expect((await status(await comment('c-18', '<p>Buy cheap <a href="https://shop.example/">shoes</a>!</p>'))).status).toBe('pending')
    expect(m.calls.at(-1)!.body.messages[1].content).toContain('https://shop.example/')
    const item = inbox(files).items[0]
    expect(item._actions.actions[1]).toEqual({ type: 'display', text: 'Auto-moderation: 40 % likely acceptable. Promotes a shop.', group: 'origin' })
    expect(item._pups.moderation).toEqual({ safe: 0.4, categories: ['spam'], reason: 'Promotes a shop.' })
    await action(item.id, 'approve')
    expect(JSON.stringify(stored('/feed/comments/0.json').items[0])).not.toContain('Auto-moderation')

    // The threshold is the owner's.
    await saveModeration(m, formOf({ moderation_enabled: '1', moderation_threshold: '80' }))
    m.answer = { safe: 0.85 }
    expect((await status(await comment('c-19', '<p>Nice one.</p>'))).status).toBe('success')
  })

  it('shows the comments it publishes in the inbox, where the owner can reject or dismiss them', async () => {
    const t = await setupComments()
    const { r, files, app, stored, status, comment, replyTo, action } = t
    await app.post({ id: 'p-12', title: 'Is RSS the better social network?', content_text: 'I think so.' })
    const m = r.moderation = memoryStore({ safe: 0.97, reason: 'A genuine remark.' })
    await saveModeration(m, formOf({ moderation_enabled: '1', moderation_notify: '1', moderation_key: 'sk-test' }))
    const comments = () => stored('/feed/comments/0.json').items.map((i: any) => i.id)

    // Published, and in the inbox as a reply: nothing to decide, but it can be rejected.
    const s = await status(await comment())
    expect([s.status, comments()]).toEqual(['success', [s.guid]])
    const feed = inbox(files)
    expect(feed._inbox.categories).toEqual(['mentions', 'moderation'])
    expect(feed._actions.templates.reject).toEqual({
      type: 'button', label: 'Reject Comment', confirm: 'Remove this comment from your site? Its author is told that you rejected it.',
      action: expect.stringMatching(/\/pups\/inbox\/action\?do=reject&id=\{id\}&key=/),
    })
    const [item] = feed.items
    expect([item.id, item._inbox.type, item._inbox.target, item._pups]).toEqual([s.guid, 'reply', `${ORIGIN}/feed.json#p-12`, {
      published: s.pubUrl, moderation: { safe: 0.97, categories: [], reason: 'A genuine remark.' },
    }])
    expect(item._actions.actions).toEqual([
      { type: 'display', text: 'Comment from @bob.example.', url: 'https://bob.example/comments.json#c-17', group: 'origin' },
      { type: 'display', text: 'Published by auto-moderation: 97 % likely acceptable. A genuine remark.', url: s.pubUrl, group: 'origin' },
      { template: 'reject', group: 'decide' }, { template: 'dismiss', group: 'decide' },
    ])
    expect(item.content_html).toMatch(/^<p>Agreed, but discovery is <strong>hard<\/strong>.<\/p><p class="without-extension-actions">/)
    expect(item.content_html).not.toContain('Publish Comment')
    expect(item.content_html).toContain('>Reject Comment</a>')

    // Dismiss only removes it from the inbox.
    await action(item.id, 'dismiss')
    expect([inbox(files).items, comments(), (await status(`${ORIGIN}/pups/comments/status/${s.guid}`)).status]).toEqual([[], [s.guid], 'success'])
    expect((await action(item.id, 'reject')).status).toBe(404)

    // Reject removes it from the site, with the replies to it, and tells the author.
    const s2 = await status(await comment('c-18', '<p>Me too.</p>'))
    await replyTo('carol.example', s2.pubUrl)
    expect(inbox(files).items.map((i: any) => i._inbox.type)).toEqual(['reply', 'reply'])
    const res = await action(s2.guid, 'reject')
    expect([res.status, await res.json()]).toEqual([200, { message: 'Rejected', actions: [{ type: 'display', text: 'Comment rejected and removed.' }] }])
    expect(comments()).toEqual([s.guid])
    expect(files.has('/feed/comments/0/1.json') && stored('/feed/comments/0/1.json').items).toBeFalsy()
    expect(await status(`${ORIGIN}/pups/comments/status/${s2.guid}`)).toMatchObject({ status: 'failure', code: 'moderation-rejected' })
    // Carol's reply went with it, from the inbox too.
    expect(inbox(files).items).toEqual([])

    // On the fallback page, after a confirmation.
    const s3 = await status(await comment('c-19', '<p>Nice one.</p>'))
    const link = /href="([^"]+)">Reject Comment</.exec(inbox(files).items.find((i: any) => i.id == s3.guid).content_html)![1]!.replace(/&amp;/g, '&')
    const html = await (await dismissPage(new Request(link), r, 'alice.pups.test', 'reject')).text()
    expect(html).toContain('Reject this comment?')
    expect(comments()).toContain(s3.guid)
    const hidden = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)![1]!
    const done = await dismissPage(new Request(`${ORIGIN}/pups/inbox/reject`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: hidden('id'), key: hidden('key') }),
    }), r, 'alice.pups.test', 'reject')
    expect(await done.text()).toContain('The comment was removed from your site.')
    expect(comments()).toEqual([s.guid])

    // Comments waiting for approval can't be rejected, published ones can't be approved.
    m.answer = { safe: 0.4 }
    const s4 = await status(await comment('c-20', '<p>Hmm.</p>'))
    expect([(await action(s4.guid, 'reject')).status, s4.status]).toEqual([409, 'pending'])
    m.answer = { safe: 0.99 }
    const s5 = await status(await comment('c-21', '<p>Great.</p>'))
    expect((await action(s5.guid, 'approve')).status).toBe(409)

    // Turned off: published, not in the inbox.
    await saveModeration(m, formOf({ moderation_enabled: '1' }))
    const s6 = await status(await comment('c-22', '<p>Fine.</p>'))
    expect([s6.status, inbox(files).items.map((i: any) => i.id).toSorted()]).toEqual(['success', [s4.guid, s5.guid].toSorted()])
  })

  it('failures, the daily token limit, and feeds that publish nothing leave the comment for the owner', async () => {
    const t = await setupComments()
    const { r, files, app, status, comment } = t
    await app.post({ id: 'p-12', content_text: 'A post' })
    let n = 20
    for (const [answer, opts] of [
      [JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401, raw: true }],
      ['not json', { raw: true }],
      [{ verdict: 'fine' }, {}],
      [new Error('Connection failed'), {}],
    ] as [unknown, object][]) {
      const m = r.moderation = memoryStore(answer, opts)
      await saveModeration(m, formOf({ moderation_enabled: '1', moderation_key: 'sk-test' }))
      expect((await status(await comment(`c-${n++}`))).status).toBe('pending')
    }
    expect(inbox(files).items).toHaveLength(4)
    expect(inbox(files).items[0]._pups.moderation).toBeUndefined()

    // 1500 tokens per call, 2000 per day: the third comment waits, the next day it is rated again.
    const m = r.moderation = memoryStore({ safe: 0.99 }, { tokens: 1500 })
    await saveModeration(m, formOf({ moderation_enabled: '1', moderation_key: 'sk-test', moderation_daily_tokens: '2' }))
    expect((await status(await comment('c-30'))).status).toBe('success')
    expect((await status(await comment('c-31'))).status).toBe('success')
    expect([(await status(await comment('c-32'))).status, m.calls.length]).toEqual(['pending', 2])
    expect((await moderationView(m, t.t.now)).usedToday).toBe(3000)
    t.t.now += 24 * 3600_000
    expect([(await status(await comment('c-33'))).status, m.calls.length]).toEqual(['success', 3])

    // Off: the model isn't asked; neither in a feed that doesn't publish comments.
    await saveModeration(m, formOf({}))
    expect([(await status(await comment('c-34'))).status, m.calls.length]).toEqual(['pending', 3])
    const u = await setupComments({}, 'no')
    await u.app.post({ id: 'p-12', content_text: 'A post' })
    const mu = u.r.moderation = memoryStore({ safe: 1 })
    await saveModeration(mu, formOf({ moderation_enabled: '1', moderation_key: 'sk-test' }))
    await u.comment()
    expect([mu.calls.length, inbox(u.files).items.length]).toEqual([0, 1])
  })
})
