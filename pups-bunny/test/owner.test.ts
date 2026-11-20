import { beforeAll, describe, expect, it } from 'vitest'
import { call, connect, form, mockClientFetch, ORIGIN, PASSWORD, put, registerClient, setupOwner } from './helpers'

/** The owner pages in same-domain mode. Own storage: this file changes the password. */

const showApps = (password = PASSWORD) => call('/pups/apps', { method: 'POST', body: form({ show: '1', password }) })

/** The value of a button in the table row of an app. */
async function rowButton(host: string, name: string, password = PASSWORD) {
  const html = await (await showApps(password)).text()
  const row = html.slice(html.indexOf(`<th scope="row">${host}`))
  return new RegExp(`name="${name}" value="([^"]+)"`).exec(row.slice(0, row.indexOf('</tr>')))?.[1]
}

beforeAll(async () => {
  mockClientFetch()
  await setupOwner()
})

describe('markup', () => {
  it('is semantic HTML styled only by the external stylesheet', async () => {
    const html = await (await call('/pups/apps')).text()
    expect(html).toContain('<link rel="stylesheet" href="/pups/assets/owner.css">')
    expect(html).toMatch(/<header>[^]*<nav aria-label="Owner pages">[^]*<main>[^]*<h1>/)
    expect(html).toContain('<fieldset data-confirm>')
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

  it('changes the password', async () => {
    const r = await change({ password: PASSWORD, new_password: NEW, new_password2: NEW })
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('Your password was changed.')
    expect((await showApps(PASSWORD)).status).toBe(401)
    expect((await showApps(NEW)).status).toBe(200)
  })
})
