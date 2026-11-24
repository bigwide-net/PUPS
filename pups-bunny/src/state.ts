import { type Job, STATUS_KEEP_MS, type Status } from 'pups-inbox'
import { hashToken, randomToken } from './crypto'
import type { Files } from './storage'

/**
 * All state of one installation (one owner), kept as small JSON files under `_pups/` in the
 * storage zone. Uploaded files can never be written or served there (see paths.ts).
 *
 * Bunny Storage has no transactions or conditional writes, so every check-and-set here is a
 * read followed by a write. Two requests in the same instant can both pass a check: a code
 * redeemed twice in parallel yields two grants, and parallel refreshes with the same token
 * can both succeed. With one owner and PKCE this is acceptable (README, "Consistency").
 *
 * Files:
 *   _pups/secret.json            HMAC key for signed form fields and challenges
 *   _pups/owner.json             password hash and passkeys
 *   _pups/login.json             recent failed logins
 *   _pups/storage.json           bytes used by uploads (approximate)
 *   _pups/grants/<id>.json       a grant with its token hashes and refresh state
 *   _pups/usage/<id>.json        when a grant was last used; written separately so it never overwrites a refresh
 *   _pups/codes/<hash>.json      authorization codes
 *   _pups/nonces/<nonce>.json    used single-use nonces (approvals, setup, passkey challenges)
 *   _pups/sessions/<hash>.json   owner sessions (auth subdomain mode)
 *   _pups/clients/<hash>.json    cached client metadata documents
 *   _pups/approved/<hash>.json   apps the owner has approved before
 *   _pups/settings/<key>.json    settings the owner chose (the homepage) and markers (the mention link)
 *   _pups/mentions/queue/<key>.json   webmentions waiting to be checked (pups-inbox)
 *   _pups/mentions/status/<id>.json   comment status pages, for 24 hours
 */

export const STATE_PREFIX = '_pups/'

export const CODE_TTL = 60_000
export const ACCESS_TTL = 3600_000
export const REFRESH_TTL = 180 * 24 * 3600_000
export const SESSION_TTL = 30 * 24 * 3600_000
/**
 * A replaced refresh token stays usable this long, as long as nothing issued by the refresh
 * that replaced it has been used (RFC-6 "Grace period": at least 60 s, at most 5 min).
 */
export const REFRESH_GRACE = 120_000
const LOGIN_WINDOW = 15 * 60_000
const LOGIN_FREE_FAILURES = 5
/** Replaced refresh tokens remembered per grant, to detect reuse. */
const OLD_REFRESH_KEPT = 50
/** lastUsedAt is written at most this often per grant and instance. */
const USAGE_WRITE_INTERVAL = 5 * 60_000
/** Opportunistic cleanup deletes at most this many files per run (subrequest budget). */
const CLEANUP_MAX_DELETES = 10

export interface Passkey {
  id: string
  publicKey: string
  counter: number
  transports: string[]
}

export interface Owner {
  passwordHash: string | null
  passkeys: Passkey[]
  createdAt: number
}

export interface Grant {
  id: string
  clientId: string
  clientHost: string
  clientName: string | null
  scope: string
  createdAt: number
  lastUsedAt: number | null
}

export interface CodeRecord {
  clientId: string
  clientHost: string
  clientName: string | null
  redirectUri: string
  codeChallenge: string
  scope: string
}

interface CodeFile {
  data: CodeRecord
  exp: number
  usedAt?: number
  grantId?: string
}

interface GrantFile extends Omit<Grant, 'lastUsedAt'> {
  /** Hashes of the valid access tokens, with their expiry. */
  access: Record<string, number>
  refresh?: {
    current: string
    exp: number
    /** The token `current` replaced, and when. */
    prev?: string
    replacedAt?: number
    /** The access token issued together with `current`. */
    successorAccess?: string
    /** Earlier refresh tokens: using one of them revokes the grant. */
    old: string[]
  }
}

