# PUPS

Implementations of the **Personal Upload Server** ([RFC-6](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md)): a server on the owner's own domain that apps write files to, after the owner allowed them.

| Folder | What it is |
| --- | --- |
| [pups-php](pups-php) | PHP drop-in for shared hosting: upload a folder, done. Includes the built-in receiver for mentions and comments, which writes the owner's inbox ([RFC-11](https://github.com/bigwide-net/RFCs/blob/main/RFC-11-Mentions.md), [RFC-12](https://github.com/bigwide-net/RFCs/blob/main/RFC-12-Inbox-Feeds.md)). |
| [pups-cloudflare](pups-cloudflare) | Cloudflare Worker with a Durable Object and R2. Includes kept feeds, the receiver and webpup, like pups-php. |
| [pups-bunny](pups-bunny) | Bunny.net Edge Script with Bunny Storage. Includes kept feeds, the receiver and webpup, like pups-php. |
| [pups-server](pups-server) | Node/Express server for local development and tests. |
| [webpup](webpup) | A homepage for a PUPS domain: the owner's profile, feeds and pages, rendered in the browser. pups-php comes with a build of it, the TypeScript servers get one through pups-ui; all of them install it from the owner pages. |
| [pups-ui](lib/pups-ui) | The owner pages (consent screen, apps page, homepage, setup, login) and webpup's build, shared by the TypeScript servers; pups-php uses copies of its stylesheet, script and texts. |
| [pups-inbox](lib/pups-inbox) | The built-in receiver of the Cloudflare and Bunny servers, a port of pups-php's: mentions, comments and the inbox, with the storage left to each server. |
| [pups-feeds](lib/pups-feeds) | Kept feeds of the Cloudflare and Bunny servers, a port of pups-php's (RFC-7, RFC-13): items posted to a feed file, archives written by the server. |

The TypeScript servers depend on the libraries in `lib/` (pups-ui, pups-inbox, pups-feeds) as local packages (`"pups-ui": "file:../lib/pups-ui"`), so run `npm install` in the server's folder after cloning the whole repository. Each folder has its own README with installation and development instructions.
