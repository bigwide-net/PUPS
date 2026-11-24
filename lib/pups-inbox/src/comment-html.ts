import { decodeHTMLStrict as decodeHTML } from 'entities'
import MarkdownIt from 'markdown-it'
import { wellFormed } from './content'

/**
 * Comment HTML and Comment Markdown (RFC-5): the content of a comment, checked against the features of the feed's
 * policy and normalized. Markdown (preferred) is rendered with markdown-it (CommonMark with tables and strikethrough,
 * raw HTML as text), plain text becomes paragraphs; the HTML is then checked with a strict tokenizer. A comment that
 * breaks a rule is rejected with the first problem, never repaired; only unknown attributes are removed. pups-php's
 * commenthtml.php is a port.
 */

/** Escapes text and attribute values as RFC-5 normalizes them: `&`, `<`, `>` and `"`. */
const h = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** The features of RFC-5, as boolean rules of an RFC-4 policy. */
export const FEATURES = ['allowStyle', 'allowLinks', 'allowCode', 'allowQuote', 'allowImages', 'allowTables', 'allowLists', 'allowHeadlines'] as const
export type Feature = typeof FEATURES[number]
export type Features = Partial<Record<Feature | 'urlAutoLinking', boolean>>

export interface CommentSource {
  markdown?: string
  html?: string
  text?: string
}

export type CommentContent =
  | { ok: true; html: string; markdown?: string; length: number }
  | { ok: false; code: string; text: string }

export const MAX_URL_LENGTH = 512
export const MAX_LINK_TEXT_LENGTH = 120

/** Element → the feature that allows it. */
const ELEMENTS: Record<string, Feature | 'always'> = {
  p: 'always', br: 'always',
  strong: 'allowStyle', em: 'allowStyle', s: 'allowStyle',
  a: 'allowLinks',
  code: 'allowCode', pre: 'allowCode',
  q: 'allowQuote', blockquote: 'allowQuote',
  img: 'allowImages',
  table: 'allowTables', thead: 'allowTables', tbody: 'allowTables', tr: 'allowTables', th: 'allowTables', td: 'allowTables',
  ul: 'allowLists', ol: 'allowLists', li: 'allowLists',
  h1: 'allowHeadlines', h2: 'allowHeadlines', h3: 'allowHeadlines', h4: 'allowHeadlines', h5: 'allowHeadlines', h6: 'allowHeadlines',
}
/** What a feature is called in messages. */
const FEATURE_NAMES: Record<Feature, string> = {
  allowStyle: 'bold, italic and strikethrough text', allowLinks: 'links', allowCode: 'code', allowQuote: 'quotes', allowImages: 'images',
  allowTables: 'tables', allowLists: 'lists', allowHeadlines: 'headlines',
}
const VOID = new Set(['br', 'img'])
const KEPT_ATTRIBUTES: Record<string, string[]> = { a: ['href'], img: ['src', 'alt'] }
const REQUIRED_ATTRIBUTE: Record<string, string> = { a: 'href', img: 'src' }
const PARENTS: Record<string, string[]> = { thead: ['table'], tbody: ['table'], tr: ['table', 'thead', 'tbody'], th: ['tr'], td: ['tr'], li: ['ul', 'ol'] }
const CHILDREN: Record<string, string[]> = { table: ['thead', 'tbody', 'tr'], thead: ['tr'], tbody: ['tr'], tr: ['th', 'td'], ul: ['li'], ol: ['li'] }
/** Elements that don't separate words in the visible text. */
const INLINE = new Set(['strong', 'em', 's', 'a', 'code', 'q', 'img'])

/** Control and invisible characters, which are removed from the text; tabs and line breaks stay. */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜​‎‏‪-‮⁠-⁩﻿￰-￿]/g
const unsafeCode = (n: number) => n > 0x10ffff || n >= 0xd800 && n <= 0xdfff || !String.fromCodePoint(n).replace(UNSAFE, '')
/** Removes unsafe characters, also as numeric character references. */
const clean = (s: string) => wellFormed(s).replace(UNSAFE, '').replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (m, n: string) => {
  const code = n[0] == 'x' || n[0] == 'X' ? parseInt(n.slice(1), 16) : parseInt(n, 10)
  return unsafeCode(code) ? '' : m
})

const markdownIt = new MarkdownIt({ html: false, linkify: false, typographer: false })
export const markdownHtml = (md: string) => markdownIt.render(md)

/** Plain text as Comment HTML: blank lines separate paragraphs, line breaks become `<br>`. */
export const textCommentHtml = (text: string) =>
  text.replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n\s*/).map(p => `<p>${h(p.trim()).replace(/\n/g, '<br>')}</p>`).join('')

