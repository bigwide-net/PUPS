import express from 'express';
import * as ui from 'pups-ui';
import { Client, ClientError, redirectUriAllowed } from '../lib/cimd';
import { Ctx } from '../lib/context';
import { randomToken, s256, sign, verify } from '../lib/crypto';
import { htmlErrors, PASSWORD_ONLY, send, sendErrorPage } from '../lib/html';
import { field, fields, HttpError, LIMITS, query } from '../lib/http';
import { parseScope, parseScopes, Scope } from '../lib/paths';
import { fp, log } from '../lib/log';
import { ACCESS_TTL, Tokens } from '../lib/state';
import { onGrantRevoked } from './hostmeta';

/** A validated authorization request, carried through the consent form as a signed field. */
interface AuthRequest {
    clientId: string;
    clientHost: string;
    clientName?: string;
    logo?: string;
    redirectUri: string;
    state?: string;
    codeChallenge: string;
    scope: string;
    /** Makes the request single-use. */
    nonce: string;
    exp: number;
}

const REQUEST_TTL = 15 * 60_000;

function redirectTo(res: express.Response, redirectUri: string, params: Record<string, string | undefined>, status = 302) {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params))
        if (v != undefined)
            u.searchParams.set(k, v);
    res.status(status).set({ Location: u.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end();
}

/** A grant's permissions on the apps page, grouped as on the consent screen. */
export const permissionList = (scope: string, clientHost: string, config: Ctx['config']) =>
    ui.permissionList(scope.split(' ').map((str): [string, Scope | undefined] => [str, parseScope(str, clientHost, config)]), config.host);

/** The consent screen (RFC-6 "Consent"). In same-domain mode every approval needs the password. */
function consentPage(res: express.Response, ar: AuthRequest, scopes: Map<string, Scope>, ctx: Ctx, error?: string, status = 200) {
    const { config, state } = ctx;
    return send(res, ui.consentPage({
        clientHost: ar.clientHost, clientName: ar.clientName, logo: ar.logo, redirectUri: ar.redirectUri, ownerHost: config.host,
        scopes, approvedBefore: state.clientApproved(ar.clientId), request: sign(ar, state.secret), confirm: PASSWORD_ONLY, error, status,
    }));
}

/** GET /oauth/authorize: validates the request and shows the consent screen. */
async function authorize(req: express.Request, res: express.Response, ctx: Ctx) {
    const { config } = ctx;
    const q = (name: string) => query(req, name);
    const clientId = query(req, 'client_id', LIMITS.url), redirectUri = query(req, 'redirect_uri', LIMITS.url), state = query(req, 'state', LIMITS.state);
    const scope = query(req, 'scope', LIMITS.scope);
    // Invalid clients and redirect URIs get an error page, never a redirect (no open redirector).
    if (!clientId)
        return sendErrorPage(res, 'Invalid request', 'client_id is missing.');
    let client: Client;
    try {
        client = await ctx.clients.load(clientId);
    } catch (e) {
        if (e instanceof ClientError)
            return sendErrorPage(res, 'Invalid app', e.message);
        throw e;
    }
    if (!redirectUri || !redirectUriAllowed(client, redirectUri))
        return sendErrorPage(res, 'Invalid redirect URI', "redirect_uri is not listed in the app's client metadata document.");

    const fail = (error: string, description: string) => {
        log('authorize.rejected', { clientId, error, description });
        redirectTo(res, redirectUri, { error, error_description: description, state, iss: config.issuer });
    };
    if (q('response_type') != 'code')
        return fail('unsupported_response_type', 'response_type must be code');
    const codeChallenge = q('code_challenge');
    if (!codeChallenge || q('code_challenge_method') != 'S256')
        return fail('invalid_request', 'PKCE with S256 is required');
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge))
        return fail('invalid_request', 'Invalid code_challenge');
    const scopes = parseScopes(scope ?? '', client.clientHost, config);
    if (!scopes)
        return fail('invalid_scope', "Only identify, the app's own directory, declared well-known paths and read scopes for declared private paths can be requested");

    log('authorize.request', { clientId, clientHost: client.clientHost, clientName: client.name, redirectUri, scope, state });
    consentPage(res, {
        clientId, clientHost: client.clientHost, clientName: client.name, logo: client.logo, redirectUri, state, codeChallenge,
        scope: [...scopes.keys()].join(' '), nonce: randomToken(16), exp: Date.now() + REQUEST_TTL,
    }, scopes, ctx);
}

/** POST /oauth/authorize: the owner's decision. */
function decide(req: express.Request, res: express.Response, ctx: Ctx) {
    const { config, state } = ctx;
    const ar = verify<AuthRequest>(field(req.body, 'request', LIMITS.signedRequest), state.secret);
    if (!ar)
        return sendErrorPage(res, 'Request expired', 'This authorization request is invalid or has expired. Please start again from the app.');
    const deny = () => {
        log('authorize.denied', { clientId: ar.clientId, requested: ar.scope });
        redirectTo(res, ar.redirectUri, { error: 'access_denied', state: ar.state, iss: config.issuer }, 303);
    };
    if (field(req.body, 'decision') != 'approve')
        return deny();
    const scopes = parseScopes(ar.scope, ar.clientHost, config)!;
    // A group's checkbox carries all of its scopes, separated by spaces.
    const chosen = new Set(fields(req.body, 'scope', LIMITS.scope).flatMap(v => v.split(' ')));
    const granted = [...scopes.keys()].filter(k => chosen.has(k));
    // Dropping every scope counts as denial.
    if (!granted.length)
        return deny();
    const err = ctx.owner.check(field(req.body, 'password', LIMITS.password), 'approve app', { clientId: ar.clientId });
    if (err)
        return consentPage(res, ar, scopes, ctx, err, 401);
    if (!state.useNonce(ar.nonce, ar.exp))
        return sendErrorPage(res, 'Already answered', 'This authorization request was already approved.');
    const code = state.createCode({
        clientId: ar.clientId, clientHost: ar.clientHost, clientName: ar.clientName, redirectUri: ar.redirectUri,
        codeChallenge: ar.codeChallenge, scope: granted.join(' '),
    });
    log('authorize.approved', { clientId: ar.clientId, requested: ar.scope, granted: granted.join(' '), code: fp(code), redirectUri: ar.redirectUri });
    redirectTo(res, ar.redirectUri, { code, state: ar.state, iss: config.issuer }, 303);
}