interface UsageFile {
  lastUsedAt: number
  /** The successor access token, once it has been used: ends the grace period. */
  successorUsed?: string
}

export interface Tokens {
  access: string
  refresh: string | null
}

export type RedeemResult = { ok: true; grant: Grant; tokens: Tokens } | { ok: false; error: string; description: string }
export type RefreshResult = { ok: true; grant: Grant; tokens: Tokens } | { ok: false; revokedClient?: string }

/** Identify-only grants get no refresh token: there is nothing to refresh for. */
export const wantsRefresh = (scope: string) => scope.split(' ').some(x => x != 'identify')

const GRANT_ID = /^[A-Za-z0-9_-]{22}$/
/** Tokens are `<grant id>.<random>`, so a token leads to its grant file without an index. */
const grantIdOf = (token: string) => {
  const id = token.split('.')[0]
  return GRANT_ID.test(id) && token.length > id.length + 1 ? id : undefined
}

const secrets = new WeakMap<Files, string>()
/** Per instance: when this instance last wrote a grant's usage file, and successor tokens it marked. */
const usageWritten = new Map<string, number>()
const successorsMarked = new Set<string>()
/** Write rate limit per grant and minute, per instance (approximate, see README). */
const writeCounts = new Map<string, number>()

const publicGrant = (g: GrantFile, lastUsedAt: number | null = null): Grant => ({
  id: g.id, clientId: g.clientId, clientHost: g.clientHost, clientName: g.clientName, scope: g.scope, createdAt: g.createdAt, lastUsedAt,
})

export class Store {
  constructor(private files: Files) {}

  private key = (dir: string, name: string) => `${STATE_PREFIX}${dir}/${name}.json`
  private async nameKey(dir: string, value: string) {
    return this.key(dir, await hashToken(value))
  }
  private grantKey = (id: string) => this.key('grants', id)
  private usageKey = (id: string) => this.key('usage', id)

  // --- Auto-moderation (pups-inbox's moderation.ts) ----------------------------------

  private moderationKey = `${STATE_PREFIX}moderation.json`
  private moderationUsageKey = `${STATE_PREFIX}moderation-usage.json`

  /** The settings as JSON, the API key among them. */
  async moderationSettings(): Promise<string | undefined> {
    const s = await this.files.getJson<unknown>(this.moderationKey)
    return s == null ? undefined : JSON.stringify(s)
  }

  async setModerationSettings(json: string): Promise<void> {
    await this.files.putJson(this.moderationKey, JSON.parse(json))
  }

  /** The tokens used on `day` (YYYY-MM-DD, UTC). */
  async moderationTokens(day: string): Promise<number> {
    const u = await this.files.getJson<{ day?: string; tokens?: number }>(this.moderationUsageKey)
    return u?.day == day && Number.isInteger(u.tokens) ? u.tokens! : 0
  }

  async addModerationTokens(day: string, n: number): Promise<void> {
    await this.files.putJson(this.moderationUsageKey, { day, tokens: await this.moderationTokens(day) + n })
  }

  // --- Server secret ---------------------------------------------------------------

  /** The HMAC key for signed form fields. Generated on first use. */
  async secret(): Promise<string> {
    let s = secrets.get(this.files)
    if (s) return s
    const file = `${STATE_PREFIX}secret.json`
    s = (await this.files.getJson<{ key: string }>(file))?.key
    if (!s) await this.files.putJson(file, { key: s = randomToken(32) })
    secrets.set(this.files, s)
    return s
  }

  // --- Owner -----------------------------------------------------------------------

  private ownerKey = `${STATE_PREFIX}owner.json`

  async owner(): Promise<Owner | null> {
    return this.files.getJson<Owner>(this.ownerKey)
  }

  async ownerExists(): Promise<boolean> {
    return !!await this.owner()
  }

