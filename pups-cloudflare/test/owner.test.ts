import { beforeAll, describe, expect, it, vi } from 'vitest'
import { call, connect, form, mockClientFetch, ORIGIN, ownerStore, PASSWORD, put, registerClient, setupOwner, useVars } from './helpers'

/** The owner pages in same-domain mode. Own storage: this file changes the password. */

const showApps = (password = PASSWORD) => call('/pups/apps', { method: 'POST', body: form({ show: '1', password }) })

/** The value of a button in the table row of an app. */
async function rowButton(host: string, name: string, password = PASSWORD) {
  const html = await (await showApps(password)).text()
  const row = html.slice(html.indexOf(`<th scope="row">${host}`))
  return new RegExp(`name="${name}" value="([^"]+)"`).exec(row.slice(0, row.indexOf('</tr>')))?.[1]
}

/** Confirms on the apps page as owner.js does, and returns the page session it gets. */
async function startSession(password = PASSWORD) {
  const r = await call('/pups/apps', { method: 'POST', body: form({ show: '1', password }), headers: { 'pups-session': 'new' } })
  expect(r.status).toBe(200)
  return r.headers.get('pups-session')!
}

const withSession = (session: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { 'pups-session': session } })

beforeAll(async () => {
  mockClientFetch()
  await setupOwner()
})

describe('markup', () => {
  it('is semantic HTML styled only by the external stylesheet', async () => {
    const html = await (await call('/pups/apps')).text()
    expect(html).toContain('<link rel="stylesheet" href="/pups/assets/owner.css">')
    expect(html).toMatch(/<header>[^]*<nav aria-label="Owner pages">[^]*<main>[^]*<h1>/)
    // No password field: owner.js asks for the password in a dialog; the field is for pages without script.
    expect(html).toContain('<div data-confirm data-legend="Confirm that it is you" data-label="Password">\n<noscript><fieldset>')
    expect(html).not.toMatch(/ style=|<style|class=/)
  })

  it('marks the current page in the navigation', async () => {
    expect(await (await call('/pups/password')).text()).toContain('<a href="/pups/password" aria-current="page">')
  })

  it('makes setup unreachable once the owner exists', async () => {
    expect((await call('/pups/setup')).status).toBe(404)
  })
})

describe('apps page', () => {
  it('shows the apps only after confirmation', async () => {
    const c = registerClient('listed.example', { client_name: 'Listed <App>' })
    await connect(c, 'identify write:/appdata/listed.example/')
    const locked = await (await call('/pups/apps')).text()
    expect(locked).not.toContain('listed.example')
    const wrong = await showApps('wrong password!')
    expect(wrong.status).toBe(401)
    expect(await wrong.text()).toContain('role="alert"')
    const html = await (await showApps()).text()
    expect(html).toContain('<th scope="row">listed.example')
    expect(html).toContain('“<bdi>Listed &lt;App&gt;</bdi>” (self-declared)')
    expect(html).toContain('Store its own data')
  })

  it('groups the permissions as on the consent screen', async () => {
    const c = registerClient('grouped.example')
    await connect(c, 'identify write:/appdata/grouped.example/ write:/feed.json write:/.well-known/about.md')
    const html = await (await showApps()).text()
    expect(html).toContain('<li>Learn that you are <strong>tim.example.com</strong></li>')
    expect(html).toContain('<li>Store its own data\n<details>')
    expect(html).toContain('<li>Manage your feeds\n<details>')
    expect(html).toContain('<li>your feed (<code>/feed.json</code>)</li>')
    expect(html).toContain('Set in your <code>host-meta.json</code>: <code>https://bigwide.net/ns/name</code>')
    expect(html).not.toContain('Create, replace and delete your')
  })

  it('removes an app', async () => {
    const c = registerClient('removed.example')
    const t = await connect(c, 'write:/appdata/removed.example/')
    await put('/appdata/removed.example/keep.json', t.access_token, '{}')
    const grant = (await rowButton('removed.example', 'revoke'))!
    const r = await call('/pups/apps', { method: 'POST', body: form({ revoke: grant, password: PASSWORD }) })
    const html = await r.text()
    expect(html).toContain('role="status"')
    expect(html).not.toContain('<th scope="row">removed.example')
    expect((await put('/appdata/removed.example/x.json', t.access_token, '{}')).status).toBe(401)
    // Its files stay published.
    expect((await call('/files/appdata/removed.example/keep.json')).status).toBe(200)
  })

  it('removes an app and deletes its files', async () => {
    const c = registerClient('purged.example')
    const t = await connect(c, 'write:/appdata/purged.example/')
    await put('/appdata/purged.example/a.json', t.access_token, '{}')
    await put('/appdata/purged.example/sub/b.json', t.access_token, '{}')
    const grant = (await rowButton('purged.example', 'revoke_delete'))!
    const r = await call('/pups/apps', { method: 'POST', body: form({ revoke_delete: grant, password: PASSWORD }) })
    expect(await r.text()).toContain('Deleted 2 of its files')
    expect((await call('/files/appdata/purged.example/a.json')).status).toBe(404)
  })

  it('requires confirmation for every change', async () => {
    const c = registerClient('kept.example')
    await connect(c, 'write:/appdata/kept.example/')
    const grant = (await rowButton('kept.example', 'revoke'))!
    const r = await call('/pups/apps', { method: 'POST', body: form({ revoke: grant }) })
    expect(r.status).toBe(401)
    expect(await (await showApps()).text()).toContain('<th scope="row">kept.example')
  })

  it('removes links from host-meta.json', async () => {
    const c = registerClient('linker.example')
    const t = await connect(c, 'write:/appdata/linker.example/')
    const href = `${ORIGIN}/files/appdata/linker.example/feed.json`
    await call('/pups/host-meta', {
      method: 'POST', body: JSON.stringify({ action: 'add', rel: 'https://linker.example/rel/feed', href }),
      headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json' },
    })
    expect(await (await showApps()).text()).toContain(href)
    await call('/pups/apps', { method: 'POST', body: form({ remove_link: JSON.stringify(['https://linker.example/rel/feed', href]), password: PASSWORD }) })
    const doc = await (await call('/.well-known/host-meta.json')).json() as any
    expect(doc.links.some((l: any) => l.href == href)).toBe(false)
  })
})

