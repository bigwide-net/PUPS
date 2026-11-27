import * as ui from 'pups-ui'
import { inboxSummary, moderationView, saveModeration } from 'pups-inbox'
import { errorPage, hasUnsafeChars, type HomepageKind, type HomepageState, isTheme, MIN_PASSWORD_LENGTH, ownerNav, setupCompletePage } from 'pups-ui'
import {
  createSession, endSession, pageSession, passkeyCreateOptions, passkeyGetOptions, session, verifyCredential, verifyPasskeyRegistration,
  withPageSession,
} from './auth'
import { hashPassword, hashToken, randomToken, sign, timingSafeEqual, verify } from './crypto'
import { modifyHostMeta, onGrantRevoked, readHostMeta, setPostUrlTemplate } from './hostmeta'
import { readForm } from './http'
import { permissionList, signingKey } from './oauth'
import { receiver } from './receiver'
import { saveWebsub, websubView } from './websub'
import { webSubSettingsFromForm } from 'pups-feeds'
import { appdataPrefix } from './paths'
import { type Env, type Settings, store } from './settings'
import type { Passkey } from './store'

/**
 * Owner pages: first-run setup, login (auth subdomain mode only), the apps page, the comments page and the
 * password page.
 *
 * A session is enough for viewing a page: the cookie in auth subdomain mode, the page session of owner.js in same-domain
 * mode (RFC-6 "Deployment modes"). Without one, in same-domain mode, viewing needs a fresh passkey assertion or the
 * password. Every change needs a fresh confirmation in both modes.
 */

const notFound = () => errorPage('Not found', 'This page does not exist.', 404)
const seeOther = (location: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', ...headers } })

/** How the owner confirms on this installation: passkey, password, or both. */
async function confirmOptions(s: Settings, env: Env) {
  const owner = await store(env).owner()
  return { passkeyOptions: await passkeyGetOptions(s, env), hasPassword: !!owner?.passwordHash }
}

// --- Setup -----------------------------------------------------------------------------

interface SetupToken {
  t: 'setup' | 'recover'
  nonce: string
  exp: number
}

/**
 * /pups/setup, before the owner exists, with BOOTSTRAP_SECRET. With `recover`, /pups/recover, while the secret
 * RECOVERY_SECRET is set: the passkey or password chosen there replaces all the owner's passkeys and their password, for
 * an owner who lost their passkey (RFC-6 "Owner authentication"). Only who controls the server's secrets can set it, and
 * each value works once.
 */
export async function setup(req: Request, s: Settings, env: Env, recover = false): Promise<Response> {
  const db = store(env)
  const secret = recover ? env.RECOVERY_SECRET : env.BOOTSTRAP_SECRET
  if (recover) {
    if (!secret || secret.length < 16) return notFound()
    if (!await db.ownerExists()) return seeOther('/pups/setup')
  } else {
    // After setup the page is unreachable.
    if (await db.ownerExists()) return notFound()
    if (!secret || secret.length < 16)
      return errorPage('Setup not possible', 'Set the BOOTSTRAP_SECRET secret (at least 16 characters) first, e.g. with `wrangler secret put BOOTSTRAP_SECRET`.', 503)
  }
  const secretForm = (error?: string) => ui.secretForm(s, error, recover)
  if (req.method == 'GET') return secretForm()
  if (req.method != 'POST') return errorPage('Method not allowed', 'Use GET or POST.', 405)

  const form = await readForm(req)
  if (form.get('step') == 'secret') {
    const delay = await db.loginDelay()
    if (delay) return secretForm(`Too many failed attempts. Try again in ${Math.ceil(delay / 60_000)} minute(s).`)
    if (!timingSafeEqual(String(form.get('secret') ?? ''), secret)) {
      await db.loginFailed()
      return secretForm(recover ? 'Wrong recovery secret.' : 'Wrong bootstrap secret.')
    }
    if (recover && await db.setting('recoveredWith') == await hashToken(secret))
      return secretForm('This recovery secret was used already. Set a new one to recover again.')
    await db.loginSucceeded()
    return credentialForm(await sign({ t: recover ? 'recover' : 'setup', nonce: randomToken(16), exp: Date.now() + 30 * 60_000 }, await db.secret()), s, env)
  }

  const token = form.get('setup') as string | null
  const st = await verify<SetupToken>(token, await db.secret())
  if (!st || st.t != (recover ? 'recover' : 'setup'))
    return secretForm(`The ${recover ? 'recovery' : 'setup'} session has expired. Enter the ${recover ? 'recovery' : 'bootstrap'} secret again.`)
  const registration = form.get('passkey_registration')
  const password = String(form.get('new_password') ?? '')
  let passkey: Passkey | null = null
  if (typeof registration == 'string' && registration) {
    const r = await verifyPasskeyRegistration(registration, s, env)
    if (typeof r == 'string') return credentialForm(token!, s, env, r)
    passkey = r
  }
  const pwError = password && checkNewPassword(password, form.get('new_password2'))
  if (pwError) return credentialForm(token!, s, env, pwError)
  if (!passkey && !password) return credentialForm(token!, s, env, 'Register a passkey or choose a password.')
  if (!await db.useNonce(st.nonce, 30 * 60_000)) return notFound()
  if (recover) {
    await db.replaceCredentials(password ? await hashPassword(password) : null, passkey)
    await db.deleteAllSessions()
    await db.setSetting('recoveredWith', await hashToken(secret))
    return ui.recoveredPage(s, s.issuer)
  }
  if (!await db.createOwner(password ? await hashPassword(password) : null, passkey)) return notFound()
  // The key that signs identity tokens (RFC-10) is made during setup, before any app can ask for one.
  await signingKey(env)
  return setupCompletePage(s, { configUrl: s.configUrl, issuer: s.issuer, hasPasskey: !!passkey, homepage: await homepageKind(s, env) })
}

function checkNewPassword(password: string, repeat: unknown): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `The password must have at least ${MIN_PASSWORD_LENGTH} characters.`
  if (password != repeat) return 'The passwords do not match.'
}