  /** Creates the owner. False if the owner already exists (setup is single-use). */
  async createOwner(passwordHash: string | null, passkey: Passkey | null): Promise<boolean> {
    if (!passwordHash && !passkey || await this.ownerExists()) return false
    await this.files.putJson(this.ownerKey, { passwordHash, passkeys: passkey ? [passkey] : [], createdAt: Date.now() } satisfies Owner)
    return true
  }

  private async updateOwner(fn: (o: Owner) => void) {
    const o = await this.owner()
    if (!o) return
    fn(o)
    await this.files.putJson(this.ownerKey, o)
  }

  setPassword = (passwordHash: string) => this.updateOwner(o => { o.passwordHash = passwordHash })

  updatePasskeyCounter = (id: string, counter: number) => this.updateOwner(o => {
    const p = o.passkeys.find(p => p.id == id)
    if (p) p.counter = counter
  })

  // --- Single-use nonces ---------------------------------------------------------------

  /** Marks a nonce as used. False if it was used before. */
  async useNonce(nonce: string, ttl: number): Promise<boolean> {
    const key = await this.nameKey('nonces', nonce)
    if (await this.files.stat(key)) return false
    await this.files.putJson(key, { exp: Date.now() + ttl })
    return true
  }

  // --- Login rate limiting ---------------------------------------------------------

  private loginKey = `${STATE_PREFIX}login.json`

  private async failures(): Promise<number[]> {
    return (await this.files.getJson<{ failures: number[] }>(this.loginKey))?.failures ?? []
  }

  /** Milliseconds until the next login attempt is allowed; 0 if allowed now. */
  async loginDelay(): Promise<number> {
    const now = Date.now()
    const all = (await this.failures()).filter(at => at > now - 24 * 3600_000).sort((a, b) => a - b)
    const recent = all.filter(at => at > now - LOGIN_WINDOW)
    if (recent.length < LOGIN_FREE_FAILURES) return 0
    // 5 failures in 15 minutes, then growing delays: 1, 2, 4, … minutes, at most a day.
    const delay = Math.min(60_000 * 2 ** Math.max(0, all.length - LOGIN_FREE_FAILURES), 24 * 3600_000)
    return Math.max(0, recent.at(-1)! + delay - now)
  }

  async loginFailed() {
    const now = Date.now()
    const failures = (await this.failures()).filter(at => at > now - 24 * 3600_000)
    await this.files.putJson(this.loginKey, { failures: [...failures, now].slice(-100) })
  }

  async loginSucceeded() {
    if ((await this.failures()).length) await this.files.putJson(this.loginKey, { failures: [] })
  }

  // --- Owner sessions (auth subdomain mode only) ---------------------------------------

  async createSession(idHash: string) {
    await this.files.putJson(this.key('sessions', idHash), { exp: Date.now() + SESSION_TTL })
  }

  async sessionValid(idHash: string): Promise<boolean> {
    const s = await this.files.getJson<{ exp: number }>(this.key('sessions', idHash))
    return !!s && s.exp > Date.now()
  }

  async deleteSession(idHash: string) {
    await this.files.delete(this.key('sessions', idHash))
  }

  async deleteAllSessions() {
    await this.files.deleteDir(`${STATE_PREFIX}sessions/`)
  }

  // --- Client metadata cache -----------------------------------------------------------

  async cachedClient(clientId: string): Promise<string | undefined> {
    const c = await this.files.getJson<{ metadata: string; exp: number }>(await this.nameKey('clients', clientId))
    return c && c.exp > Date.now() ? c.metadata : undefined
  }

  async cacheClient(clientId: string, metadata: string, ttl: number) {
    await this.files.putJson(await this.nameKey('clients', clientId), { metadata, exp: Date.now() + ttl })
  }

  async clientApproved(clientId: string): Promise<boolean> {
    return !!await this.files.stat(await this.nameKey('approved', clientId))
  }

  // --- Authorization codes and grants --------------------------------------------------

