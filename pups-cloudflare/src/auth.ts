import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { b64url, fromB64url, hashToken, randomToken, verifyPassword } from './crypto'
import { type Env, type Settings, store } from './settings'
import type { Passkey } from './store'

/**
 * Owner authentication. In same-domain mode the server never sets a cookie: every owner
 * action carries a passkey assertion or the password. In auth subdomain mode an owner
 * session exists, but step-up actions still need a fresh credential.
 */

const CHALLENGE_TTL = 10 * 60_000
const SESSION_COOKIE = '__Host-pups_session'

/** Request options for a passkey assertion, or undefined if the owner has no passkey. */
export async function passkeyGetOptions(s: Settings, env: Env): Promise<object | undefined> {
  const owner = await store(env).owner()
  if (!owner?.passkeys.length) return
  const options = await generateAuthenticationOptions({
    rpID: s.rpId,
    userVerification: 'required',
    allowCredentials: owner.passkeys.map(p => ({ id: p.id, transports: p.transports as any })),
    timeout: 120_000,
  })
  await store(env).addChallenge(options.challenge, 'auth', CHALLENGE_TTL)
  return options
}

export async function passkeyCreateOptions(s: Settings, env: Env, existing: Passkey[] = []): Promise<object> {
  const options = await generateRegistrationOptions({
    rpName: `PUPS ${s.ownerHost}`,
    rpID: s.rpId,
    userName: s.ownerHost,
    userDisplayName: s.ownerHost,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    excludeCredentials: existing.map(p => ({ id: p.id, transports: p.transports })),
    timeout: 300_000,
  })
  await store(env).addChallenge(options.challenge, 'register', CHALLENGE_TTL)
  return options
}

const challengeOf = (response: any): string | undefined => {
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(response.response.clientDataJSON))).challenge
  } catch {
    return
  }
}

/** Verifies a passkey registration from the setup page. Returns the new passkey or an error. */
export async function verifyPasskeyRegistration(json: string, s: Settings, env: Env): Promise<Passkey | string> {
  let response: any
  try {
    response = JSON.parse(json)
  } catch {
    return 'Invalid passkey registration'
  }
  const challenge = challengeOf(response)
  if (!challenge || !await store(env).takeChallenge(challenge, 'register')) return 'The passkey registration expired; try again'
  try {
    const v = await verifyRegistrationResponse({
      response, expectedChallenge: challenge, expectedOrigin: s.issuer, expectedRPID: s.rpId, requireUserVerification: true,
    })
    if (!v.verified) return 'The passkey registration could not be verified'
    const c = v.registrationInfo.credential
    return { id: c.id, publicKey: b64url(c.publicKey), counter: c.counter, transports: c.transports ?? [] }
  } catch (e) {
    return `The passkey registration could not be verified: ${(e as Error).message}`
  }
}

/**
 * Verifies a fresh owner credential from a form: a passkey assertion (field `passkey`) or
 * the password (field `password`). Failed attempts are rate-limited. Returns null on
 * success, otherwise an error message.
 */
export async function verifyCredential(form: FormData, s: Settings, env: Env): Promise<string | null> {
  const db = store(env)
  const delay = await db.loginDelay()
  if (delay) return `Too many failed attempts. Try again in ${Math.ceil(delay / 60_000)} minute(s).`
  const owner = await db.owner()
  if (!owner) return 'No owner is set up'
  const passkey = form.get('passkey')
  const password = form.get('password')
  let ok = false
  if (typeof passkey == 'string' && passkey) {
    let response: any
    try {
      response = JSON.parse(passkey)
    } catch {
      return 'Invalid passkey response'
    }
    const challenge = challengeOf(response)
    const p = owner.passkeys.find(p => p.id == response.id)
    if (challenge && p && await db.takeChallenge(challenge, 'auth')) {
      try {
        const v = await verifyAuthenticationResponse({
          response, expectedChallenge: challenge, expectedOrigin: s.issuer, expectedRPID: s.rpId, requireUserVerification: true,
          credential: { id: p.id, publicKey: fromB64url(p.publicKey), counter: p.counter, transports: p.transports as any },
        })
        if (v.verified) {
          ok = true
          await db.updatePasskeyCounter(p.id, v.authenticationInfo.newCounter)
        }
      } catch {}
    }
  } else if (typeof password == 'string' && password) {
    ok = !!owner.passwordHash && await verifyPassword(password, owner.passwordHash)
  } else return 'Please confirm with your passkey or password.'
  if (!ok) {
    await db.loginFailed()
    return 'The confirmation failed.'
  }
  await db.loginSucceeded()
  return null
}

// --- Sessions (auth subdomain mode only) ----------------------------------------------

function cookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie') ?? ''
  if (header.length > 4096) return
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k == name) return v.join('=')
  }
}

/** The hashed owner session ID, if the request has a valid session. Never in same-domain mode. */
export async function session(req: Request, s: Settings, env: Env): Promise<string | null> {
  if (!s.subdomainMode) return null
  const id = cookie(req, SESSION_COOKIE)
  if (!id) return null
  const hash = await hashToken(id)
  return await store(env).sessionValid(hash) ? hash : null
}

/** Creates a session and returns its Set-Cookie header. */
export async function createSession(s: Settings, env: Env): Promise<string> {
  if (!s.subdomainMode) throw new Error('Sessions exist only in auth subdomain mode')
  const id = randomToken()
  await store(env).createSession(await hashToken(id))
  return `${SESSION_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`
}

export async function endSession(req: Request, env: Env): Promise<string> {
  const id = cookie(req, SESSION_COOKIE)
  if (id) await store(env).deleteSession(await hashToken(id))
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`
}