describe('page session (same-domain mode)', () => {
  it('starts with a confirmation, only for owner.js, and then shows the pages without one', async () => {
    expect((await showApps()).headers.get('pups-session')).toBeNull()
    expect((await call('/pups/apps', withSession('new'))).headers.get('pups-session')).toBeNull()
    const session = await startSession()
    expect(session).toMatch(/^[\w-]+\.[\w-]+$/)
    for (const path of ['/pups/apps', '/pups/homepage', '/pups/password']) {
      const r = await call(path, withSession(session))
      const html = await r.text()
      expect(html, path).not.toContain('Confirm that you are the owner')
      expect(r.headers.get('pups-session'), path).toBeTruthy()
      expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin')
      expect(r.headers.get('content-security-policy')).toContain("connect-src 'self'")
      expect(r.headers.get('set-cookie')).toBeNull()
    }
    // Reload needs no confirmation.
    const reload = await call('/pups/apps', withSession(session, { method: 'POST', body: form({ show: '1' }) }))
    expect(await reload.text()).toContain('Apps that can write to')
  })

  it('still needs a confirmation for every change, which starts a new session', async () => {
    const c = registerClient('session-kept.example')
    await connect(c, 'write:/appdata/session-kept.example/')
    const grant = (await rowButton('session-kept.example', 'revoke'))!
    const session = await startSession()
    const r = await call('/pups/apps', withSession(session, { method: 'POST', body: form({ revoke: grant }) }))
    const html = await r.text()
    expect(html).toContain('Please confirm with your passkey or password.')
    expect(html).toContain('<th scope="row">session-kept.example')
    const ok = await call('/pups/apps', withSession(session, { method: 'POST', body: form({ revoke: grant, password: PASSWORD }) }))
    expect(await ok.text()).not.toContain('<th scope="row">session-kept.example')
    expect(ok.headers.get('pups-session')).toBeTruthy()
  })

  it('ignores a changed session and one that expired', async () => {
    const session = await startSession()
    const locked = async (s: string) => {
      const r = await call('/pups/apps', withSession(s))
      return [(await r.text()).includes('Confirm that you are the owner'), r.headers.get('pups-session')]
    }
    expect(await locked(session.slice(0, -2) + (session.endsWith('AA') ? 'BB' : 'AA'))).toEqual([true, null])
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(now + 14 * 60_000)
      const renewed = (await call('/pups/apps', withSession(session))).headers.get('pups-session')!
      clock.mockReturnValue(now + 28 * 60_000)
      expect((await locked(renewed))[0]).toBe(false)
      expect((await locked(session))[0]).toBe(true)
      clock.mockReturnValue(now + 61 * 60_000)
      expect(await locked(renewed)).toEqual([true, null])
    } finally {
      clock.mockRestore()
    }
  })
})