  async createCode(codeHash: string, data: CodeRecord) {
    const now = Date.now()
    await this.files.putJson(this.key('codes', codeHash), { data, exp: now + CODE_TTL } satisfies CodeFile)
    const approved = await this.nameKey('approved', data.clientId)
    if (!await this.files.stat(approved)) await this.files.putJson(approved, { clientId: data.clientId, at: now })
    if (Math.random() < 0.1) await this.cleanup()
  }

  private async newTokens(g: GrantFile, now: number, withRefresh: boolean): Promise<{ tokens: Tokens; access: string; refresh?: string }> {
    const tokens = { access: `${g.id}.${randomToken()}`, refresh: withRefresh ? `${g.id}.${randomToken()}` : null }
    const access = await hashToken(tokens.access)
    // Expired access tokens are dropped whenever new ones are added.
    g.access = Object.fromEntries(Object.entries(g.access).filter(([, exp]) => exp > now))
    g.access[access] = now + ACCESS_TTL
    return { tokens, access, refresh: tokens.refresh ? await hashToken(tokens.refresh) : undefined }
  }

  /**
   * Redeems a code. A code is single-use: a second attempt fails and revokes the grant
   * issued from it.
   */
  async redeemCode(codeHash: string, clientId: string, redirectUri: string, challenge: string): Promise<RedeemResult> {
    const now = Date.now()
    const fail = (description: string): RedeemResult => ({ ok: false, error: 'invalid_grant', description })
    const key = this.key('codes', codeHash)
    const code = await this.files.getJson<CodeFile>(key)
    if (!code) return fail('Unknown authorization code')
    if (code.usedAt) {
      if (code.grantId) await this.deleteGrant(code.grantId)
      return fail('The authorization code was already used; tokens issued from it are revoked')
    }
    const { data } = code
    const g: GrantFile = {
      id: randomToken(16), clientId, clientHost: data.clientHost, clientName: data.clientName, scope: data.scope, createdAt: now, access: {},
    }
    const valid = code.exp >= now && data.clientId == clientId && data.redirectUri == redirectUri && data.codeChallenge == challenge
    await this.files.putJson(key, { ...code, usedAt: now, ...valid && { grantId: g.id } } satisfies CodeFile)
    if (code.exp < now) return fail('The authorization code has expired')
    if (data.clientId != clientId) return fail('client_id does not match the authorization request')
    if (data.redirectUri != redirectUri) return fail('redirect_uri does not match the authorization request')
    if (data.codeChallenge != challenge) return fail('PKCE verification failed')
    const t = await this.newTokens(g, now, wantsRefresh(data.scope))
    if (t.refresh) g.refresh = { current: t.refresh, exp: now + REFRESH_TTL, old: [] }
    await this.files.putJson(this.grantKey(g.id), g)
    return { ok: true, grant: publicGrant(g), tokens: t.tokens }
  }

  private async grantFile(id: string | undefined): Promise<GrantFile | null> {
    return id ? this.files.getJson<GrantFile>(this.grantKey(id)) : null
  }

  private async usage(id: string): Promise<UsageFile | null> {
    return this.files.getJson<UsageFile>(this.usageKey(id))
  }

