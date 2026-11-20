import fs from 'fs';
import path from 'path';
import { hashToken, randomToken } from './crypto';

/**
 * All OAuth state of the installation, kept in memory and written to one JSON file after
 * every change. Every method is synchronous, and Node runs one at a time, so each call is
 * atomic: a code can be redeemed only once, a refresh token rotated only once.
 * Tokens and codes are stored only as SHA-256 hashes.
 */

export const CODE_TTL = 60_000;
export const ACCESS_TTL = 3600_000;
export const REFRESH_TTL = 180 * 24 * 3600_000;
/** How long a replaced refresh token can be retried while its successors are unused (RFC-6 "Grace period"). */
export const REFRESH_GRACE = 60_000;
/** Used codes are kept this long after they expire, so that reuse is still detected. */
const CODE_KEEP = 24 * 3600_000;

export interface Grant {
    id: string;
    clientId: string;
    clientHost: string;
    clientName?: string;
    /** The granted (not the requested) scope. */
    scope: string;
    /** Hash of the code the grant was issued from, to revoke it when the code is reused. */
    codeHash: string;
    createdAt: number;
    lastUsedAt?: number;
}

export interface CodeRecord {
    clientId: string;
    clientHost: string;
    clientName?: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    expiresAt: number;
    usedAt?: number;
}

interface AccessToken {
    grantId: string;
    expiresAt: number;
    /** Set on first use at the upload API, for the refresh grace period. */
    used?: boolean;
}

interface RefreshToken {
    grantId: string;
    expiresAt: number;
    replacedAt?: number;
    /** Hashes of the tokens issued when this one was replaced. */
    successor?: TokenHashes;
}

interface TokenHashes {
    access: string;
    refresh?: string;
}

interface StateData {
    /** HMAC key for signed form fields. */
    secret: string;
    grants: Record<string, Grant>;
    codes: Record<string, CodeRecord>;
    accessTokens: Record<string, AccessToken>;
    refreshTokens: Record<string, RefreshToken>;
    /** client_id → time of first approval, for the "new app" notice. */
    approvedClients: Record<string, number>;
    /** Single-use nonces of consent forms → expiry. */
    usedNonces: Record<string, number>;
}

export interface Tokens {
    access: string;
    refresh?: string;
}

export type RedeemResult = { ok: true; grant: Grant; tokens: Tokens } | { ok: false; description: string };
export type RefreshResult = { ok: true; grant: Grant; tokens: Tokens; graceRetry?: boolean } | { ok: false; reason: string; revoked?: Grant };

/** Identify-only grants get no refresh token: there is nothing to refresh for. */
export const wantsRefresh = (scope: string) => scope.split(' ').some(x => x != 'identify');

export class State {
    private file: string;
    private data: StateData;
    private now: () => number;

    constructor(file: string, now = () => Date.now()) {
        this.file = file;
        this.now = now;
        const empty: StateData = {
            secret: randomToken(), grants: {}, codes: {}, accessTokens: {}, refreshTokens: {}, approvedClients: {}, usedNonces: {},
        };
        this.data = fs.existsSync(file) ? { ...empty, ...JSON.parse(fs.readFileSync(file, 'utf8')) } : empty;
        this.save();
    }

    /** Removes expired records and writes the file atomically (temp file + rename). */
    private save() {
        const now = this.now();
        const prune = <T>(rec: Record<string, T>, expired: (v: T) => boolean) => {
            for (const [k, v] of Object.entries(rec))
                if (expired(v))
                    delete rec[k];
        };
        prune(this.data.codes, c => c.expiresAt + CODE_KEEP < now);
        prune(this.data.accessTokens, t => t.expiresAt < now || !this.data.grants[t.grantId]);
        prune(this.data.refreshTokens, t => t.expiresAt < now || !this.data.grants[t.grantId]);
        prune(this.data.usedNonces, exp => exp < now);
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${randomToken(6)}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }

    get secret() {
        return this.data.secret;
    }

    /** Marks a nonce as used. False if it was used before. */
    useNonce(nonce: string, expiresAt: number): boolean {
        if (this.data.usedNonces[nonce])
            return false;
        this.data.usedNonces[nonce] = expiresAt;
        this.save();
        return true;
    }

    clientApproved(clientId: string) {
        return !!this.data.approvedClients[clientId];
    }

    // --- Codes and grants ----------------------------------------------------------------

    /** Stores a new authorization code and returns it. */
    createCode(data: Omit<CodeRecord, 'expiresAt' | 'usedAt'>): string {
        const code = randomToken();
        const now = this.now();
        this.data.codes[hashToken(code)] = { ...data, expiresAt: now + CODE_TTL };
        this.data.approvedClients[data.clientId] ??= now;
        this.save();
        return code;
    }

    private issueTokens(grantId: string, withRefresh: boolean): { tokens: Tokens; hashes: TokenHashes } {
        const now = this.now();
        const access = randomToken(), refresh = withRefresh ? randomToken() : undefined;
        const hashes = { access: hashToken(access), refresh: refresh && hashToken(refresh) };
        this.data.accessTokens[hashes.access] = { grantId, expiresAt: now + ACCESS_TTL };
        if (hashes.refresh)
            this.data.refreshTokens[hashes.refresh] = { grantId, expiresAt: now + REFRESH_TTL };
        return { tokens: { access, refresh }, hashes };
    }

