# pups-inbox

The built-in **receiver** of the Personal Upload Server: it takes what other sites send the owner (mentions and comments) and puts it into the owner's **inbox**, a private JSON Feed at `/pups/private/inbox.json` ([RFC-12](https://github.com/bigwide-net/RFCs/blob/main/RFC-12-Inbox-Feeds.md)) that the owner's feed reader shows. It is a port of the receiver in pups-php (`handler/mentions.php`, `handler/inbox.php`, `lib/inbox.php`, `lib/feeds.php`, `lib/content.php`), so that all servers behave the same.

## What it does

- **Mentions** ([RFC-11](https://github.com/bigwide-net/RFCs/blob/main/RFC-11-Mentions.md)): webmentions at `/pups/mention`, answered with `202` and checked later. A post lands in the inbox if it names `@ownerdomain` in its visible text, or replies to one of the owner's items (also in archives, and items a group republished for the owner).
- **Comments** ([RFC-4](https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md)) on the owner's feeds that name `/pups/comments` in `_submissions.url`: `201` with a status page (`/pups/comments/status/s-…`, 24 hours), checked against the feed's policy and put into the inbox. With `republish: "full"` or `"summary"` in a kept feed, the item has a **Publish Comment** action that publishes the comment in the post's comment feed (`/feed/comments/<index>.json`, through `Receiver.commentFeeds`); the status page says `pending` (30 days) until then. Replies to published comments, as deep as the policy's `maxDepth` allows (at most 10), go into the comment feed of the comment they answer (`/feed/comments/<index>/<comment id>.json`); `commentLimit` counts all levels. With `republish: "no"`, comments are never published. Edits and deletes as the policy allows, also of published comments; an edit of a published comment waits for approval again, a delete takes the replies along. The owner's own comments (author feed on the owner's host or server) are published at once and never go into the inbox. The content must follow [RFC-5](https://github.com/bigwide-net/RFCs/blob/main/RFC-5-Comment-HTML.md) with the features the policy turns on (`comment-html.ts`: Markdown rendered with markdown-it, then a strict tokenizer); a comment that breaks a rule is rejected with the reason, and the inbox and comment feed get the normalized HTML and the Markdown (`_source.markdown`). pups-php's `commenthtml.php` and `markdown.php` are a port, checked against `test/comment-html-cases.json` and `test/markdown-cases.json`.
- **Auto-moderation**, off by default. `Receiver.moderation` (moderation.ts) keeps the settings that the owner enters on the comments page (pups-ui's `commentsPage`): the API key of an OpenAI-compatible chat API (OpenRouter by default, model `openai/gpt-5-nano`; both can be changed), your own criteria, a threshold (90 % by default) and a daily limit of tokens in thousands (500 by default, at most 10,000). A model then rates each comment against general rules (spam, scams, illegal and adult content, abuse, personal data) and your criteria; comments rated at least as likely acceptable as the threshold are published at once, all others wait in your inbox with the rating. If the API fails or the day's tokens are used up, comments simply wait in your inbox.
- **Sending mentions** (RFC-11, `sender.ts`) for the comments it publishes: a reply mention to the author of the item a comment answers, unless that item has RFC-4 `_commenting.notifyReplies: false`, and a mention by name to every other handle, at most 20, never to the comment's author or the owner. A comment's `notifyReplies: false` is republished, and changing it alone is accepted without `allowEdit` or approval. Approved edits and deletes send the mentions again, also for the replies a delete removes. The mentions are `send` jobs in `Receiver.queue` (keys `out.…`, at most 200), sent by `processQueue`; endpoints from `host-meta.json` are remembered for an hour in `Receiver.statuses`, and deliveries that fail with a network error, `5xx` or `429` are retried for about a day. pups-php's `lib/sender.php` is a port.
- **Fetching posts** safely: JSON Feed, RSS and HTML pages with h-entry; 1 MB, 10 s, 3 redirects, never the server's own endpoints.
- **Dismiss** and **Publish Comment**: RFC-9 actions (`/pups/inbox/action`, `do=approve`, with a key derived from the server secret) and RFC-8 pages that ask first (`/pups/inbox/dismiss`, `/pups/inbox/approve`). Dismissing a comment that could be approved rejects it (`moderation-rejected`).
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
| `commentFeeds?: CommentFeeds` | The comment feeds of the owner's kept feeds, usually pups-feeds' `commentFeeds()` with the server's lock and writes. Without it, comments are never published. |
| `queue: JobQueue` | The webmentions waiting to be checked, and the mentions waiting to be sent: get, put, delete, count by key prefix, the oldest (by `receivedAt`, or by the time of writing). |
| `statuses: StatusStore` | The comment status pages, with their expiry; also the remembered mention endpoints of other domains (`d-…`). |
| the rest | The owner's origin and host, the switches, `inboxKey(secret)`, a clock, a logger. |

Then route requests to `mentionEndpoint`, `commentEndpoint`, `commentStatusEndpoint`, `inboxActionEndpoint` and `dismissPage`, and run `processQueue(r, { maxJobs })` after the response, also after *Publish Comment*, which queues mentions. `inboxSummary(r)` gives the numbers for the apps and comments pages, `moderationView` and `saveModeration` show and save the settings of auto-moderation.

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
