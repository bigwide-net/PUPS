# pups-feeds

**Kept feeds** of the Personal Upload Server ([RFC-7](https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md)): the server, not the apps, keeps the archives of the owner's feeds ([RFC-13](https://github.com/bigwide-net/RFCs/blob/main/RFC-13-JSON-Feed-Archives.md)). It is a port of `lib/archive.php` in pups-php, so that all servers keep feeds the same way.

## What it does

A feed file in `/feed.json` or `/feed/<name>.json` that carries `"_pups": { "pupsControlled": true }` is kept by the server:

- **Posting items.** Apps send posts one at a time with `POST` of a JSON Feed item to the feed file. The server gives each post its index and, with a post URL template in `host-meta.json`, the URL of its page, and answers with the item and its address (the archive's URL and `#id`). Edits name the item by its index; deletes carry `"_pups": { "delete": true }`.
- **Archives.** Every post is in exactly one archive, `feed.000000.json`, `feed.000001.json`, … in the feed directory, 20 posts each, newest first, chained with `next_url`. Items never move; deleted ones leave a gap.
- **The feed file** holds copies of the newest 30 posts and points to the newest archive. A `PUT` of the feed file is applied: its items are compared with the stored ones, and posts are added, changed or deleted accordingly; its other fields become the feed's settings.
- **Handed-over feeds** (made by hand or with another tool) get archives with their items on the next write, continuing their `next_url`.
- **Comment feeds** ([RFC-7 "Publishing comments"](https://github.com/bigwide-net/RFCs/blob/main/RFC-7-Feed-Publishing-with-PUPS.md#publishing-comments)): comments the owner approved in the inbox go into `<feed dir>/comments/<index>.json`, newest first (`src/comments.ts`, used by pups-inbox through `commentFeeds()`). While the feed's `_submissions` names the server's comment endpoint (`FeedHost.commentEndpoint`), the server keeps every post's `_source.comments` (RFC-1): `{count: 0, total: 0}` while it takes comments, then the comment feed and the counts. A deleted post's comment feed goes with it. `comments` is therefore no feed name.
- Apps can't write the archives or the comment feeds; the servers refuse it with `403`.
- **WebSub** (`src/websub.ts`, RFC-7 "Real-time updates"): a minimal hub for the feed files. With `FeedHost.hub`, feed files get `hubs`, which apps can't set; `rewriteKeptFeed()` writes a feed file again after the hub was turned on or off. `hubRequest()` checks a subscription request and its limits (the owner's maximum, 5 per callback host and feed, trusted domains beyond the maximum), `verifyIntent()` verifies it at the callback after the response, and `pingAll()` sends the empty POSTs after a change. Where the subscriptions live, and how the pings are spread over requests, is up to each server (`HubStore`).

## Used by

| | How |
| --- | --- |
| [pups-cloudflare](../../pups-cloudflare) | Every write of a feed and its archives under a lock in the Durable Object; files in R2. |
| [pups-bunny](../../pups-bunny) | Files in Bunny Storage; requests to the same feed take their turn within a script instance (Bunny has no atomic operations). |

[pups-php](../../pups-php) has its own implementation, which this package follows. Apps reach it through [pups-client](https://github.com/bigwide-net/pups-client) (`session.feed()`), which checks for `"kept_feeds": true` in the configuration document.

## Use

The package does no I/O of its own. A server passes in a `FeedHost` (`src/kept.ts`): its public URLs, a reader for stored files, the post URL template from `host-meta.json`, and a clock. Then, under its lock:

- `isFeedPath(path, wellKnown)` and `archiveOwner(path, wellKnown)` decide which writes are about kept feeds.
- `putKeptFeed(host, path, body, stored)` for a `PUT` of a feed file with the marker, after the preconditions.
- `readItem(contentType, body)` and `postItem(host, path, item, stored)` for a `POST` of an item.

Both return what to write: the changed archives, the oldest first, and the feed file last (RFC-13 "The archive comes first"), and the comment feeds of deleted posts to delete afterwards. The server checks its storage quota, writes the files in this order, and answers. Errors are `FeedError`s with an HTTP status and an RFC-6 error code.

```json
"dependencies": { "pups-feeds": "file:../lib/pups-feeds" }
```

## Development

```
npm install
npm test           # the PHP tests of kept feeds, ported, with in-memory storage
npm run typecheck
```

A change here is a change to pups-php's behaviour too: keep the two in step, and run the tests of both TypeScript servers.