    /**
     * Redeems a code. A code is single-use: any second attempt fails and revokes the grant
     * (and so every token) issued from it.
     */
    redeemCode(code: string, clientId: string, redirectUri: string, challenge: string): RedeemResult {
        const now = this.now();
        const codeHash = hashToken(code);
        const c = this.data.codes[codeHash];
        const fail = (description: string): RedeemResult => (this.save(), { ok: false, description });
        if (!c)
            return fail('Unknown authorization code');
        if (c.usedAt) {
            const g = Object.values(this.data.grants).find(g => g.codeHash == codeHash);
            if (g)
                this.revokeGrantRecords(g.id);
            return fail('The authorization code was already used; tokens issued from it are revoked');
        }
        c.usedAt = now;
        if (c.expiresAt < now)
            return fail('The authorization code has expired');
        if (c.clientId != clientId)
            return fail('client_id does not match the authorization request');
        if (c.redirectUri != redirectUri)
            return fail('redirect_uri does not match the authorization request');
        if (c.codeChallenge != challenge)
            return fail('PKCE verification failed');
        const grant: Grant = {
            id: randomToken(16), clientId, clientHost: c.clientHost, clientName: c.clientName, scope: c.scope, codeHash, createdAt: now,
        };
        this.data.grants[grant.id] = grant;
        const { tokens } = this.issueTokens(grant.id, wantsRefresh(c.scope));
        this.save();
        return { ok: true, grant, tokens };
    }

    /** Has anything issued by a refresh been used: the new refresh token or the new access token? */
    private successorUsed(s: TokenHashes | undefined) {
        const access = s && this.data.accessTokens[s.access];
        const refresh = s?.refresh && this.data.refreshTokens[s.refresh];
        return !access || !refresh || !!access.used || !!refresh.replacedAt;
    }

    /**
     * Rotates a refresh token (RFC-6 "Refresh"). Reusing a token that was already replaced
     * revokes the whole grant, because it means the token was copied, except during the
     * grace period while nothing issued by the replacement has been used: then the unused
     * successors are revoked and a fresh pair is issued.
     */
    refresh(refreshToken: string, clientId: string): RefreshResult {
        const now = this.now();
        const r = this.data.refreshTokens[hashToken(refreshToken)];
        const grant = r && this.data.grants[r.grantId];
        if (!r || !grant)
            return { ok: false, reason: 'unknown or revoked refresh token' };
        if (grant.clientId != clientId)
            return { ok: false, reason: `refresh token belongs to ${grant.clientId}` };
        if (r.expiresAt < now)
            return { ok: false, reason: 'refresh token expired' };
        const graceRetry = !!r.replacedAt;
        if (r.replacedAt) {
            const late = now - r.replacedAt > REFRESH_GRACE;
            if (late || this.successorUsed(r.successor)) {
                this.revokeGrantRecords(grant.id);
                this.save();
                return {
                    ok: false, revoked: grant, reason: `replaced refresh token reused ${late
                        ? `${Math.round((now - r.replacedAt) / 1000)} s after its replacement (grace period ${REFRESH_GRACE / 1000} s)`
                        : 'after its successor was used'}`,
                };
            }
            delete this.data.accessTokens[r.successor!.access];
            delete this.data.refreshTokens[r.successor!.refresh!];
        } else
            r.replacedAt = now;
        const { tokens, hashes } = this.issueTokens(grant.id, true);
        r.successor = hashes;
        this.save();
        return { ok: true, grant, tokens, graceRetry };
    }

    /**
     * RFC 7009 revocation. An access token is revoked alone; a refresh token revokes its
     * grant, which is returned so the caller can clean up.
     */
    revokeToken(token: string, clientId: string): Grant | undefined {
        const hash = hashToken(token);
        const a = this.data.accessTokens[hash];
        if (a) {
            if (this.data.grants[a.grantId]?.clientId == clientId) {
                delete this.data.accessTokens[hash];
                this.save();
            }
            return;
        }
        const r = this.data.refreshTokens[hash];
        const g = r && this.data.grants[r.grantId];
        if (g?.clientId == clientId)
            return this.revokeGrant(g.id);
    }

    private revokeGrantRecords(grantId: string) {
        delete this.data.grants[grantId];
        // The grant's tokens are removed by save().
    }

    /** Revokes a grant and all its tokens. Returns the revoked grant. */
    revokeGrant(grantId: string): Grant | undefined {
        const g = this.data.grants[grantId];
        if (g) {
            this.revokeGrantRecords(grantId);
            this.save();
        }
        return g;
    }

    clientHasGrant(clientId: string) {
        return Object.values(this.data.grants).some(g => g.clientId == clientId);
    }

    activeGrants(): Grant[] {
        return Object.values(this.data.grants).sort((a, b) => b.createdAt - a.createdAt);
    }

    /** Looks up an access token at the upload API and marks it as used. */
    authenticate(accessToken: string): Grant | undefined {
        const now = this.now();
        const t = this.data.accessTokens[hashToken(accessToken)];
        const grant = t && t.expiresAt > now ? this.data.grants[t.grantId] : undefined;
        if (!grant)
            return;
        // The first use must be on disk at once: the refresh grace period depends on it. lastUsedAt is only
        // shown to the owner, so frequent requests (fresh reads) write the file at most once a minute.
        const save = !t.used || now - (grant.lastUsedAt ?? 0) > 60_000;
        t.used = true;
        grant.lastUsedAt = now;
        if (save)
            this.save();
        return grant;
    }
}
