# pups-inbox

The built-in **receiver** of the Personal Upload Server: it takes what other sites send the owner (mentions and comments) and puts it into the owner's **inbox**, a private JSON Feed at `/pups/private/inbox.json` ([RFC-12](https://github.com/bigwide-net/RFCs/blob/main/RFC-12-Inbox-Feeds.md)) that the owner's feed reader shows. It is a port of the receiver in pups-php (`handler/mentions.php`, `handler/inbox.php`, `lib/inbox.php`, `lib/feeds.php`, `lib/content.php`), so that all servers behave the same.

## What it does

- **Mentions** ([RFC-11](https://github.com/bigwide-net/RFCs/blob/main/RFC-11-Mentions.md)): webmentions at `/pups/mention`, answered with `202` and checked later. A post lands in the inbox if it names `@ownerdomain` in its visible text, or replies to one of the owner's items (also in archives, and items a group republished for the owner).
- **Comments** ([RFC-4](https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md)) on the owner's feeds that name `/pups/comments` in `_submissions.url`: `201` with a status page (`/pups/comments/status/s-…`, 24 hours), checked against the feed's policy, put into the inbox, never published. Edits and deletes as the policy allows.
- **Fetching posts** safely: JSON Feed, RSS and HTML pages with h-entry; 1 MB, 10 s, 3 redirects, never the server's own endpoints.
- **Dismiss**: an RFC-9 action on every item (`/pups/inbox/action`, with a key derived from the server secret) and an RFC-8 page that asks first (`/pups/inbox/dismiss`).
- **Limits** as in PHP: 100 items, 10 per host; mentions are dropped after 30 days or to make room, comments never. At most 100 webmentions wait, 5 per host (`429`).

## Used by

| | How |
| --- | --- |
| [pups-cloudflare](../../pups-cloudflare) | Inbox in R2 with conditional writes; queue and status pages in the Durable Object; the queue checked with `ctx.waitUntil()`. |
| [pups-bunny](../../pups-bunny) | Inbox, queue and status pages as files in Bunny Storage; a DNS check before each fetch; the queue checked with `Bunny.v1.waitUntil()`. |

[pups-php](../../pups-php) has its own implementation, which this package follows. The pages come from [pups-ui](../pups-ui).

## Use

The package does no I/O of its own. A server passes in a `Receiver` (`src/receiver.ts`):

| Part | What the server provides |
| --- | --- |
| `inbox: InboxStore` | `read()` the inbox with a version, and `write(text, version)` only if it is unchanged (false otherwise; the package retries). |
| `feeds: FeedSource` | The storage path of a URL the server serves itself (`ownerPath`), reading such a file, `fetch`, and optionally `checkUrl` (SSRF check). |
| `queue: JobQueue` | The webmentions waiting to be checked: get, put, delete, count by key prefix, the oldest. |
| `statuses: StatusStore` | The comment status pages, with their expiry. |
| the rest | The owner's origin and host, the switches, `inboxKey(secret)`, a clock, a logger. |

Then route requests to `mentionEndpoint`, `commentEndpoint`, `commentStatusEndpoint`, `inboxActionEndpoint` and `dismissPage`, and run `processQueue(r, { maxJobs })` after the response. `inboxSummary(r)` gives the numbers for the apps page.

```json
"dependencies": { "pups-inbox": "file:../lib/pups-inbox" }
```

## Development

```
npm install
npm test           # the PHP receiver's tests, ported: a fake network and in-memory storage
npm run typecheck
```

A change here is a change to pups-php's behaviour too: keep the two in step, and run the tests of both TypeScript servers.