  /**
   * Rotates a refresh token. Reusing a token that was already replaced revokes the whole
   * grant, because it means the token was copied. Exception (RFC-6 grace period): the
   * token replaced last can be used again within REFRESH_GRACE as long as nothing issued by
   * its replacement has been used; the unused replacement tokens are then revoked.
   */
  async refresh(token: string, clientId: string): Promise<RefreshResult> {
    const now = Date.now()
    const g = await this.grantFile(grantIdOf(token))
    const r = g?.refresh
    if (!g || !r || g.clientId != clientId) return { ok: false }
    const hash = await hashToken(token)

    if (hash == r.current) {
      if (r.exp < now) return { ok: false }
      const t = await this.newTokens(g, now, true)
      g.refresh = {
        current: t.refresh!, exp: now + REFRESH_TTL, prev: hash, replacedAt: now, successorAccess: t.access,
        old: [...r.prev ? [r.prev] : [], ...r.old].slice(0, OLD_REFRESH_KEPT),
      }
      await this.files.putJson(this.grantKey(g.id), g)
      return { ok: true, grant: publicGrant(g), tokens: t.tokens }
    }

    if (hash == r.prev && now - r.replacedAt! <= REFRESH_GRACE && (await this.usage(g.id))?.successorUsed != r.successorAccess) {
      // A retry after a lost response: revoke the unused tokens of the earlier refresh.
      if (r.successorAccess) delete g.access[r.successorAccess]
      const t = await this.newTokens(g, now, true)
      // replacedAt stays: the grace period counts from the first refresh with this token. The
      // unused refresh token is forgotten, not kept in `old`: using it fails without revoking.
      g.refresh = { ...r, current: t.refresh!, exp: now + REFRESH_TTL, successorAccess: t.access }
      await this.files.putJson(this.grantKey(g.id), g)
      return { ok: true, grant: publicGrant(g), tokens: t.tokens }
    }

    // Only a token this grant really issued revokes it; a made-up one just fails.
    if (hash == r.prev || r.old.includes(hash)) {
      await this.deleteGrant(g.id)
      return { ok: false, revokedClient: g.clientId }
    }
    return { ok: false }
  }

  /**
   * RFC 7009 revocation. An access token is revoked alone; a refresh token revokes its
   * grant. Returns the client ID of a revoked grant, so the caller can clean up.
   */
  async revokeToken(token: string, clientId: string): Promise<string | undefined> {
    const g = await this.grantFile(grantIdOf(token))
    if (!g || g.clientId != clientId) return
    const hash = await hashToken(token)
    if (g.access[hash]) {
      delete g.access[hash]
      await this.files.putJson(this.grantKey(g.id), g)
      return
    }
    const r = g.refresh
    if (r && (hash == r.current || hash == r.prev || r.old.includes(hash))) {
      await this.deleteGrant(g.id)
      return g.clientId
    }
  }

  private async deleteGrant(id: string) {
    await this.files.delete(this.grantKey(id))
    await this.files.delete(this.usageKey(id))
  }

  /** Revokes a grant (owner action). Returns its client ID. */
  async revokeGrant(id: string): Promise<string | undefined> {
    const g = await this.grantFile(id)
    if (g) await this.deleteGrant(id)
    return g?.clientId
  }

  /** Does the client still have an active grant? */
  async clientHasGrant(clientId: string): Promise<boolean> {
    return (await this.activeGrants()).some(g => g.clientId == clientId)
  }

