import { DurableObject } from 'cloudflare:workers'
import { pingAll, type Subscription } from 'pups-feeds'
import { IDENTITY_LOG_MS, IDENTITY_TOKENS_PER_MINUTE, type IdentityUse, type SigningKey } from 'pups-ui'
import { randomToken } from './crypto'
import type { Env } from './settings'

/**
 * All state of one installation (one owner) lives in this single SQLite-backed Durable
 * Object. Every method runs synchronously against SQLite, so each call is atomic: a code
 * can be redeemed only once, a refresh token rotated only once.
 */

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
/** Pings per alarm: an alarm may make at most 50 subrequests on the free plan. */
export const WEBSUB_BATCH = 40

export interface Passkey {
  id: string
  publicKey: string
  counter: number
  transports: string[]
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

export interface TokenHashes {
  access: string
  refresh: string | null
}

export type RedeemResult = { ok: true; grant: Grant } | { ok: false; error: string; description: string }

type Row = Record<string, SqlStorageValue>

/** Identify-only grants get no refresh token: there is nothing to refresh for. */
export const wantsRefresh = (scope: string) => scope.split(' ').some(x => x != 'identify')

export class PupsStore extends DurableObject<Env> {
  sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), password_hash TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, public_key TEXT NOT NULL, counter INTEGER NOT NULL,
        transports TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (challenge TEXT PRIMARY KEY, purpose TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_failures (at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS client_cache (client_id TEXT PRIMARY KEY, metadata TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approved_clients (client_id TEXT PRIMARY KEY, first_approved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codes (code_hash TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL,
        used_at INTEGER);
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, client_host TEXT NOT NULL,
        client_name TEXT, scope TEXT NOT NULL, code_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
        last_used_at INTEGER, revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS grants_code ON grants (code_hash);
      CREATE TABLE IF NOT EXISTS access_tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS access_grant ON access_tokens (grant_id);
      CREATE TABLE IF NOT EXISTS refresh_tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
        replaced_at INTEGER);
      CREATE INDEX IF NOT EXISTS refresh_grant ON refresh_tokens (grant_id);
      CREATE TABLE IF NOT EXISTS write_counters (grant_id TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (grant_id, minute));
      CREATE TABLE IF NOT EXISTS mention_queue (key TEXT PRIMARY KEY, job TEXT NOT NULL, received_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS comment_status (id TEXT PRIMARY KEY, status TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS websub_subscriptions (topic TEXT NOT NULL, callback TEXT NOT NULL, host TEXT NOT NULL, secret TEXT,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (topic, callback));
      CREATE TABLE IF NOT EXISTS identity_log (at INTEGER NOT NULL, grant_id TEXT NOT NULL, client_id TEXT NOT NULL, audience TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS identity_log_grant ON identity_log (grant_id, at);
      CREATE TABLE IF NOT EXISTS websub_pending (topic TEXT PRIMARY KEY, hub TEXT NOT NULL, changed_at INTEGER NOT NULL, cursor TEXT NOT NULL);
    `)
    // Refresh state per grant: the current refresh token, the one it replaced and when, the
    // access token issued with the current one, and whether anything issued by that refresh
    // has been used. Added as columns so that existing databases are migrated.
    const columns = new Set(this.sql.exec('PRAGMA table_info(grants)').toArray().map(r => r.name))
    for (const [name, type] of [['current_refresh', 'TEXT'], ['prev_refresh', 'TEXT'], ['replaced_at', 'INTEGER'],
      ['successor_access', 'TEXT'], ['successor_used', 'INTEGER NOT NULL DEFAULT 0']])
      if (!columns.has(name)) this.sql.exec(`ALTER TABLE grants ADD COLUMN ${name} ${type}`)
    // Read tokens (RFC-10) are marked in the log.
    if (!this.sql.exec('PRAGMA table_info(identity_log)').toArray().some(r => r.name == 'read'))
      this.sql.exec('ALTER TABLE identity_log ADD COLUMN read INTEGER NOT NULL DEFAULT 0')
  }

  private one(query: string, ...args: SqlStorageValue[]): Row | undefined {
    return this.sql.exec(query, ...args).toArray()[0]
  }

  private kvGet(key: string) {
    return this.one('SELECT value FROM kv WHERE key = ?', key)?.value as string | undefined
  }

  private kvSet(key: string, value: string) {
    this.sql.exec('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value)
  }

  /** Removes expired rows. Called opportunistically. */
  private cleanup(now = Date.now()) {
    this.sql.exec('DELETE FROM challenges WHERE expires_at < ?', now)
    this.sql.exec('DELETE FROM nonces WHERE expires_at < ?', now)
    this.sql.exec('DELETE FROM sessions WHERE expires_at < ?', now)
    this.sql.exec('DELETE FROM client_cache WHERE expires_at < ?', now)
    // Keep used codes a while longer than their lifetime so that reuse is still detected.
    this.sql.exec('DELETE FROM codes WHERE expires_at < ?', now - 24 * 3600_000)
    this.sql.exec('DELETE FROM access_tokens WHERE expires_at < ?', now)
    this.sql.exec('DELETE FROM refresh_tokens WHERE expires_at < ?', now)
    this.sql.exec('DELETE FROM login_failures WHERE at < ?', now - 7 * 24 * 3600_000)
    this.sql.exec('DELETE FROM write_counters WHERE minute < ?', Math.floor(now / 60_000) - 1)
    this.sql.exec('DELETE FROM comment_status WHERE expires_at < ?', now)
    this.sql.exec('DELETE FROM identity_log WHERE at < ?', now - IDENTITY_LOG_MS)
  }

  // --- Auto-moderation (pups-inbox's moderation.ts) ----------------------------------

  /** The settings as JSON, the API key among them. */
  moderationSettings(): string | undefined {
    return this.kvGet('moderation')
  }

  setModerationSettings(json: string) {
    this.kvSet('moderation', json)
  }

  /** The tokens used on `day` (YYYY-MM-DD, UTC). */
  moderationTokens(day: string): number {
    const u = JSON.parse(this.kvGet('moderation_usage') ?? '{}')
    return u.day == day && Number.isInteger(u.tokens) ? u.tokens : 0
  }

  addModerationTokens(day: string, n: number) {
    this.kvSet('moderation_usage', JSON.stringify({ day, tokens: this.moderationTokens(day) + n }))
  }

  // --- Server secret ---------------------------------------------------------------

  /** The HMAC key for signed form fields. Generated on first use. */
  secret(): string {
    let s = this.kvGet('signing_key')
    if (!s) this.kvSet('signing_key', s = randomToken(32))
    return s
  }

  // --- Identity tokens (RFC-10) -----------------------------------------------------

  /** The key that signs identity tokens, if there is one. It never leaves this object but to sign. */
  signingKey(): SigningKey | undefined {
    const k = this.kvGet('identity_key')
    return k ? JSON.parse(k) : undefined
  }

  /** Stores `key` unless there is a key already (`replace`: in place of it). Returns the key that is now in use. */
  setSigningKey(key: SigningKey, replace = false): SigningKey {
    const old = this.signingKey()
    if (old && !replace) return old
    this.kvSet('identity_key', JSON.stringify(key))
    return key
  }

  /**
   * Logs an identity token for the grant, for the audience; `read`: a read token. False, and nothing logged, if the grant
   * had IDENTITY_TOKENS_PER_MINUTE tokens in the last minute.
   */
  logIdentityToken(grant: Grant, audience: string, read = false): boolean {
    this.cleanup()
    const now = Date.now()
    if ((this.one('SELECT COUNT(*) AS n FROM identity_log WHERE grant_id = ? AND at > ?', grant.id, now - 60_000)!.n as number) >= IDENTITY_TOKENS_PER_MINUTE)
      return false
    this.sql.exec('INSERT INTO identity_log (at, grant_id, client_id, audience, read) VALUES (?, ?, ?, ?, ?)', now, grant.id, grant.clientId, audience, read ? 1 : 0)
    return true
  }

  /** Where the grant's app acted as the owner, per audience, the latest first. */
  identityUses(grantId: string): IdentityUse[] {
    return this.sql.exec(`SELECT audience, COUNT(*) AS count, SUM(read) AS reads, MAX(at) AS last FROM identity_log WHERE grant_id = ? AND at > ?
      GROUP BY audience ORDER BY last DESC`, grantId, Date.now() - IDENTITY_LOG_MS).toArray()
      .map(r => ({ audience: r.audience as string, count: r.count as number, reads: r.reads as number, last: r.last as number }))
  }

  // --- Owner -----------------------------------------------------------------------

  ownerExists(): boolean {
    return !!this.one('SELECT 1 AS x FROM owner WHERE id = 1')
  }

  owner(): { passwordHash: string | null; passkeys: Passkey[] } | null {
    const o = this.one('SELECT password_hash FROM owner WHERE id = 1')
    if (!o) return null
    const passkeys = this.sql.exec('SELECT id, public_key, counter, transports FROM passkeys').toArray().map(r => ({
      id: r.id as string, publicKey: r.public_key as string, counter: r.counter as number,
      transports: JSON.parse(r.transports as string) as string[],
    }))
    return { passwordHash: o.password_hash as string | null, passkeys }
  }

  /** Creates the owner. Returns false if the owner already exists (setup is single-use). */
  createOwner(passwordHash: string | null, passkey: Passkey | null): boolean {
    if (!passwordHash && !passkey) return false
    return this.ctx.storage.transactionSync(() => {
      if (this.ownerExists()) return false
      const now = Date.now()
      this.sql.exec('INSERT INTO owner (id, password_hash, created_at) VALUES (1, ?, ?)', passwordHash, now)
      if (passkey) this.addPasskeyRow(passkey, now)
      return true
    })
  }

  private addPasskeyRow(p: Passkey, now: number) {
    this.sql.exec('INSERT INTO passkeys (id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?)',
      p.id, p.publicKey, p.counter, JSON.stringify(p.transports), now)
  }

  addPasskey(p: Passkey) {
    if (this.ownerExists()) this.addPasskeyRow(p, Date.now())
  }

  /** Replaces all passkeys and the password (the recovery, owner.ts). */
  replaceCredentials(passwordHash: string | null, passkey: Passkey | null) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM passkeys')
      this.sql.exec('UPDATE owner SET password_hash = ? WHERE id = 1', passwordHash)
      if (passkey) this.addPasskeyRow(passkey, Date.now())
    })
  }

  setPassword(passwordHash: string) {
    this.sql.exec('UPDATE owner SET password_hash = ? WHERE id = 1', passwordHash)
  }

  updatePasskeyCounter(id: string, counter: number) {
    this.sql.exec('UPDATE passkeys SET counter = ? WHERE id = ?', counter, id)
  }

  // --- Challenges and single-use nonces ----------------------------------------------

  addChallenge(challenge: string, purpose: string, ttl: number) {
    this.cleanup()
    this.sql.exec('INSERT INTO challenges (challenge, purpose, expires_at) VALUES (?, ?, ?)', challenge, purpose, Date.now() + ttl)
  }

  /** Consumes a WebAuthn challenge. True if it existed, was unexpired and had this purpose. */
  takeChallenge(challenge: string, purpose: string): boolean {
    const r = this.one('DELETE FROM challenges WHERE challenge = ? RETURNING purpose, expires_at', challenge)
    return !!r && r.purpose == purpose && (r.expires_at as number) > Date.now()
  }

  /** Marks a nonce as used. False if it was used before. */
  useNonce(nonce: string, ttl: number): boolean {
    if (this.one('SELECT 1 AS x FROM nonces WHERE nonce = ?', nonce)) return false
    this.sql.exec('INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)', nonce, Date.now() + ttl)
    return true
  }

  // --- Login rate limiting ---------------------------------------------------------

  /** Milliseconds until the next login attempt is allowed; 0 if allowed now. */
  loginDelay(): number {
    const now = Date.now()
    const recent = this.sql.exec('SELECT at FROM login_failures WHERE at > ? ORDER BY at', now - LOGIN_WINDOW).toArray()
    if (recent.length < LOGIN_FREE_FAILURES) return 0
    // 5 failures in 15 minutes, then growing delays: 1, 2, 4, … minutes, at most a day.
    const all = (this.one('SELECT COUNT(*) AS n FROM login_failures WHERE at > ?', now - 24 * 3600_000)!.n as number)
    const delay = Math.min(60_000 * 2 ** Math.max(0, all - LOGIN_FREE_FAILURES), 24 * 3600_000)
    return Math.max(0, (recent.at(-1)!.at as number) + delay - now)
  }

  loginFailed() {
    this.sql.exec('INSERT INTO login_failures (at) VALUES (?)', Date.now())
  }

  loginSucceeded() {
    this.sql.exec('DELETE FROM login_failures')
  }

  // --- Owner sessions (auth subdomain mode only) ---------------------------------------

  createSession(idHash: string) {
    this.cleanup()
    this.sql.exec('INSERT INTO sessions (id_hash, expires_at) VALUES (?, ?)', idHash, Date.now() + SESSION_TTL)
  }

  sessionValid(idHash: string): boolean {
    return !!this.one('SELECT 1 AS x FROM sessions WHERE id_hash = ? AND expires_at > ?', idHash, Date.now())
  }

  deleteSession(idHash: string) {
    this.sql.exec('DELETE FROM sessions WHERE id_hash = ?', idHash)
  }

  deleteAllSessions() {
    this.sql.exec('DELETE FROM sessions')
  }

  // --- Client metadata cache -----------------------------------------------------------

  cachedClient(clientId: string): string | undefined {
    return this.one('SELECT metadata FROM client_cache WHERE client_id = ? AND expires_at > ?', clientId, Date.now())
      ?.metadata as string | undefined
  }

  cacheClient(clientId: string, metadata: string, ttl: number) {
    this.sql.exec(`INSERT INTO client_cache (client_id, metadata, expires_at) VALUES (?, ?, ?)
      ON CONFLICT (client_id) DO UPDATE SET metadata = excluded.metadata, expires_at = excluded.expires_at`,
      clientId, metadata, Date.now() + ttl)
  }

  clientApproved(clientId: string): boolean {
    return !!this.one('SELECT 1 AS x FROM approved_clients WHERE client_id = ?', clientId)
  }

  // --- Authorization codes and grants --------------------------------------------------

  createCode(codeHash: string, data: CodeRecord) {
    this.cleanup()
    const now = Date.now()
    this.sql.exec('INSERT INTO codes (code_hash, data, expires_at) VALUES (?, ?, ?)', codeHash, JSON.stringify(data), now + CODE_TTL)
    this.sql.exec('INSERT OR IGNORE INTO approved_clients (client_id, first_approved_at) VALUES (?, ?)', data.clientId, now)
  }

  /**
   * Redeems a code. A code is single-use: any second attempt fails and revokes the grant
   * (and so every token) issued from it.
   */
  redeemCode(codeHash: string, clientId: string, redirectUri: string, challenge: string, tokens: TokenHashes): RedeemResult {
    return this.ctx.storage.transactionSync((): RedeemResult => {
      const now = Date.now()
      const row = this.one('SELECT data, expires_at, used_at FROM codes WHERE code_hash = ?', codeHash)
      const fail = (description: string): RedeemResult => ({ ok: false, error: 'invalid_grant', description })
      if (!row) return fail('Unknown authorization code')
      if (row.used_at != null) {
        const g = this.one('SELECT id FROM grants WHERE code_hash = ?', codeHash)
        if (g) this.revokeGrantRows(g.id as string, now)
        return fail('The authorization code was already used; tokens issued from it are revoked')
      }
      this.sql.exec('UPDATE codes SET used_at = ? WHERE code_hash = ?', now, codeHash)
      if ((row.expires_at as number) < now) return fail('The authorization code has expired')
      const data = JSON.parse(row.data as string) as CodeRecord
      if (data.clientId != clientId) return fail('client_id does not match the authorization request')
      if (data.redirectUri != redirectUri) return fail('redirect_uri does not match the authorization request')
      if (data.codeChallenge != challenge) return fail('PKCE verification failed')
      const grant: Grant = {
        id: randomToken(16), clientId, clientHost: data.clientHost, clientName: data.clientName, scope: data.scope,
        createdAt: now, lastUsedAt: null,
      }
      const t = wantsRefresh(data.scope) ? tokens : { ...tokens, refresh: null }
      this.sql.exec(`INSERT INTO grants (id, client_id, client_host, client_name, scope, code_hash, created_at, current_refresh)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, grant.id, clientId, data.clientHost, data.clientName, data.scope, codeHash, now, t.refresh)
      this.insertTokens(grant.id, t, now)
      return { ok: true, grant }
    })
  }

  private insertTokens(grantId: string, t: TokenHashes, now: number) {
    this.sql.exec('INSERT INTO access_tokens (hash, grant_id, expires_at) VALUES (?, ?, ?)', t.access, grantId, now + ACCESS_TTL)
    if (t.refresh)
      this.sql.exec('INSERT INTO refresh_tokens (hash, grant_id, expires_at) VALUES (?, ?, ?)', t.refresh, grantId, now + REFRESH_TTL)
  }

  private grantRow(id: string): Grant | undefined {
    const r = this.one('SELECT * FROM grants WHERE id = ? AND revoked_at IS NULL', id)
    return r && {
      id: r.id as string, clientId: r.client_id as string, clientHost: r.client_host as string,
      clientName: r.client_name as string | null, scope: r.scope as string, createdAt: r.created_at as number,
      lastUsedAt: r.last_used_at as number | null,
    }
  }

  /**
   * Rotates a refresh token. Reusing a token that was already replaced revokes the whole
   * grant, because it means the token was copied. Exception (RFC-6 grace period): the
   * token replaced last can be used again within REFRESH_GRACE as long as nothing issued by
   * its replacement has been used; the unused replacement tokens are then revoked.
   */
  refresh(refreshHash: string, clientId: string, tokens: TokenHashes):
    { ok: true; grant: Grant } | { ok: false; revokedClient?: string } {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      const r = this.one('SELECT grant_id, expires_at FROM refresh_tokens WHERE hash = ?', refreshHash)
      const grant = r && this.grantRow(r.grant_id as string)
      // Unknown, expired, revoked or replaced-in-grace tokens fail without revoking the grant.
      if (!r || !grant || grant.clientId != clientId) return { ok: false as const }
      const st = this.one('SELECT current_refresh, prev_refresh, replaced_at, successor_access, successor_used FROM grants WHERE id = ?', grant.id)!

      if (refreshHash == st.current_refresh) {
        if ((r.expires_at as number) < now) return { ok: false as const }
        this.sql.exec('UPDATE refresh_tokens SET replaced_at = ? WHERE hash = ?', now, refreshHash)
        this.insertTokens(grant.id, tokens, now)
        this.sql.exec(`UPDATE grants SET prev_refresh = ?, current_refresh = ?, replaced_at = ?, successor_access = ?,
          successor_used = 0 WHERE id = ?`, refreshHash, tokens.refresh, now, tokens.access, grant.id)
        return { ok: true as const, grant }
      }

      if (refreshHash == st.prev_refresh && now - (st.replaced_at as number) <= REFRESH_GRACE && !st.successor_used) {
        // A retry after a lost response: revoke the unused tokens of the earlier refresh.
        this.sql.exec('DELETE FROM refresh_tokens WHERE hash = ?', st.current_refresh)
        this.sql.exec('DELETE FROM access_tokens WHERE hash = ?', st.successor_access)
        this.insertTokens(grant.id, tokens, now)
        // replaced_at stays: the grace period counts from the first refresh with this token.
        this.sql.exec('UPDATE grants SET current_refresh = ?, successor_access = ?, successor_used = 0 WHERE id = ?',
          tokens.refresh, tokens.access, grant.id)
        return { ok: true as const, grant }
      }

      this.revokeGrantRows(grant.id, now)
      return { ok: false as const, revokedClient: grant.clientId }
    })
  }

