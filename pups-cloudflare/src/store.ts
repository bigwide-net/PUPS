import { DurableObject } from 'cloudflare:workers'
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
    `)
    // Refresh state per grant: the current refresh token, the one it replaced and when, the
    // access token issued with the current one, and whether anything issued by that refresh
    // has been used. Added as columns so that existing databases are migrated.
    const columns = new Set(this.sql.exec('PRAGMA table_info(grants)').toArray().map(r => r.name))
    for (const [name, type] of [['current_refresh', 'TEXT'], ['prev_refresh', 'TEXT'], ['replaced_at', 'INTEGER'],
      ['successor_access', 'TEXT'], ['successor_used', 'INTEGER NOT NULL DEFAULT 0']])
      if (!columns.has(name)) this.sql.exec(`ALTER TABLE grants ADD COLUMN ${name} ${type}`)
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
  }

  // --- Server secret ---------------------------------------------------------------

  /** The HMAC key for signed form fields. Generated on first use. */
  secret(): string {
    let s = this.kvGet('signing_key')
    if (!s) this.kvSet('signing_key', s = randomToken(32))
    return s
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
}