async function credentialForm(token: string, s: Settings, env: Env, error?: string) {
  return ui.credentialForm(s, token, await passkeyCreateOptions(s, env), error)
}

// --- Login (auth subdomain mode only) --------------------------------------------------------

const RETURN_PATHS = ['/pups/apps', '/pups/homepage', '/pups/feed-settings', '/pups/comment-settings', '/pups/password']
const safeReturn = (r: unknown) =>
  typeof r == 'string' && r.length <= 2048 && (r.startsWith('/oauth/authorize?') || RETURN_PATHS.includes(r)) &&
    !r.includes('\\') && !/\s/.test(r) && !hasUnsafeChars(r) ? r : '/pups/apps'

export const loginPage = async (s: Settings, env: Env, returnTo: string, error?: string) =>
  ui.loginPage(s, returnTo, await confirmOptions(s, env), error)

export async function login(req: Request, s: Settings, env: Env): Promise<Response> {
  if (!s.subdomainMode) return notFound()
  if (!await store(env).ownerExists()) return seeOther('/pups/setup')
  if (req.method == 'GET') return loginPage(s, env, safeReturn(new URL(req.url).searchParams.get('return_to')))
  const form = await readForm(req)
  const returnTo = safeReturn(form.get('return_to'))
  const err = await verifyCredential(form, s, env)
  if (err) return loginPage(s, env, returnTo, err)
  return seeOther(returnTo, { 'set-cookie': await createSession(s, env) })
}

export async function logout(req: Request, s: Settings, env: Env): Promise<Response> {
  if (!s.subdomainMode || req.method != 'POST') return notFound()
  return seeOther('/pups/login', { 'set-cookie': await endSession(req, env) })
}

/** Common checks of the management pages. Returns a response if the request can't go on. */
async function guard(req: Request, s: Settings, env: Env, path: string): Promise<Response | undefined> {
  if (!await store(env).ownerExists()) return seeOther('/pups/setup')
  if (s.subdomainMode && !await session(req, s, env)) return seeOther(`/pups/login?return_to=${encodeURIComponent(path)}`)
  if (req.method != 'GET' && req.method != 'POST') return errorPage('Method not allowed', 'Use GET or POST.', 405)
}