describe('passkeys', () => {
  it('while the owner has one, the password is not accepted, and the pages have no password field', async () => {
    const db = ownerStore()
    const { passwordHash } = (await db.owner())!
    await db.replaceCredentials(passwordHash, { id: 'test-passkey', publicKey: 'AAAA', counter: 0, transports: [] })
    try {
      const html = await (await call('/pups/apps')).text()
      expect(html).toContain('<div data-confirm hidden>')
      expect(html).not.toContain('name="password"')
      const r = await showApps()
      expect([r.status, (await r.text()).includes('Confirm with your passkey. The password works only while you have no passkey.')]).toEqual([401, true])
    } finally {
      await db.replaceCredentials(passwordHash, null)
    }
    expect((await showApps()).status).toBe(200)
  })
})

describe('password page', () => {
  const change = (fields: Record<string, string>) => call('/pups/password', { method: 'POST', body: form(fields) })
  const NEW = 'a brand new password'

  it('rejects a wrong current password, a short password and a mismatch', async () => {
    for (const [fields, msg] of [
      [{ password: 'wrong password!', new_password: NEW, new_password2: NEW }, 'The confirmation failed.'],
      [{ password: PASSWORD, new_password: 'short', new_password2: 'short' }, 'at least 12 characters'],
      [{ password: PASSWORD, new_password: NEW, new_password2: NEW + 'x' }, 'do not match'],
    ] as const) {
      const r = await change(fields)
      expect(r.status).toBe(400)
      expect(await r.text()).toContain(msg)
    }
    expect((await showApps()).status).toBe(200)
  })

  it('changes the password, which ends the page sessions of other pages', async () => {
    const other = await startSession()
    const r = await call('/pups/password', withSession('new', { method: 'POST', body: form({ password: PASSWORD, new_password: NEW, new_password2: NEW }) }))
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('Your password was changed.')
    expect(await (await call('/pups/apps', withSession(other))).text()).toContain('Confirm that you are the owner')
    expect(await (await call('/pups/apps', withSession(r.headers.get('pups-session')!))).text()).toContain('Apps that can write to')
    expect((await showApps(PASSWORD)).status).toBe(401)
    expect((await showApps(NEW)).status).toBe(200)
  })
})

describe('recovery', () => {
  const RECOVERY = 'a recovery secret of some length'
  const recover = (fields: Record<string, string>) => call('/pups/recover', { method: 'POST', body: form(fields) })

  it('exists only while RECOVERY_SECRET is set, replaces the passkeys and the password, and works once per secret', async () => {
    expect((await call('/pups/recover')).status).toBe(404)
    useVars({ RECOVERY_SECRET: RECOVERY })
    try {
      expect(await (await call('/pups/recover')).text()).toContain('Recover your login')
      expect(await (await recover({ step: 'secret', secret: 'not the recovery secret' })).text()).toContain('Wrong recovery secret.')
      const db = ownerStore()
      await db.replaceCredentials((await db.owner())!.passwordHash, { id: 'lost-passkey', publicKey: 'AAAA', counter: 0, transports: [] })
      const token = /name="setup" value="([^"]+)"/.exec(await (await recover({ step: 'secret', secret: RECOVERY })).text())![1]
      const NEW = 'the recovered password'
      expect(await (await recover({ setup: token, new_password: NEW, new_password2: NEW })).text()).toContain('Remove the secret <code>RECOVERY_SECRET</code> now.')
      expect((await db.owner())!.passkeys).toEqual([])
      expect((await showApps(NEW)).status).toBe(200)
      expect(await (await recover({ step: 'secret', secret: RECOVERY })).text()).toContain('This recovery secret was used already.')
      expect((await recover({ setup: token, new_password: 'yet another password', new_password2: 'yet another password' })).status).toBe(404)
    } finally {
      useVars()
    }
  })
})
