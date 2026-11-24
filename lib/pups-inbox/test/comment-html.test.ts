import { describe, expect, it } from 'vitest'
import { commentContent, commentEndpoint, markdownHtml, processQueue } from '../src'
// Cases that pups-php runs too (tests/commenthtml_test.php): its Markdown renderer and checker must give the same results.
import cases from './comment-html-cases.json'
import { setupComments } from './comments-setup'
import { COMMENTS, feedDoc, inbox, ORIGIN, webmention } from './helpers'
import markdownCases from './markdown-cases.json'

describe('comment html (RFC-5)', () => {
  it('markdown-it renders the Markdown cases as recorded', () => {
    for (const [md, html] of markdownCases as [string, string][]) expect(markdownHtml(md), JSON.stringify(md)).toBe(html)
  })

  it('gives the recorded result for every case', () => {
    for (const c of cases) {
      const r = commentContent(c.source, c.policy as Parameters<typeof commentContent>[1])
      expect(r.ok ? { html: r.html, length: r.length } : { code: r.code, text: r.text }, c.name).toEqual(c.expect)
    }
  })

  it('takes Markdown first, keeps it, and checks what it renders to', () => {
    const policy = { minLength: 2, maxLength: 2000, allowStyle: true }
    expect(commentContent({ markdown: 'From *Markdown*', html: '<p>From HTML</p>' }, policy))
      .toEqual({ ok: true, html: '<p>From <em>Markdown</em></p>', markdown: 'From *Markdown*', length: 13 })
    expect(commentContent({ markdown: '# Headline' }, policy))
      .toEqual({ ok: false, code: 'forbidden-element', text: "The element <h1> is not allowed: this feed doesn't accept headlines." })
    expect(commentContent({ text: '**plain**' }, policy)).toEqual({ ok: true, html: '<p>**plain**</p>', length: 9 })
  })

  it('applies to comments: published with their Markdown, rejected with the reason', async () => {
    const { r, web, files, app, status, stored, action } = await setupComments({ allowLists: true, urlAutoLinking: true })
    await app.post({ id: 'p-12', content_text: 'A post' })
    const md = 'Two things:\n\n- **feeds**\n- see https://bob.example/why'
    web.set('https://bob.example/comments.json', feedDoc([{ id: 'c-1', authors: [{ name: 'Bob' }], content_html: '<p>ignored</p>',
      _source: { markdown: md, accounts: { socialspec: '@bob.example' }, inReplyTo: `${ORIGIN}/feed.json#p-12` } }]))
    const submit = async (id: string) => {
      const res = (await commentEndpoint(webmention(COMMENTS, `https://bob.example/comments.json#${id}`, `${ORIGIN}/feed.json#p-12`), r))!
      await processQueue(r)
      return status(res.headers.get('location')!)
    }
    expect((await submit('c-1')).status).toBe('pending')
    const item = inbox(files).items[0]
    const html = '<p>Two things:</p>\n<ul>\n<li><strong>feeds</strong></li>\n<li>see <a href="https://bob.example/why">https://bob.example/why</a></li>\n</ul>'
    expect(item.content_html.startsWith(`${html}<p class="without-extension-actions">`)).toBe(true)
    expect(item._source.markdown).toBe(md)
    await action(item.id, 'approve')
    const published = stored('/feed/comments/0.json').items[0]
    expect([published.content_html, published._source.markdown]).toEqual([html, md])

    web.set('https://bob.example/comments.json', feedDoc([{ id: 'c-2', authors: [{ name: 'Bob' }], content_html: '<p>Look: <img src="https://bob.example/cat.jpg" alt="cat"></p>',
      _source: { accounts: { socialspec: '@bob.example' }, inReplyTo: `${ORIGIN}/feed.json#p-12` } }]))
    const s = await submit('c-2')
    expect([s.status, s.code, s.text]).toEqual(['failure', 'forbidden-element', "The element <img> is not allowed: this feed doesn't accept images."])
    expect(inbox(files).items).toEqual([])
  })
})