/**
 * The owner's session on a management page (guard checks the cookie in subdomain mode). `confirm` checks a fresh
 * confirmation, which also starts a new page session; `reply` adds the renewed page session to the answer.
 */
async function ownerSession(req: Request, s: Settings, env: Env) {
  let start = await pageSession(req, s, env)
  return {
    active: s.subdomainMode || start != null,
    async confirm(form: FormData) {
      const err = await verifyCredential(form, s, env)
      if (!err) start = Date.now()
      return err
    },
    reply: async (res: Response | Promise<Response>) => withPageSession(req, await res, s, env, start),
  }
}

/** Whether a form makes a change, or only shows the page again. */
const changes = (form: FormData, fields: string[]) => fields.some(f => form.has(f))

// --- Apps ------------------------------------------------------------------------------

export async function apps(req: Request, s: Settings, env: Env): Promise<Response> {
  const stop = await guard(req, s, env, '/pups/apps')
  if (stop) return stop
  const session = await ownerSession(req, s, env)
  if (req.method == 'GET') return session.reply(session.active ? appsPage(s, env) : unlockPage(s, env))

  const form = await readForm(req)
  if (session.active && !changes(form, ['revoke', 'revoke_delete', 'remove_link', 'remove_property', 'signout_all', 'replace_signing_key']))
    return session.reply(appsPage(s, env))
  const err = await session.confirm(form)
  if (err) return session.reply(session.active ? appsPage(s, env, { error: err }) : unlockPage(s, env, err))

  const db = store(env)
  const revoke = form.get('revoke') ?? form.get('revoke_delete')
  let message: string | undefined
  if (typeof revoke == 'string') {
    const grant = (await db.activeGrants()).find(g => g.id == revoke)
    if (!grant) message = 'The app had already been removed.'
    else {
      await db.revokeGrant(grant.id)
      await onGrantRevoked(grant.clientId, s, env)
      message = `${grant.clientHost} can no longer write to your domain.`
      if (form.has('revoke_delete')) message += ` Deleted ${await deleteAppFiles(grant.clientHost, env)} of its files.`
    }
  } else if (form.has('remove_link')) {
    let link: unknown
    try {
      link = JSON.parse(String(form.get('remove_link')))
    } catch {}
    if (!Array.isArray(link) || link.length != 2 || link.some(x => typeof x != 'string'))
      return session.reply(appsPage(s, env, { error: 'Invalid link.' }))
    const [rel, href] = link as [string, string]
    await modifyHostMeta(s, env, doc => {
      const before = doc.links?.length ?? 0
      doc.links = doc.links?.filter(l => !(l.rel == rel && (l.href ?? '') == href))
      return (doc.links?.length ?? 0) != before
    }, false)
    message = 'The link was removed.'
  } else if (form.has('remove_property')) {
    const prop = String(form.get('remove_property'))
    await modifyHostMeta(s, env, doc => {
      if (!doc.properties || !(prop in doc.properties)) return false
      delete doc.properties[prop]
      return true
    }, false)
    message = 'The property was removed.'
  } else if (form.has('replace_signing_key')) {
    message = `The signing key was replaced; the new one is ${(await signingKey(env, true)).kid}.`
  } else if (form.has('signout_all') && s.subdomainMode) {
    await db.deleteAllSessions()
    return seeOther('/pups/login', { 'set-cookie': await endSession(req, env) })
  }
  return session.reply(appsPage(s, env, { message }))
}

async function deleteAppFiles(clientHost: string, env: Env): Promise<number> {
  const prefix = appdataPrefix(clientHost).slice(1)
  let cursor: string | undefined
  let n = 0, bytes = 0
  do {
    const list = await env.FILES.list({ prefix, cursor })
    if (list.objects.length) await env.FILES.delete(list.objects.map(o => o.key))
    n += list.objects.length
    bytes += list.objects.reduce((sum, o) => sum + o.size, 0)
    cursor = list.truncated ? list.cursor : undefined
  } while (cursor)
  await store(env).reserveStorage(-bytes, 0)
  return n
}

const unlockPage = async (s: Settings, env: Env, error?: string) => ui.unlockPage(s, await confirmOptions(s, env), error)