const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

const oauthError = (res: express.Response, error: string, description: string, status = 400) =>
    res.status(status).set(noStore).json({ error, error_description: description });

function requireForm(req: express.Request) {
    if (!req.is('application/x-www-form-urlencoded'))
        throw new HttpError(400, 'invalid_request', 'The body must be application/x-www-form-urlencoded');
}

/** POST /oauth/token: code exchange and refresh (RFC-6 "Tokens"). */
function token(req: express.Request, res: express.Response, ctx: Ctx) {
    requireForm(req);
    const { config, state } = ctx;
    const f = (name: string, max: number = LIMITS.short) => field(req.body, name, max);
    const clientId = f('client_id', LIMITS.url);
    if (!clientId)
        return oauthError(res, 'invalid_request', 'client_id is required');
    const send = (t: Tokens, scope: string) => res.set(noStore).json({
        access_token: t.access,
        token_type: 'Bearer',
        expires_in: ACCESS_TTL / 1000,
        ...t.refresh && { refresh_token: t.refresh },
        scope,
        me: config.me,
    });

    switch (f('grant_type')) {
        case 'authorization_code': {
            const code = f('code', LIMITS.token), redirectUri = f('redirect_uri', LIMITS.url), verifier = f('code_verifier', 128);
            if (!code || !redirectUri || !verifier)
                return oauthError(res, 'invalid_request', 'code, redirect_uri and code_verifier are required');
            if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier))
                return oauthError(res, 'invalid_grant', 'Invalid code_verifier');
            const r = state.redeemCode(code, clientId, redirectUri, s256(verifier));
            if (!r.ok) {
                log('token.code-rejected', { clientId, code: fp(code), reason: r.description });
                return oauthError(res, 'invalid_grant', r.description);
            }
            log('token.issued', { clientId, grant: r.grant.id, scope: r.grant.scope, code: fp(code), access: fp(r.tokens.access), refresh: fp(r.tokens.refresh) });
            return send(r.tokens, r.grant.scope);
        }
        case 'refresh_token': {
            const refresh = f('refresh_token', LIMITS.token);
            if (!refresh)
                return oauthError(res, 'invalid_request', 'refresh_token is required');
            const requested = f('scope', LIMITS.scope);
            const r = state.refresh(refresh, clientId);
            if (!r.ok) {
                log(r.revoked ? 'token.refresh-reuse-grant-revoked' : 'token.refresh-rejected', { clientId, refresh: fp(refresh), grant: r.revoked?.id, reason: r.reason });
                if (r.revoked)
                    onGrantRevoked(r.revoked.clientId, ctx);
                return oauthError(res, 'invalid_grant', r.revoked
                    ? 'The refresh token was already used; the grant is revoked'
                    : 'Invalid, expired or revoked refresh token');
            }
            if (requested && requested.split(' ').some(x => !r.grant.scope.split(' ').includes(x)))
                return oauthError(res, 'invalid_scope', "The scope can't grow through a refresh");
            log(r.graceRetry ? 'token.refreshed-grace-retry' : 'token.refreshed', {
                clientId, grant: r.grant.id, old: fp(refresh), access: fp(r.tokens.access), refresh: fp(r.tokens.refresh),
            });
            return send(r.tokens, r.grant.scope);
        }
        default:
            return oauthError(res, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    }
}

/** POST /oauth/revoke (RFC 7009). */
function revoke(req: express.Request, res: express.Response, ctx: Ctx) {
    requireForm(req);
    const t = field(req.body, 'token', LIMITS.token), clientId = field(req.body, 'client_id', LIMITS.url);
    if (!t || !clientId)
        return oauthError(res, 'invalid_request', 'token and client_id are required');
    const revoked = ctx.state.revokeToken(t, clientId);
    log('token.revoke', { clientId, token: fp(t), grantRevoked: revoked?.id ?? false });
    if (revoked)
        onGrantRevoked(revoked.clientId, ctx);
    // Unknown tokens get 200 too.
    res.status(200).set(noStore).end();
}

export function oauthRoutes(ctx: Ctx): express.Router {
    const router = express.Router();
    const form = express.urlencoded({ extended: false, limit: '64kb' });
    // The authorization endpoint answers with HTML error pages, also for oversized values.
    router.get('/oauth/authorize', htmlErrors((req, res) => authorize(req, res, ctx)));
    router.post('/oauth/authorize', form, htmlErrors((req, res) => decide(req, res, ctx)));
    router.post('/oauth/token', form, (req, res) => token(req, res, ctx));
    router.post('/oauth/revoke', form, (req, res) => revoke(req, res, ctx));
    return router;
}
