# PUPS

Implementations of the **Personal Upload Server** ([RFC-6](https://github.com/bigwide-net/RFCs/blob/main/RFC-6-Personal-Upload-Server.md)): a server on the owner's own domain that apps write files to, after the owner allowed them.

| Folder | What it is |
| --- | --- |
| [pups-php](pups-php) | PHP drop-in for shared hosting: upload a folder, done. Includes the built-in receiver for mentions and comments, which writes the owner's inbox ([RFC-11](https://github.com/bigwide-net/RFCs/blob/main/RFC-11-Mentions.md), [RFC-12](https://github.com/bigwide-net/RFCs/blob/main/RFC-12-Inbox-Feeds.md)). |
| [pups-cloudflare](pups-cloudflare) | Cloudflare Worker with D1 and R2. |
| [pups-bunny](pups-bunny) | Bunny.net Edge Script with Bunny Storage. |
| [pups-server](pups-server) | Node/Express server for local development and tests. |
| [pups-ui](pups-ui) | The owner pages (consent screen, apps page, setup, login), shared by the TypeScript servers; pups-php uses copies of its stylesheet, script and texts. |

The TypeScript servers depend on pups-ui as a local package (`"pups-ui": "file:../pups-ui"`), so run `npm install` in the server's folder after cloning the whole repository. Each folder has its own README with installation and development instructions.