async function appsPage(s: Settings, env: Env, o: { message?: string; error?: string } = {}) {
  const db = store(env)
  const [grants, used, hostMeta, confirm, inbox, key] = await Promise.all([db.activeGrants(), db.storageUsed(), readHostMeta(s, env), confirmOptions(s, env),
    receiver(s, env).then(inboxSummary), signingKey(env)])
  return ui.appsPage(s, {
    apps: await Promise.all(grants.map(async g => ({
      ...g, permissions: permissionList(g.scope, g.clientHost, s),
      hasFiles: g.scope.split(' ').includes(`write:${appdataPrefix(g.clientHost)}`),
      identityUses: await db.identityUses(g.id),
    }))),
    signingKey: { kid: key.kid, createdAt: key.createdAt },
    links: (hostMeta.doc.links ?? []).map(l => ({ rel: String(l.rel), href: String(l.href ?? '') })),
    properties: Object.entries(hostMeta.doc.properties ?? {}).map(([k, v]) => [k, String(v)]),
    hostMetaError: hostMeta.error, hostMetaStored: hostMeta.stored, usedBytes: used, maxBytes: s.maxStorageBytes,
    confirm, inbox, ...o,
  })
}

// --- Comments ----------------------------------------------------------------------------

/** /pups/comment-settings, with comments on: the comments in the inbox, and auto-moderation. */
export async function commentSettings(req: Request, s: Settings, env: Env): Promise<Response> {
  const stop = await guard(req, s, env, '/pups/comment-settings')
  if (stop) return stop
  const r = await receiver(s, env)
  const page = async (o: { message?: string; error?: string; form?: FormData } = {}) => ui.commentsPage(s, {
    inbox: (await inboxSummary(r))!, moderation: await moderationView(r.moderation!, r.now(), o.form), confirm: await confirmOptions(s, env), ...o,
  })
  const session = await ownerSession(req, s, env)
  if (req.method == 'GET') return session.reply(session.active ? page() : ui.commentsUnlockPage(s, await confirmOptions(s, env)))
  const form = await readForm(req)
  if (session.active && !changes(form, ['save_moderation'])) return session.reply(page())
  const err = await session.confirm(form)
  if (err) return session.reply(session.active ? page({ error: err }) : ui.commentsUnlockPage(s, await confirmOptions(s, env), err))
  if (!form.has('save_moderation')) return session.reply(page())
  const saved = await saveModeration(r.moderation!, form, s.allowHttp)
  return session.reply(page('error' in saved ? { error: saved.error, form } : { message: saved.message }))
}

// --- Feeds ---------------------------------------------------------------------------

/** /pups/feed-settings: the WebSub hub. */
export async function feedSettings(req: Request, s: Settings, env: Env): Promise<Response> {
  const stop = await guard(req, s, env, '/pups/feed-settings')
  if (stop) return stop
  const page = async (o: { message?: string; error?: string; form?: FormData } = {}) =>
    ui.feedsPage(s, { websub: await websubView(env, o.form), confirm: await confirmOptions(s, env), ...o })
  const session = await ownerSession(req, s, env)
  if (req.method == 'GET') return session.reply(session.active ? page() : ui.feedsUnlockPage(s, await confirmOptions(s, env)))
  const form = await readForm(req)
  if (session.active && !changes(form, ['save_websub'])) return session.reply(page())
  const err = await session.confirm(form)
  if (err) return session.reply(session.active ? page({ error: err }) : ui.feedsUnlockPage(s, await confirmOptions(s, env), err))
  if (!form.has('save_websub')) return session.reply(page())
  const settings = webSubSettingsFromForm(name => form.get(name)?.toString())
  if (typeof settings == 'string') return session.reply(page({ error: settings, form }))
  await saveWebsub(settings, s, env)
  return session.reply(page({ message: settings.enabled ? 'Saved. Subscribed feed readers learn about new posts right away.' : 'Saved. WebSub is off: feed readers check your feeds as usual.' }))
}

// --- Password --------------------------------------------------------------------------