/** An absolute http(s) URL without whitespace, of at most 512 characters (RFC-5 "URLs"). */
export const isCommentUrl = (url: string) => url.length <= MAX_URL_LENGTH && /^https?:\/\/[^/?#\s]+(?:[/?#]\S*)?$/i.test(url)

type Token = { type: 'open'; name: string; attrs: Record<string, string> } | { type: 'close'; name: string } | { type: 'text'; raw: string }
class Refused {
  constructor(readonly code: string, readonly text: string) {}
}
const refuse = (code: string, text: string): never => { throw new Refused(code, text) }

const OPEN_TAG = /^<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/
const CLOSE_TAG = /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

/** The strict tokenizer: plain tags, comments (dropped) and text, nothing else. */
function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  let pos = 0
  while (pos < html.length) {
    const lt = html.indexOf('<', pos)
    if (lt < 0 || lt > pos) tokens.push({ type: 'text', raw: html.slice(pos, lt < 0 ? undefined : lt) })
    if (lt < 0) break
    const rest = html.slice(lt)
    if (rest.startsWith('<!--')) {
      const end = html.indexOf('-->', lt + 4)
      if (end < 0) refuse('malformed-html', 'An HTML comment is not closed.')
      pos = end + 3
      continue
    }
    const close = CLOSE_TAG.exec(rest)
    const open = close ? null : OPEN_TAG.exec(rest)
    if (close) tokens.push({ type: 'close', name: close[1]!.toLowerCase() })
    else if (open) {
      const name = open[1]!.toLowerCase()
      const attrs: Record<string, string> = {}
      for (const a of open[2]!.matchAll(ATTRIBUTE)) attrs[a[1]!.toLowerCase()] ??= decodeHTML(a[2] ?? a[3] ?? a[4] ?? '')
      if (open[3] && !VOID.has(name)) refuse('malformed-html', `<${name}/> must not be self-closing.`)
      tokens.push({ type: 'open', name, attrs })
    } else refuse('malformed-html', `Malformed markup: “${rest.slice(0, 30)}”. A “<” that doesn't start a tag must be written as &lt;.`)
    pos = lt + (close ?? open)![0].length
  }
  return tokens
}

/** Checks the tokens against the features and the structure rules, and keeps only the known attributes. */
function validate(tokens: Token[], features: Features): Token[] {
  const out: Token[] = []
  const stack: string[] = []
  let linkText: string | undefined
  for (const t of tokens) {
    const parent = stack.at(-1)
    if (t.type == 'text') {
      if (parent && CHILDREN[parent] && t.raw.trim()) refuse('bad-nesting', `Text is not allowed directly inside <${parent}>.`)
      if (linkText != undefined) linkText += t.raw
      out.push({ type: 'text', raw: clean(t.raw) })
    } else if (t.type == 'close') {
      if (parent != t.name) refuse('malformed-html', parent ? `Expected </${parent}>, found </${t.name}>.` : `</${t.name}> closes no element.`)
      stack.pop()
      if (t.name == 'a') {
        if ([...decodeHTML(linkText!).trim()].length > MAX_LINK_TEXT_LENGTH)
          refuse('link-text-too-long', `A link text is longer than ${MAX_LINK_TEXT_LENGTH} characters.`)
        linkText = undefined
      }
      out.push(t)
    } else {
      const feature = ELEMENTS[t.name]
      if (!feature) refuse('forbidden-element', `The element <${t.name}> is not allowed.`)
      if (feature != 'always' && !features[feature!])
        refuse('forbidden-element', `The element <${t.name}> is not allowed: this feed doesn't accept ${FEATURE_NAMES[feature!]}.`)
      const parents = PARENTS[t.name]
      if (parents && !parents.includes(parent!)) refuse('bad-nesting', `<${t.name}> must be inside ${parents.map(p => `<${p}>`).join(' or ')}.`)
      if (parent && CHILDREN[parent] && !CHILDREN[parent].includes(t.name)) refuse('bad-nesting', `<${t.name}> is not allowed directly inside <${parent}>.`)
      if (t.name == 'a' && stack.includes('a')) refuse('bad-nesting', 'Links must not be nested.')
      const attrs: Record<string, string> = {}
      for (const name of KEPT_ATTRIBUTES[t.name] ?? []) if (t.attrs[name] != undefined) attrs[name] = clean(t.attrs[name])
      const required = REQUIRED_ATTRIBUTE[t.name]
      if (required) {
        const url = attrs[required]
        if (!url) refuse('missing-attribute', `<${t.name}> needs the attribute ${required}.`)
        if (url!.length > MAX_URL_LENGTH) refuse('url-too-long', `A URL is longer than ${MAX_URL_LENGTH} characters.`)
        if (!isCommentUrl(url!)) refuse('invalid-url', `Only absolute http and https URLs are allowed: “${url!.slice(0, 80)}”.`)
      }
      if (t.name == 'a') linkText = ''
      if (!VOID.has(t.name)) stack.push(t.name)
      out.push({ type: 'open', name: t.name, attrs })
    }
  }
  if (stack.length) refuse('malformed-html', `<${stack.at(-1)}> is not closed.`)
  return out
}