  /** All grants, newest first. One listing per directory plus one read per grant. */
  async activeGrants(): Promise<Grant[]> {
    const [grants, usage] = await Promise.all([this.files.list(`${STATE_PREFIX}grants/`), this.files.list(`${STATE_PREFIX}usage/`)])
    const lastUsed = new Map(usage.map(u => [u.name, u.lastModified ?? null]))
    const files = await Promise.all(grants.filter(e => !e.isDirectory && e.name.endsWith('.json'))
      .map(e => this.files.getJson<GrantFile>(`${STATE_PREFIX}grants/${e.name}`)))
    return files.filter(g => !!g).map(g => publicGrant(g, lastUsed.get(`${g.id}.json`) ?? null))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Looks up an access token. With `countWrite`, also applies the per-grant write rate
   * limit; `rateLimited` is then true if the limit is reached.
   */
  async authenticate(token: string, countWrite?: number): Promise<{ grant: Grant; rateLimited: boolean } | null> {
    const now = Date.now()
    const g = await this.grantFile(grantIdOf(token))
    if (!g) return null
    const hash = await hashToken(token)
    if (!(g.access[hash] > now)) return null

    // Using the access token of the latest refresh ends the grace period of the token it replaced.
    const markSuccessor = hash == g.refresh?.successorAccess && !successorsMarked.has(hash)
    if (markSuccessor || now - (usageWritten.get(g.id) ?? 0) > USAGE_WRITE_INTERVAL) {
      const u = await this.usage(g.id)
      await this.files.putJson(this.usageKey(g.id), { lastUsedAt: now, successorUsed: markSuccessor ? hash : u?.successorUsed } satisfies UsageFile)
      usageWritten.set(g.id, now)
      if (markSuccessor) successorsMarked.add(hash)
    }

    let rateLimited = false
    if (countWrite) {
      const minute = Math.floor(now / 60_000)
      const key = `${g.id}:${minute}`
      const n = (writeCounts.get(key) ?? 0) + 1
      if (writeCounts.size > 10_000) writeCounts.clear()
      writeCounts.set(key, n)
      rateLimited = n > countWrite
    }
    return { grant: publicGrant(g, now), rateLimited }
  }

  // --- Storage quota ---------------------------------------------------------------

  private storageKey = `${STATE_PREFIX}storage.json`

  async storageUsed(): Promise<number> {
    return (await this.files.getJson<{ used: number }>(this.storageKey))?.used ?? 0
  }

  /** Reserves `delta` bytes of the quota. False if the quota would be exceeded. */
  async reserveStorage(delta: number, max: number): Promise<boolean> {
    if (!delta) return true
    const used = await this.storageUsed()
    if (delta > 0 && max && used + delta > max) return false
    await this.files.putJson(this.storageKey, { used: Math.max(0, used + delta) })
    return true
  }

  // --- Cleanup ---------------------------------------------------------------------

  /** Deletes expired codes, nonces, sessions and cached client documents, by their age. */
  async cleanup(now = Date.now()) {
    let budget = CLEANUP_MAX_DELETES
    for (const [dir, maxAge] of [['codes', 24 * 3600_000], ['nonces', 24 * 3600_000], ['clients', 24 * 3600_000], ['sessions', SESSION_TTL],
      ['mentions/status', STATUS_KEEP_MS]] as const) {
      for (const e of await this.files.list(`${STATE_PREFIX}${dir}/`)) {
        if (!budget) return
        if (e.isDirectory || !e.lastModified || e.lastModified > now - maxAge) continue
        await this.files.delete(`${STATE_PREFIX}${dir}/${e.name}`)
        budget--
      }
    }
  }

  // --- Settings the owner chose, and markers -----------------------------------------

  /** A JSON value, e.g. the homepage the owner chose. */
  setting = (key: string): Promise<unknown> => this.files.getJson(this.key('settings', key))

  async setSetting(key: string, value: unknown) {
    if (value === undefined) await this.files.delete(this.key('settings', key))
    else await this.files.putJson(this.key('settings', key), value)
  }

  // --- Webmentions waiting to be checked, and comment status pages (pups-inbox) ---------

  private queueDir = `${STATE_PREFIX}mentions/queue/`

  queueGet = async (key: string) => await this.files.getJson<Job>(`${this.queueDir}${key}.json`) ?? undefined

  async queuePut(key: string, job: Job) {
    await this.files.putJson(`${this.queueDir}${key}.json`, job)
  }

  async queueDelete(key: string) {
    await this.files.delete(`${this.queueDir}${key}.json`)
  }

  /** The waiting webmentions, oldest first: one listing. */
  async queueKeys(prefix = ''): Promise<string[]> {
    return (await this.files.list(this.queueDir))
      .filter(e => !e.isDirectory && e.name.endsWith('.json') && e.name.startsWith(prefix))
      .sort((a, b) => (a.lastModified ?? 0) - (b.lastModified ?? 0) || a.name.localeCompare(b.name))
      .map(e => e.name.slice(0, -5))
  }

  async statusPut(id: string, status: Status, expiresAt: number) {
    await this.files.putJson(this.key('mentions/status', id), { status, expiresAt })
  }

  async statusGet(id: string, now = Date.now()): Promise<Status | undefined> {
    const f = await this.files.getJson<{ status: Status; expiresAt: number }>(this.key('mentions/status', id))
    return f && f.expiresAt >= now ? f.status : undefined
  }
}
