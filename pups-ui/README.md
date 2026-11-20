# pups-ui

The owner pages of the **Personal Upload Server** ([RFC-6](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md)), shared by the TypeScript implementations [pups-cloudflare](../pups-cloudflare), [pups-bunny](../pups-bunny) and [pups-server](../pups-server). [pups-php](../pups-php) uses copies of `texts.json` and the assets.

- `src/html.ts`: the page frame with its security headers, messages, and the fieldset in which the owner confirms with a passkey or the password.
- `src/scopes.ts`: `isPrivate()`, the consent groups of the scopes and their wording.
- `src/consent.ts`: the consent screen.
- `src/owner.ts`: setup, login, the apps page and the password page.
- `src/sanitize.ts`: the sanitizer for untrusted text (client metadata, scopes, paths, host-meta.json).
- `texts.json`, `src/texts.ts`: the texts of the consent screen, the permission lists and the confirmation fieldset, read with `t(key, vars)`. PHP reads the same file.
- `public/pups/assets/`: `owner.css` and `owner.js`, served at `/pups/assets/`. `public/_headers` sets their headers on Cloudflare.

The functions are pure: a server passes in plain data (its settings, the parsed scopes, the grants) and gets HTML or a `Response`. Request handling, storage and authentication stay in the servers.

## Use

The servers in this repository depend on it as a local package:

```json
"dependencies": { "pups-ui": "file:../pups-ui" }
```

It ships TypeScript sources; the servers' bundlers (wrangler, esbuild) or ts-node and ts-jest (pups-server) compile them. The servers need `"resolveJsonModule": true` for `texts.json`.

- `import { consentPage, appsPage, … } from 'pups-ui'`
- Cloudflare serves the assets as static assets: `"assets": { "directory": "./node_modules/pups-ui/public" }` in `wrangler.jsonc`.
- Servers that serve them from code import them as text: `import { ownerCss, ownerJs } from 'pups-ui/assets'` (needs `?raw` imports, see `src/raw.d.ts`).
- pups-server serves `public/pups/assets/` with `express.static`.
- pups-php can't use the package: `scripts/sync-ui.sh` there copies `owner.css`, `owner.js` and `texts.json`, and a test fails while the copies are out of date.

## Development

```
npm install
npm test
npm run typecheck
```

After a change, run the tests of all servers too, and `scripts/sync-ui.sh` in pups-php if you changed `texts.json` or the assets.