/** A bare URL in text, before trailing punctuation is trimmed (RFC-5 `urlAutoLinking`). */
const BARE_URL = /(?<![\p{L}\p{N}_/])https?:\/\/[^\s<>"]+/giu

/** The bare URL at the start of `raw` (encoded text), without what follows it: an entity of a delimiter, or punctuation. */
function urlEnd(raw: string): string {
  let url = raw.replace(/&(?:lt|gt|quot|apos|#\d+|#x[0-9a-f]+);[\s\S]*$/i, '')
  for (;;) {
    const before = url
    url = url.replace(/[.,:;!?'*_~]+$/, '')
    if (url.endsWith(')') && url.split('(').length < url.split(')').length) url = url.slice(0, -1)
    if (url == before) return url
  }
}

/** Turns bare http(s) URLs in the text into links, except inside links, code and pre. URLs that break the rules stay text. */
function autoLink(tokens: Token[]): Token[] {
  const out: Token[] = []
  let shielded = 0
  for (const t of tokens) {
    if (t.type != 'text') {
      if (['a', 'code', 'pre'].includes(t.name)) shielded += t.type == 'open' ? 1 : -1
      out.push(t)
      continue
    }
    let pos = 0
    if (!shielded) for (const m of t.raw.matchAll(BARE_URL)) {
      if (m.index < pos) continue
      const raw = urlEnd(m[0])
      const href = decodeHTML(raw)
      if (!isCommentUrl(href)) continue
      if (m.index > pos) out.push({ type: 'text', raw: t.raw.slice(pos, m.index) })
      out.push({ type: 'open', name: 'a', attrs: { href } }, { type: 'text', raw }, { type: 'close', name: 'a' })
      pos = m.index + raw.length
    }
    if (pos < t.raw.length) out.push({ type: 'text', raw: t.raw.slice(pos) })
  }
  return out
}

/** The visible text (RFC-5 "Length"): entities decoded, block elements and `br` separate words, whitespace collapsed. */
const visible = (tokens: Token[]) =>
  tokens.map(t => t.type == 'text' ? decodeHTML(t.raw) : INLINE.has(t.name) ? '' : ' ').join('').replace(/\s+/g, ' ').trim()

const serialize = (tokens: Token[]) => tokens.map(t => t.type == 'text' ? t.raw : t.type == 'close' ? `</${t.name}>`
  : `<${t.name}${Object.entries(t.attrs).map(([k, v]) => ` ${k}="${h(v)}"`).join('')}>`).join('').trim()

/**
 * Checks a comment against RFC-5 and the policy's features and lengths, and returns its normalized HTML, the Markdown
 * it came from, and the length of its visible text. The first form present counts: Markdown, HTML, text.
 */
export function commentContent(c: CommentSource, policy: Features & { minLength: number; maxLength: number }): CommentContent {
  const markdown = c.markdown?.trim() ? c.markdown : undefined
  const html = c.html?.trim() ? c.html : undefined
  const source = (markdown ?? html ?? c.text ?? '').trim()
  if (!source) return { ok: false, code: 'empty-content', text: 'The comment is empty.' }
  if ([...source].length > policy.maxLength)
    return { ok: false, code: 'too-long', text: `The comment is longer than ${policy.maxLength} characters.` }
  try {
    const checked = validate(tokenize(markdown != undefined ? markdownHtml(markdown) : html ?? textCommentHtml(source)), policy)
    const tokens = policy.urlAutoLinking ? autoLink(checked) : checked
    const length = [...visible(tokens)].length
    if (!length && !tokens.some(t => t.type == 'open' && t.name == 'img')) return { ok: false, code: 'empty-content', text: 'The comment is empty.' }
    if (length < policy.minLength) return { ok: false, code: 'too-short', text: `The comment is shorter than ${policy.minLength} characters.` }
    return { ok: true, html: serialize(tokens), ...markdown != undefined && { markdown }, length }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, code: e.code, text: e.text }
    throw e
  }
}