export async function password(req: Request, s: Settings, env: Env): Promise<Response> {
  const stop = await guard(req, s, env, '/pups/password')
  if (stop) return stop
  const session = await ownerSession(req, s, env)
  if (req.method == 'GET') return session.reply(passwordPage(s, env))

  const form = await readForm(req)
  const newPassword = String(form.get('new_password') ?? '')
  const invalid = checkNewPassword(newPassword, form.get('new_password2'))
  if (invalid) return session.reply(passwordPage(s, env, { error: invalid }))
  const err = await session.confirm(form)
  if (err) return session.reply(passwordPage(s, env, { error: err }))

  const db = store(env)
  await db.setPassword(await hashPassword(newPassword))
  // A new password ends the page sessions of other pages too (auth.ts): this page gets a new one.
  if (!s.subdomainMode) return session.reply(passwordPage(s, env, { message: 'Your password was changed. Other pages need a new confirmation.' }))
  // Changing the password ends every other session.
  await db.deleteAllSessions()
  const res = await passwordPage(s, env, { message: 'Your password was changed. All other sessions were logged out.' })
  res.headers.set('set-cookie', await createSession(s, env))
  return res
}

async function passwordPage(s: Settings, env: Env, o: { message?: string; error?: string } = {}) {
  const owner = await store(env).owner()
  return ui.passwordPage(s, { hasPassword: !!owner?.passwordHash, passkeyOptions: await passkeyGetOptions(s, env), ...o })
}

// --- Start page and homepage -------------------------------------------------------------

/** Who owns the domain's homepage: an existing website behind this server, webpup, or nobody. */
export async function homepageKind(s: Settings, env: Env): Promise<HomepageKind> {
  return s.originFallback ? 'website' : await homepageState(env) ? 'webpup' : 'none'
}

export const homepageState = async (env: Env) => await store(env).setting('homepage') as HomepageState | undefined

/** /pups/: the start page of the owner pages. */
export async function start(req: Request, s: Settings, env: Env): Promise<Response> {
  if (req.method != 'GET' && req.method != 'HEAD') return errorPage('Method not allowed', 'Use GET.', 405)
  return ui.startPage(s, { hasOwner: await store(env).ownerExists(), homepage: await homepageKind(s, env), configUrl: s.configUrl, nav: ownerNav(s, '') })
}

/** /pups/homepage: install webpup as the homepage, choose its theme, or remove it. */
export async function homepage(req: Request, s: Settings, env: Env): Promise<Response> {
  const stop = await guard(req, s, env, '/pups/homepage')
  if (stop) return stop
  const nav = ownerNav(s, '/pups/homepage')
  const page = async (o: { message?: string; error?: string } = {}) => ui.homepagePage(s, {
    kind: await homepageKind(s, env), state: await homepageState(env), confirm: await confirmOptions(s, env), nav, ...o,
  })
  const session = await ownerSession(req, s, env)
  if (req.method == 'GET') return session.reply(session.active ? page() : ui.homepageUnlockPage(s, await confirmOptions(s, env), nav))
  const form = await readForm(req)
  if (session.active && !changes(form, ['webpup'])) return session.reply(page())
  const err = await session.confirm(form)
  if (err) return session.reply(session.active ? page({ error: err }) : ui.homepageUnlockPage(s, await confirmOptions(s, env), nav, err))
  const action = form.get('webpup')
  const kind = await homepageKind(s, env)
  if (!action || kind == 'website') return session.reply(page())
  const db = store(env)
  if (action == 'remove') {
    await db.setSetting('homepage', undefined)
    await setPostUrlTemplate(s, env, false)
    return session.reply(page({ message: `webpup was removed. ${s.ownerHost} now forwards to these pages.` }))
  }
  const theme = String(form.get('theme') ?? '')
  if (action != 'install' || !isTheme(theme)) return session.reply(page({ error: 'Choose a theme.' }))
  await db.setSetting('homepage', { theme, themeSelector: form.get('theme_selector') == '1' } satisfies HomepageState)
  await setPostUrlTemplate(s, env, true)
  return session.reply(page({ message: kind == 'webpup' ? 'Saved.' : `webpup is now the homepage of ${s.ownerHost}.` }))
}
