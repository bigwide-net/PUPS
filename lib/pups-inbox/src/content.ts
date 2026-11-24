import type { ChildNode, Element } from 'domhandler'
import { parseDocument } from 'htmlparser2'
import { escapeHtml as h, stripUnsafe } from 'pups-ui'

/**
 * The text of incoming posts (RFC-11 mentions, RFC-4 comments): their visible text, the handles in it, and excerpts.
 * The HTML of comments is checked by comment-html.ts.
 */

/** Elements that separate words: their start and end count as whitespace in the visible text. */
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul'])
/** Elements whose content is never shown. */
export const HIDDEN_TAGS = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'head', 'title',
  'select', 'textarea', 'button'])

/**
 * A handle (RFC-11 "Handles"): `@` and a host name of at least two labels, the last one starting with a letter.
 * Before it: the start, whitespace, or punctuation other than `. _ - + / @` (no e-mail addresses). After it: the
 * end, whitespace, or punctuation other than `- _ / @`, where a `.` ends the handle unless a letter or digit follows
 * (no fediverse addresses, no paths). A `/` directly between two handles separates them: `@a.example/@b.example`
 * names both.
 */
const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]*[\\p{L}\\p{M}\\p{N}])?'
const HOST = `(?:${LABEL}\\.)+\\p{L}(?:[\\p{L}\\p{M}\\p{N}-]*[\\p{L}\\p{M}\\p{N}])?`
const HANDLES_RE = new RegExp(
  `(?:^|(?<=[\\s\\p{P}\\p{S}]))(?<![._\\-+/@])@(${HOST}(?:/@${HOST})*)(?![\\p{L}\\p{M}\\p{N}_\\-/@]|\\.[\\p{L}\\p{N}])`, 'gu')

export const isElement = (n: ChildNode): n is Element => n.type == 'tag' || n.type == 'script' || n.type == 'style'

/** Replaces lone surrogates (the JavaScript form of invalid UTF-16) with U+FFFD, which counts as unsafe. */
export const wellFormed = (s: string) => s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')

/** Parses an HTML fragment into its nodes. */
export const parseHtml = (html: string) => parseDocument(wellFormed(html)).children

/** Collapses whitespace and removes unsafe characters. */
export const normalizeSpace = (s: string) => stripUnsafe(wellFormed(s), ' ').replace(/\s+/g, ' ').trim()

/** The visible text of HTML. `skipCode` leaves out `code` and `pre`, as handles there don't count. */
export function visibleText(html: string, skipCode = false): string {
  let out = ''
  const walk = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (n.type == 'text') out += n.data
      else if (isElement(n)) {
        const tag = n.name.toLowerCase()
        const block = BLOCK_TAGS.has(tag)
        if (block) out += ' '
        if (!HIDDEN_TAGS.has(tag) && !(skipCode && (tag == 'code' || tag == 'pre'))) walk(n.children)
        else if (skipCode) out += ' '
        if (block) out += ' '
      }
    }
  }
  if (html.trim()) walk(parseHtml(html))
  return normalizeSpace(out)
}

/** A host name in the form handles are compared in: lowercase ASCII (IDNA). Undefined if it isn't a valid host. */
export function asciiHost(host: string): string | undefined {
  try {
    const url = new URL(`https://${host}/`)
    return url.hostname && url.pathname == '/' && !url.port ? url.hostname.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/** The hosts of all handles in a text, in comparable form and in order, each once. */
export function handles(text: string): string[] {
  const hosts = [...text.matchAll(HANDLES_RE)].flatMap(m => m[1]!.split('/@').map(asciiHost))
  return [...new Set(hosts.filter((x): x is string => !!x))]
}

/** The host of an account like `@alice.example.com`, in comparable form, or undefined. */
export function accountHost(account: unknown): string | undefined {
  const m = typeof account == 'string' ? /^@([^@\s/]+)$/u.exec(account.trim()) : null
  return m ? asciiHost(m[1]!) : undefined
}

/** The parts of a post that its text comes from. */
export interface PostText {
  title?: string
  html?: string
  text?: string
  markdown?: string
}

/** The text in which handles are found: the title and the visible text, without code. */
export function handleText(item: PostText): string {
  const body = item.html != undefined ? visibleText(item.html, true) : normalizeSpace(item.text ?? item.markdown ?? '')
  return `${item.title ?? ''} ${body}`.trim()
}

/** The plain text of a post, for excerpts and length rules: Markdown is preferred, as in RFC-4. */
export const plainText = (item: PostText) => item.markdown != undefined ? normalizeSpace(item.markdown)
  : item.html != undefined ? visibleText(item.html) : normalizeSpace(item.text ?? '')

/** Plain text as HTML paragraphs. */
export const textHtml = (text: string) => wellFormed(text).split(/(?:\r\n|\r|\n){2,}/).map(p => p.trim()).filter(Boolean)
  .map(p => `<p>${h(stripUnsafe(p)).replace(/(\r\n|\r|\n)/g, '<br>$1')}</p>`).join('')
