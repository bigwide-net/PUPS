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

describe('Markdown twin', () => {
  const state = { theme: 'default', themeSelector: false }
  const pages = 'https://bigwide.net/ns/webpup-pages', mark = 'https://bigwide.net/ns/webpup-homepage'
  const hostMeta = async () => ({ links: [
    { rel: pages, href: 'https://tim.example.com/pups/pages/now.md' },
    { rel: pages, href: 'https://tim.example.com/pups/pages/welcome.md', properties: { [mark]: 'true' } },
  ] })
  const twin = async (url: string, o: object = { ...opts, ownerOrigin: 'https://tim.example.com', hostMeta }) => {
    const u = new URL(url, 'https://tim.example.com')
    const html = await (await webpupResponse(get(url), u.pathname, state, o as any))!.text()
    return /<link rel="alternate" type="text\/markdown" href="([^"]*)">/.exec(html)?.[1]?.replace(/&amp;/g, '&')
  }

  it('links the Markdown file of the URL, for Markdown browsers like bonBon', async () => {
    expect(await twin('/')).toBe('https://tim.example.com/pups/pages/welcome.md')
    expect(await twin('/index.html')).toBe('https://tim.example.com/pups/pages/welcome.md')
    expect(await twin('/p/md/docs/%C3%9Cber%20uns.md')).toBe('https://tim.example.com/docs/%C3%9Cber%20uns.md')
    expect(await twin('/index.html?show=md&path=/docs/intro.md')).toBe('https://tim.example.com/docs/intro.md')
    for (const url of ['/?show=about', '/p/about', '/p/md/x.html', '/p/md//evil.example/x.md', '/p/md/%E0%A4%A.md', '/index.html?show=md&path=x.md'])
      expect(await twin(url), url).toBeUndefined()
  })

  it('has none without a marked page, or without the owner origin', async () => {
    expect(await twin('/', { ...opts, ownerOrigin: 'https://tim.example.com', hostMeta: async () => ({ links: [{ rel: pages, href: 'https://elsewhere.example/x.md', properties: { [mark]: 'true' } }] }) })).toBeUndefined()
    expect(await twin('/', { ...opts, ownerOrigin: 'https://tim.example.com', hostMeta: async () => { throw new Error('x') } })).toBeUndefined()
    expect(await twin('/p/md/a.md', opts)).toBeUndefined()
  })
})