  /**
   * RFC 7009 revocation. An access token is revoked alone; a refresh token revokes its
   * grant. Returns the client ID of a revoked grant, so the caller can clean up.
   */
  revokeToken(hash: string, clientId: string): string | undefined {
    return this.ctx.storage.transactionSync(() => {
      const a = this.one('SELECT grant_id FROM access_tokens WHERE hash = ?', hash)
      if (a) {
        if (this.grantRow(a.grant_id as string)?.clientId == clientId) this.sql.exec('DELETE FROM access_tokens WHERE hash = ?', hash)
        return
      }
      const r = this.one('SELECT grant_id FROM refresh_tokens WHERE hash = ?', hash)
      const g = r && this.grantRow(r.grant_id as string)
      if (g?.clientId == clientId) {
        this.revokeGrantRows(g.id, Date.now())
        return g.clientId
      }
    })
  }

  private revokeGrantRows(grantId: string, now: number) {
    this.sql.exec('UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now, grantId)
    this.sql.exec('DELETE FROM access_tokens WHERE grant_id = ?', grantId)
    this.sql.exec('DELETE FROM refresh_tokens WHERE grant_id = ?', grantId)
  }

  /** Revokes a grant (owner action). Returns its client ID. */
  revokeGrant(grantId: string): string | undefined {
    const g = this.grantRow(grantId)
    if (g) this.revokeGrantRows(grantId, Date.now())
    return g?.clientId
  }

  /** Does the client still have an active grant? */
  clientHasGrant(clientId: string): boolean {
    return !!this.one('SELECT 1 AS x FROM grants WHERE client_id = ? AND revoked_at IS NULL', clientId)
  }

  activeGrants(): Grant[] {
    return this.sql.exec('SELECT id FROM grants WHERE revoked_at IS NULL ORDER BY created_at DESC').toArray()
      .map(r => this.grantRow(r.id as string)!)
  }

  /**
   * Looks up an access token. With `countWrite`, also applies the per-grant write rate
   * limit; `rateLimited` is then true if the limit is reached.
   */
  authenticate(accessHash: string, countWrite?: number): { grant: Grant; rateLimited: boolean } | null {
    const now = Date.now()
    const t = this.one('SELECT grant_id FROM access_tokens WHERE hash = ? AND expires_at > ?', accessHash, now)
    const grant = t && this.grantRow(t.grant_id as string)
    if (!grant) return null
    // Using the access token of the latest refresh ends the grace period of the token it replaced.
    this.sql.exec(`UPDATE grants SET last_used_at = ?,
      successor_used = CASE WHEN successor_access = ? THEN 1 ELSE successor_used END WHERE id = ?`, now, accessHash, grant.id)
    let rateLimited = false
    if (countWrite) {
      const minute = Math.floor(now / 60_000)
      const c = this.one(`INSERT INTO write_counters (grant_id, minute, count) VALUES (?, ?, 1)
        ON CONFLICT (grant_id, minute) DO UPDATE SET count = count + 1 RETURNING count`, grant.id, minute)!
      rateLimited = (c.count as number) > countWrite
    }
    return { grant, rateLimited }
  }

  // --- Storage quota ---------------------------------------------------------------

  /** Reserves `delta` bytes of the quota. False if the quota would be exceeded. */
  reserveStorage(delta: number, max: number): boolean {
    const used = Number(this.kvGet('storage_used') ?? 0)
    if (delta > 0 && max && used + delta > max) return false
    this.kvSet('storage_used', String(Math.max(0, used + delta)))
    return true
  }

  storageUsed(): number {
    return Number(this.kvGet('storage_used') ?? 0)
  }

  // --- Locks ------------------------------------------------------------------------

  /**
   * Takes the lock `name` for at most `ttlMs` (in case its holder never returns it). Returns its token, or undefined
   * while someone else holds it. The Durable Object runs one call at a time, so taking a lock is atomic.
   */
  lock(name: string, ttlMs: number): string | undefined {
    const now = Date.now()
    const held = this.one('SELECT expires_at FROM locks WHERE name = ?', name)
    if (held && Number(held.expires_at) > now) return
    const token = randomToken(16)
    this.sql.exec(`INSERT INTO locks (name, token, expires_at) VALUES (?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`, name, token, now + ttlMs)
    return token
  }

  unlock(name: string, token: string) {
    this.sql.exec('DELETE FROM locks WHERE name = ? AND token = ?', name, token)
  }

  // --- Settings the owner chose, and markers -----------------------------------------

  /** A JSON value, e.g. the homepage the owner chose. */
  setting(key: string): unknown {
    const v = this.kvGet(`setting:${key}`)
    return v == undefined ? undefined : JSON.parse(v)
  }

  setSetting(key: string, value: unknown) {
    if (value === undefined) this.sql.exec('DELETE FROM kv WHERE key = ?', `setting:${key}`)
    else this.kvSet(`setting:${key}`, JSON.stringify(value))
  }

  // --- Webmentions waiting to be checked, and comment status pages (pups-inbox) ---------

  queueGet(key: string): string | undefined {
    return this.one('SELECT job FROM mention_queue WHERE key = ?', key)?.job as string | undefined
  }

  queuePut(key: string, job: string, receivedAt: number) {
    this.sql.exec(`INSERT INTO mention_queue (key, job, received_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET job = excluded.job, received_at = excluded.received_at`, key, job, receivedAt)
  }

  queueDelete(key: string) {
    this.sql.exec('DELETE FROM mention_queue WHERE key = ?', key)
  }

  queueCount(prefix = ''): number {
    return Number(this.one("SELECT COUNT(*) AS n FROM mention_queue WHERE substr(key, 1, length(?)) = ?", prefix, prefix)?.n ?? 0)
  }

  queueOldest(): { key: string; job: string } | undefined {
    const r = this.one('SELECT key, job FROM mention_queue ORDER BY received_at, key LIMIT 1')
    return r && { key: r.key as string, job: r.job as string }
  }

  statusPut(id: string, status: string, expiresAt: number) {
    this.sql.exec(`INSERT INTO comment_status (id, status, expires_at) VALUES (?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET status = excluded.status, expires_at = excluded.expires_at`, id, status, expiresAt)
  }

  statusGet(id: string, now = Date.now()): string | undefined {
    return this.one('SELECT status FROM comment_status WHERE id = ? AND expires_at >= ?', id, now)?.status as string | undefined
  }

  // --- The WebSub hub (pups-feeds' websub.ts) --------------------------------------------

  wsGet(topic: string, callback: string): Subscription | undefined {
    const r = this.one('SELECT * FROM websub_subscriptions WHERE topic = ? AND callback = ?', topic, callback)
    return r && {
      topic: r.topic as string, callback: r.callback as string, host: r.host as string, ...r.secret != null && { secret: r.secret as string },
      expiresAt: r.expires_at as number, createdAt: r.created_at as number,
    }
  }

  wsPut(sub: Subscription) {
    this.sql.exec(`INSERT INTO websub_subscriptions (topic, callback, host, secret, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (topic, callback) DO UPDATE SET host = excluded.host, secret = excluded.secret, expires_at = excluded.expires_at`,
    sub.topic, sub.callback, sub.host, sub.secret ?? null, sub.expiresAt, sub.createdAt)
  }

  wsDelete(topic: string, callback: string) {
    this.sql.exec('DELETE FROM websub_subscriptions WHERE topic = ? AND callback = ?', topic, callback)
  }

  /** The subscriptions that haven't expired: all, of a feed, or of a feed and callback host. */
  wsCount(now: number, topic?: string, host?: string): number {
    return Number(this.one(`SELECT COUNT(*) AS n FROM websub_subscriptions WHERE expires_at > ?${topic == undefined ? '' : ' AND topic = ?'}${host == undefined ? '' : ' AND host = ?'}`,
      now, ...topic == undefined ? [] : [topic], ...host == undefined ? [] : [host])?.n ?? 0)
  }

  /** The callback hosts of the subscriptions that haven't expired, with their number. */
  wsHosts(now: number): { host: string; n: number }[] {
    return this.sql.exec('SELECT host, COUNT(*) AS n FROM websub_subscriptions WHERE expires_at > ? GROUP BY host', now).toArray()
      .map(r => ({ host: r.host as string, n: Number(r.n) }))
  }

  /** A feed changed: its subscribers are pinged by the alarm, WEBSUB_BATCH at a time. A feed that changes again starts over. */
  async wsChanged(topic: string, hub: string, now = Date.now()) {
    if (!this.wsCount(now, topic)) return
    this.sql.exec(`INSERT INTO websub_pending (topic, hub, changed_at, cursor) VALUES (?, ?, ?, '')
      ON CONFLICT (topic) DO UPDATE SET hub = excluded.hub, changed_at = excluded.changed_at, cursor = ''`, topic, hub, now)
    if (await this.ctx.storage.getAlarm() == null) await this.ctx.storage.setAlarm(Date.now())
  }

  /** The feeds whose subscribers wait for pings. */
  wsPending(): number {
    return Number(this.one('SELECT COUNT(*) AS n FROM websub_pending')?.n ?? 0)
  }

  /** Pings the next batch of subscribers of a changed feed, and sets the alarm again while there are more. */
  async alarm() {
    const now = Date.now()
    this.sql.exec('DELETE FROM websub_subscriptions WHERE expires_at <= ?', now)
    const job = this.one('SELECT topic, hub, changed_at, cursor FROM websub_pending ORDER BY changed_at LIMIT 1')
    if (!job) return
    const [topic, hub, changedAt] = [job.topic as string, job.hub as string, job.changed_at as number]
    const subs = this.sql.exec('SELECT callback, host, secret FROM websub_subscriptions WHERE topic = ? AND callback > ? ORDER BY callback LIMIT ?',
      topic, job.cursor, WEBSUB_BATCH).toArray().map(r => ({ topic, callback: r.callback as string, host: r.host as string, ...r.secret != null && { secret: r.secret as string } }))
    if (subs.length) {
      const results = await pingAll(hub, subs, fetch)
      results.forEach((r, i) => {
        if (r == 'gone') this.wsDelete(topic, subs[i]!.callback)
        if (r != 'sent') console.log(`websub.${r == 'gone' ? 'gone' : 'failed'}`, JSON.stringify({ topic, callbackHost: subs[i]!.host }))
      })
      this.sql.exec('UPDATE websub_pending SET cursor = ? WHERE topic = ? AND changed_at = ?', subs.at(-1)!.callback, topic, changedAt)
    } else {
      this.sql.exec('DELETE FROM websub_pending WHERE topic = ? AND changed_at = ?', topic, changedAt)
      console.log('websub.notified', JSON.stringify({ topic }))
    }
    if (this.one('SELECT topic FROM websub_pending LIMIT 1')) await this.ctx.storage.setAlarm(Date.now())
  }
}
