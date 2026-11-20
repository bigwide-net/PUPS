import { errorPage } from 'pups-ui'
/** An error that becomes a JSON response `{"error", "message"}`. */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public headers: Record<string, string> = {}) {
    super(message)
  }
  response() {
    return json({ error: this.code, message: this.message }, this.status, this.headers)
  }
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })

export const EXPOSE_HEADERS = 'ETag, Location, WWW-Authenticate'

/** Adds the CORS headers that every response of a CORS-enabled endpoint carries. */
export function withCors(res: Response): Response {
  const r = new Response(res.body, res)
  r.headers.set('Access-Control-Allow-Origin', '*')
  r.headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS)
  return r
}

export const preflight = () => new Response(null, {
  status: 204,
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': EXPOSE_HEADERS,
  },
})

/** Runs a handler of a CORS-enabled endpoint: answers preflights, adds CORS headers to every response. */
export async function cors(req: Request, handler: () => Promise<Response> | Response): Promise<Response> {
  if (req.method == 'OPTIONS') return preflight()
  try {
    return withCors(await handler())
  } catch (e) {
    if (e instanceof HttpError) return withCors(e.response())
    console.error(e)
    return withCors(json({ error: 'server_error', message: 'Internal server error' }, 500))
  }
}

export const methodNotAllowed = (allow: string) =>
  new HttpError(405, 'method_not_allowed', 'Method not allowed', { Allow: allow })

/** Reads a request body up to `max` bytes. Returns null if the body is larger. */
export async function readLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/**
 * Size limits, in characters, for every string read from a request. Values over a limit are
 * rejected, never truncated, so nothing is silently changed.
 */
export const LIMITS = {
  /** client_id, redirect_uri, hrefs, return_to and other URLs. */
  url: 2048,
  /** The whole scope parameter (at most 20 scopes, see paths.ts). */
  scope: 2048,
  /** OAuth state, echoed back to the app. */
  state: 1024,
  /** Authorization codes, access and refresh tokens (ours have 43 characters). */
  token: 256,
  password: 1024,
  /** Signed form fields, and passkey responses (JSON). */
  signed: 16384,
  /** Request headers we read: Authorization, If-Match, If-None-Match, Content-Type, Cookie. */
  header: 4096,
  /** A path in the POST fallback, before percent-decoding. */
  rawPath: 2048,
  /** Fields of one form, or parameters of one query. */
  count: 1000,
  /** Everything else: grant_type, decision, step, IDs, rels. */
  short: 256,
  /** Form bodies. */
  formBytes: 64 * 1024,
} as const

/** Limits of the form fields and query parameters we read, by name. Other names get LIMITS.short. */
const FIELD_LIMITS: Record<string, number> = {
  client_id: LIMITS.url, redirect_uri: LIMITS.url, return_to: LIMITS.url, scope: LIMITS.scope, state: LIMITS.state,
  code: LIMITS.token, refresh_token: LIMITS.token, token: LIMITS.token, code_verifier: 128,
  password: LIMITS.password, new_password: LIMITS.password, new_password2: LIMITS.password, secret: LIMITS.password,
  request: LIMITS.signed, setup: LIMITS.signed, passkey: LIMITS.signed, passkey_registration: LIMITS.signed,
  remove_link: 4096, remove_property: 512, path: LIMITS.rawPath,
}

const tooLong = (name: string, max: number) => new HttpError(400, 'invalid_request', `${name} is longer than ${max} characters`)

/** Checks every entry of a form or query: strings only, each within the limit for its name. Throws 400. */
export function checkFields(entries: Iterable<[string, string | File]>) {
  let n = 0
  for (const [name, value] of entries) {
    if (++n > LIMITS.count) throw new HttpError(400, 'invalid_request', `More than ${LIMITS.count} fields`)
    if (typeof value != 'string') throw new HttpError(400, 'invalid_request', 'File uploads are not accepted here')
    const max = FIELD_LIMITS[name] ?? LIMITS.short
    if (name.length > LIMITS.short) throw tooLong('A field name', LIMITS.short)
    if (value.length > max) throw tooLong(name, max)
  }
}

/** Reads a form body of at most LIMITS.formBytes and checks every field (checkFields). Throws 400 or 413. */
export async function readForm(req: Request): Promise<FormData> {
  const tooLarge = new HttpError(413, 'too_large', `Form bodies may have at most ${LIMITS.formBytes} bytes`)
  if (Number(req.headers.get('content-length')) > LIMITS.formBytes) throw tooLarge
  const body = await readLimited(req.body, LIMITS.formBytes)
  if (!body) throw tooLarge
  const form = await new Request(req.url, { method: 'POST', headers: { 'content-type': req.headers.get('content-type') ?? '' }, body })
    .formData().catch(() => { throw new HttpError(400, 'invalid_request', 'The form could not be parsed') })
  checkFields(form)
  return form
}

/** The query parameters of a request, each checked (checkFields). Throws 400. */
export function readQuery(req: Request): URLSearchParams {
  const q = new URL(req.url).searchParams
  checkFields(q)
  return q
}

/** A request header, at most LIMITS.header characters long. Throws 400. */
export function header(req: Request, name: string): string | null {
  const v = req.headers.get(name)
  if (v && v.length > LIMITS.header) throw tooLong(name, LIMITS.header)
  return v
}

/** Runs an owner-page handler; request errors (e.g. oversized values) become an HTML error page instead of JSON. */
export async function htmlErrors(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler()
  } catch (e) {
    if (!(e instanceof HttpError)) throw e
    return errorPage('Invalid request', e.message, e.status)
  }
}
