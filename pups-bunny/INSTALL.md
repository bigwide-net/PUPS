# Installing pups-bunny

These steps set up your Personal Upload Server on Bunny.net. You need:

- a Bunny.net account,
- a domain whose DNS you can change, e.g. `tim.example.com`,
- [Node.js](https://nodejs.org) 20 or later, to build the script once.

It takes about 15 minutes.

## 1. Build the script

```
git clone https://github.com/bigwide-net/PUPS.git
cd PUPS/pups-bunny                                    # the libraries it needs are in ../lib
npm install
npm run build
```

This creates one file, `dist/index.js`. That file is the whole server.

## 2. Create a storage zone

1. In the Bunny dashboard, open **Storage** and click **Add Storage Zone**.
2. Pick a name, e.g. `tim-pups`, and a main region close to you. Leave replication off.
3. Open the zone's **FTP & API Access** page and note:
   - the **password**, which is the storage zone password, not the read-only one;
   - the **hostname**, e.g. `storage.bunnycdn.com` or `ny.storage.bunnycdn.com`.

Don't connect this storage zone to a pull zone. The server's own data lives in it.

## 3. Create the Edge Script

1. Open **Edge Scripting** and click **Add Script**.
2. Choose **Standalone** and give it a name, e.g. `pups`.
3. Replace the example code with the contents of `dist/index.js`, then save and publish.

## 4. Configure the script

In the script's environment settings (**Env Configuration**), add these **variables**:

| Name | Value |
| --- | --- |
| `OWNER_HOST` | your domain, e.g. `tim.example.com` |
| `STORAGE_ZONE` | the storage zone name, e.g. `tim-pups` |
| `STORAGE_HOST` | the hostname from step 2, e.g. `storage.bunnycdn.com` |

And these **secrets**:

| Name | Value |
| --- | --- |
| `STORAGE_ACCESS_KEY` | the storage zone password from step 2 |
| `BOOTSTRAP_SECRET` | a random text of at least 16 characters. You need it once, in step 6 |

Publish the script again so it picks up the settings.

## 5. Connect your domain

Bunny created a pull zone for the script. Open it (**CDN**, or the script's **Hostnames** tab):

1. Add your domain, e.g. `tim.example.com`, as a **custom hostname**.
2. At your DNS provider, add a **CNAME** record from your domain to the pull zone's hostname, e.g. `pups-123.b-cdn.net`. For a bare domain like `example.com`, use Bunny DNS or a provider that supports CNAME flattening (ALIAS).
3. Back in Bunny, **activate the free SSL certificate** for the hostname and enable **Force SSL**.
4. Under **Caching**, set the cache expiration time to **Respect origin Cache-Control**. Don't add rules that cache your files: apps rely on reading the latest version.
5. Under **Edge Rules**, add a rule that keeps your private files out of the cache (the pull zone may otherwise hand a cached private file, or a cached "not found", to the next request):
   - Action: **Override Cache Time**, `0` seconds.
   - Conditions: **Request URL**, match any of `*/pups/private/*` and `*/appdata/*/private/*`.

   The `*` at the start makes the rule apply both under `/files/` and at the domain root.

## 6. Set up your account

Open `https://tim.example.com/pups/setup` (with your domain) and:

1. enter the bootstrap secret from step 4,
2. register a passkey, or choose a password (at least 12 characters).

Done. The setup page then links to two checks:

- `https://tim.example.com/.well-known/host-meta.json` should show a link to your server,
- `https://tim.example.com/personal-storage.json` should show its configuration.

You can now connect apps. Manage them at `https://tim.example.com/pups/apps`.

Your domain has no homepage yet: `https://tim.example.com/` forwards to the owner pages. On the page **Homepage** (`https://tim.example.com/pups/homepage`) you can install webpup, a homepage that shows your profile, posts and pages. Mentions and comments from other sites land in your inbox; the page *Apps* shows how many there are.

## If something doesn't work

| Symptom | Fix |
| --- | --- |
| "Server misconfigured" | `STORAGE_ZONE`, `STORAGE_HOST` or `STORAGE_ACCESS_KEY` is missing. Check step 4 and publish again. |
| "Setup not possible" | `BOOTSTRAP_SECRET` is missing or shorter than 16 characters. |
| Errors mentioning Bunny Storage and HTTP 401 | Wrong storage password or hostname. Use the zone's main password and its region's hostname. |
| The page keeps redirecting | Please report it: the pull zone doesn't pass on that the request used HTTPS ([Open questions](README.md#open-questions)). |
| Apps can't upload | Please report it with the app's error message. PUT and DELETE through the pull zone aren't tested on Bunny yet. |

This version hasn't been tested on Bunny yet; see [Open questions](README.md#open-questions) in the README. Every report from a first installation helps.

## Updating

Run `git pull`, then `npm install && npm run build`, paste the new `dist/index.js` into the script and publish. Your data and settings stay.

## More options

An auth subdomain, a storage quota, your own well-known paths, and an existing website behind the server: see [Configuration](README.md#configuration) in the README.
