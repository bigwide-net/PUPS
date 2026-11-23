/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { homepagePage, isTheme, startPage, themeThumbnail, webpupResponse, webpupThemes } from '../src'
import { WEBPUP_FILES } from '../src/webpup-files'

const site = { ownerHost: 'tim.example.com', ownerOrigin: 'https://tim.example.com', subdomainMode: false }
const confirm = { hasPasskey: false, challenge: '', hasPassword: true } as any
const opts = { settingsUrl: 'https://tim.example.com/pups/homepage', ownerLink: 'https://tim.example.com/pups/' }
const get = (path: string, headers: Record<string, string> = {}) => new Request(`https://tim.example.com${path}`, { headers })

describe('webpup', () => {
  it('is the current build of ../webpup (run npm run sync-webpup after building it)', () => {
    const dist = new URL('../../../webpup/dist', import.meta.url).pathname
    if (!existsSync(dist)) return
    const files: string[] = []
    const walk = (dir: string) => readdirSync(dir).forEach(n => statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : files.push(join(dir, n)))
    walk(dist)
    expect(Object.keys(WEBPUP_FILES).sort()).toEqual(files.map(f => '/' + relative(dist, f)).sort())
    for (const f of files) {
      const entry = WEBPUP_FILES['/' + relative(dist, f)]!
      expect(entry.text ?? entry.base64, f).toBe(entry.base64 ? readFileSync(f).toString('base64') : readFileSync(f, 'utf8'))
    }
  })

  it('serves its files with the chosen theme, and the theme browser only when it is on', async () => {
    const state = { theme: 'night', themeSelector: false }
    const home = (await webpupResponse(get('/'), '/', state, opts))!
    expect([home.status, home.headers.get('cache-control')]).toEqual([200, 'no-cache'])
    expect(await home.text()).toContain('<meta name="generator" content="webpup">')
    expect((await webpupResponse(get('/', { 'if-none-match': home.headers.get('etag')! }), '/', state, opts))!.status).toBe(304)
    expect(await (await webpupResponse(get('/theme.css'), '/theme.css', state, opts))!.text()).toContain(WEBPUP_FILES['/webpup-themes/night.css']!.text)
    expect(await webpupResponse(get('/webpup-themes/paper.css'), '/webpup-themes/paper.css', state, opts)).toBeUndefined()
    expect((await webpupResponse(get('/webpup-themes/paper.jpg'), '/webpup-themes/paper.jpg', { ...state, themeSelector: true }, opts))!.headers.get('content-type'))
      .toBe('image/jpeg')
    expect(await webpupResponse(get('/feed.json'), '/feed.json', state, opts)).toBeUndefined()
    expect(await webpupResponse(new Request('https://tim.example.com/', { method: 'POST' }), '/', state, opts)).toBeUndefined()
  })

  it('has themes with thumbnails, and only listed ids are themes', () => {
    const ids = Object.keys(webpupThemes())
    expect(ids).toContain('night')
    for (const id of ids) expect(themeThumbnail(id)?.status, id).toBe(200)
    expect([isTheme('default'), isTheme('../x'), isTheme('custom')]).toEqual([true, false, false])
    expect(themeThumbnail('../x')).toBeUndefined()
  })
})

describe('pages', () => {
  it('offer webpup on the start page and the homepage page', async () => {
    const start = await startPage(site, { hasOwner: true, homepage: 'none', configUrl: 'https://tim.example.com/personal-storage.json', nav: '' }).text()
    expect(start).toContain('<a href="/pups/homepage">Install webpup</a>')
    const page = await homepagePage(site, { kind: 'webpup', state: { theme: 'paper', themeSelector: true }, confirm, nav: '' }).text()
    expect(page).toContain('<input type="radio" name="theme" value="paper" checked>')
    expect(page).toContain('Remove webpup')
    expect(page).toContain('<code>https://tim.example.com/p/{feed}/post/{index}</code>')
  })
})
