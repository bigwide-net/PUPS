import { alert, confirmFields, type ConfirmOptions, escapeHtml as h, jsonScript, page, status, time } from './html'
import { type HomepageKind, homepageSummary } from './homepage'
import { inboxSection, type InboxSummary, moderationSection, type ModerationView } from './inbox'
import { sanitizeText, visible } from './sanitize'
import { t } from './texts'

/**
 * Owner pages: first-run setup, login (auth subdomain mode only), the apps page, the comments
 * page and the password page. The servers handle the requests and pass in what the pages show.
 */

export const MIN_PASSWORD_LENGTH = 12

/** What every owner page needs to know about the installation. */
export interface OwnerSite {
  ownerHost: string
  /** `https://<owner host>`. */
  ownerOrigin: string
  /** Auth subdomain mode: the owner pages have sessions (RFC-6 "Deployment modes"). */
  subdomainMode: boolean
  /** The built-in receiver takes comments: the owner pages have a comments page. */
  comments?: boolean
}

export type OwnerPath = '/pups/apps' | '/pups/homepage' | '/pups/comment-settings' | '/pups/password' | ''

export function ownerNav(site: OwnerSite, current: OwnerPath) {
  const item = (href: string, label: string) =>
    `<li><a href="${href}"${href == current ? ' aria-current="page"' : ''}>${label}</a></li>`
  return `<nav aria-label="Owner pages">
<ul>
${item('/pups/apps', 'Apps')}
${item('/pups/homepage', 'Homepage')}
${site.comments ? item('/pups/comment-settings', 'Comments') : ''}
${item('/pups/password', 'Password')}
${site.subdomainMode ? '<li><form method="post" action="/pups/logout"><button type="submit">Log out</button></form></li>' : ''}
</ul>
</nav>`
}

const sameDomainWarning = (site: OwnerSite) => site.subdomainMode ? '' : `<p role="note">These pages share the origin of your website.
Any other web application on <strong>${h(site.ownerHost)}</strong>, such as a CMS, wiki or comment form, puts your login at risk,
and with it every app where you sign in with your domain. Use an auth subdomain if your domain runs anything but static files.</p>`

const newPasswordFields = (legend: string, required: boolean) => `<fieldset>
<legend>${h(legend)}</legend>
<label>New password (at least ${MIN_PASSWORD_LENGTH} characters)
<input type="password" name="new_password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}"${required ? ' required' : ''}></label>
<label>Repeat the new password
<input type="password" name="new_password2" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}"${required ? ' required' : ''}></label>
</fieldset>`

// --- Setup -----------------------------------------------------------------------------

/** Step 1 of the setup: the bootstrap secret; with `recover`, of the recovery: the recovery secret. */
export const secretForm = (site: OwnerSite, error?: string, recover = false) => recover ? page('Recover', `<h1>Recover your login</h1>
<p>Enter the recovery secret you set as <code>RECOVERY_SECRET</code>. The passkey or password you choose next replaces all your passkeys and your password.</p>
${alert(error)}
<form method="post">
<input type="hidden" name="step" value="secret">
<label>Recovery secret <input type="password" name="secret" autocomplete="off" required></label>
<p><button type="submit">Continue</button></p>
</form>`, { site: site.ownerHost, status: error ? 400 : 200 }) : page('Set up', `<h1>Set up your Personal Upload Server</h1>
<p>Enter the bootstrap secret you chose when you deployed this server. It works only once.</p>
${alert(error)}
<form method="post">
<input type="hidden" name="step" value="secret">
<label>Bootstrap secret <input type="password" name="secret" autocomplete="off" required></label>
<p><button type="submit">Continue</button></p>
</form>`, { site: site.ownerHost, status: error ? 400 : 200 })

/** The authorization endpoint before the setup: how to set up the server, then log in again. */
export const notSetUpPage = (site: OwnerSite) => page(t('title.notSetUp'), `<h1>${h(t('title.notSetUp'))}</h1>
<p>${t('notSetUp.intro', { host: `<strong>${h(site.ownerHost)}</strong>` })}</p>
<ol>
<li>${t('notSetUp.setUp', { setup: '/pups/setup', secret: t('notSetUp.bootstrapSecret') })}</li>
<li>${t('notSetUp.again')}</li>
</ol>`, { site: site.ownerHost, status: 503 })

/** Step 2 of the setup: a passkey, a password or both. `token` is the signed setup session. */
export const credentialForm = (site: OwnerSite, token: string, passkeyCreateOptions: object, error?: string) =>
  page('Set up', `<h1>Choose how you log in</h1>
<p>Passkeys are preferred: an abused passkey prompt works once, a stolen password until you change it.
While you have a passkey, only the passkey works. A password is kept for the day you lose your passkeys and they are removed.</p>
${alert(error)}
<form method="post">
<input type="hidden" name="setup" value="${h(token)}">
<input type="hidden" name="passkey_registration" value="">
<fieldset>
<legend>Passkey</legend>
<p><button type="button" data-passkey-create>Register a passkey and finish</button></p>
<p>A password entered below is kept, for the day you lose your passkey.</p>
</fieldset>
${newPasswordFields('Password', false)}
<p><button type="submit">Finish with the password only</button></p>
${jsonScript('passkey-create-options', passkeyCreateOptions)}
</form>`, { site: site.ownerHost, status: error ? 400 : 200 })

export interface SetupComplete {
  /** The URL of the configuration document. */
  configUrl: string
  issuer: string
  hasPasskey: boolean
  /** Who owns the domain's homepage (homepage.ts). */
  homepage?: HomepageKind
}

export const setupCompletePage = (site: OwnerSite, o: SetupComplete) => page('Setup complete', `<h1>Setup complete</h1>
<p>You are the owner of this Personal Upload Server. Apps can now find it from your domain, <strong>${h(site.ownerHost)}</strong>.</p>
<section aria-labelledby="discovery">
<h2 id="discovery">Check discovery</h2>
<p><a href="${h(site.ownerOrigin)}/.well-known/host-meta.json">${h(site.ownerOrigin)}/.well-known/host-meta.json</a>
links to the configuration document <a href="${h(o.configUrl)}">${h(o.configUrl)}</a>. Both should open in your browser.</p>
</section>
<p role="note">Your login now proves that you are <strong>${h(site.ownerHost)}</strong>. Anyone who gets it can sign in as you to
every app that uses “sign in with your domain”, not just change your files.${o.hasPasskey ? '' : ' Consider using a passkey.'}</p>
${sameDomainWarning(site)}
${o.homepage ? `<h2>Your homepage</h2>\n${homepageSummary(site, o.homepage)}` : ''}
<p><a href="${h(o.issuer)}/pups/apps">Manage your apps</a></p>`, { site: site.ownerHost })

/** After the recovery (/pups/recover): the new passkey or password replaced the old ones. */
export const recoveredPage = (site: OwnerSite, issuer: string) => page('Recovered', `<h1>Recovered</h1>
${status('Your new passkey or password replaced the old ones, and every session ended.')}
<p role="note">Remove the secret <code>RECOVERY_SECRET</code> now. It doesn't work a second time, and nobody should keep a secret that isn't needed.</p>
<p><a href="${h(issuer)}/pups/apps">Manage your apps</a></p>`, { site: site.ownerHost })

// --- Login -----------------------------------------------------------------------------

/** The login page (auth subdomain mode only). `returnTo` must already be checked. */
export const loginPage = (site: OwnerSite, returnTo: string, confirm: ConfirmOptions, error?: string) => page('Log in', `<h1>Log in</h1>
<p>Log in as the owner of <strong>${h(site.ownerHost)}</strong>.</p>
${alert(error)}
<form method="post" action="/pups/login">
<input type="hidden" name="return_to" value="${h(returnTo)}">
${confirmFields({ ...confirm, inline: true })}
<p><button type="submit">Log in</button></p>
</form>`, { site: site.ownerHost, status: error ? 401 : 200 })

// --- Apps ------------------------------------------------------------------------------

/** Same-domain mode without a page session: the apps page needs a fresh confirmation before it shows anything. */
export const unlockPage = (site: OwnerSite, confirm: ConfirmOptions, error?: string) => page('Your apps', `<h1>Your apps</h1>
<p>Confirm that you are the owner of <strong>${h(site.ownerHost)}</strong> to see the apps that can write to it.</p>
${alert(error)}
<form method="post" data-session>
${confirmFields(confirm)}
<p><button type="submit" name="show" value="1">Show my apps</button></p>
</form>`, { site: site.ownerHost, nav: ownerNav(site, '/pups/apps'), status: error ? 401 : 200 })

export interface AppRow {
  /** The grant's id. */
  id: string
  clientHost: string
  /** Self-declared by the app; sanitized here. */
  clientName?: string | null
  /** HTML of the permissions, from permissionList(). */
  permissions: string
  createdAt: number
  lastUsedAt: number | null
  /** Whether the app can have files in its own directory, which the owner may delete with it. */
  hasFiles: boolean
}

export interface LinkRow {
  rel: string
  href: string
}

export interface AppsPage {
  apps: AppRow[]
  links: LinkRow[]
  properties: [string, string][]
  /** Why host-meta.json couldn't be read, if it couldn't. */
  hostMetaError?: string
  /** Whether host-meta.json is stored, or the default is served. */
  hostMetaStored: boolean
  /** The storage used; missing if the server doesn't know it. */
  usedBytes?: number
  /** The storage quota; 0 or missing for none. */
  maxBytes?: number
  confirm: ConfirmOptions
  /** What the built-in receiver has put into the inbox, if it is on; the apps page shows the mentions. */
  inbox?: InboxSummary
  message?: string
  error?: string
}

function appRow(a: AppRow): string {
  const name = sanitizeText(a.clientName, 100)
  return `<tr>
<th scope="row">${h(a.clientHost)}${name ? `<br><small>“<bdi>${h(name)}</bdi>” (self-declared)</small>` : ''}</th>
<td>${a.permissions}</td>
<td>${time(a.createdAt)}</td>
<td>${time(a.lastUsedAt)}</td>
<td>
<button type="submit" name="revoke" value="${h(a.id)}">Remove</button>
${a.hasFiles ? `<button type="submit" name="revoke_delete" value="${h(a.id)}">Remove and delete its files</button>` : ''}
</td>
</tr>`
}

export function appsPage(site: OwnerSite, o: AppsPage): Response {
  const appsTable = o.apps.length ? `<table>
<thead><tr><th scope="col">App</th><th scope="col">Permissions</th><th scope="col">Approved</th><th scope="col">Last used</th><th scope="col">Actions</th></tr></thead>
<tbody>
${o.apps.map(appRow).join('\n')}
</tbody>
</table>` : '<p>No app has access to your domain.</p>'

  const linksTable = o.links.length ? `<table>
<caption>Links</caption>
<thead><tr><th scope="col">Relation</th><th scope="col">Target</th><th scope="col">Actions</th></tr></thead>
<tbody>
${o.links.map(l => `<tr>
<td><code>${h(visible(l.rel))}</code></td>
<td><code>${h(visible(l.href))}</code></td>
<td><button type="submit" name="remove_link" value="${h(JSON.stringify([l.rel, l.href]))}">Remove</button></td>
</tr>`).join('\n')}
</tbody>
</table>` : ''

  const propsTable = o.properties.length ? `<table>
<caption>Properties</caption>
<thead><tr><th scope="col">Property</th><th scope="col">Value</th><th scope="col">Actions</th></tr></thead>
<tbody>
${o.properties.map(([k, v]) => `<tr>
<td><code>${h(visible(k))}</code></td>
<td>${h(visible(v))}</td>
<td><button type="submit" name="remove_property" value="${h(k)}">Remove</button></td>
</tr>`).join('\n')}
</tbody>
</table>` : ''

  return page('Your apps', `<h1>Apps that can write to ${h(site.ownerHost)}</h1>
${status(o.message)}
${alert(o.error)}
${sameDomainWarning(site)}
<form method="post" data-session>
${confirmFields({ legend: 'Confirm changes', ...o.confirm })}
<p><button type="submit" name="show" value="1" data-view>Reload</button></p>
<section aria-labelledby="apps-heading">
<h2 id="apps-heading">Apps</h2>
<p>Removing an app ends its access at once. The files it stored stay published, unless you delete them too.</p>
${appsTable}
</section>
<section aria-labelledby="host-meta-heading">
<h2 id="host-meta-heading">Discovery file</h2>
<p>Apps can announce their files in <a href="${h(site.ownerOrigin)}/.well-known/host-meta.json">host-meta.json</a>.</p>
${alert(o.hostMetaError)}
${o.hostMetaStored ? '' : '<p>The file has not been stored yet; a default that points to this server is served.</p>'}
${linksTable}
${propsTable}
</section>
${o.inbox?.mentionsOn ? inboxSection({ ...o.inbox, commentsOn: false }) : ''}
${site.subdomainMode ? `<section aria-labelledby="sessions-heading">
<h2 id="sessions-heading">Sessions</h2>
<p><button type="submit" name="signout_all" value="1">Log out everywhere</button></p>
</section>` : ''}
</form>
${o.usedBytes == undefined ? '' : `<p>Storage used: ${(o.usedBytes / 1048576).toFixed(1)} MiB${o.maxBytes ? ` of ${(o.maxBytes / 1048576).toFixed(0)} MiB` : ''}.</p>`}`,
  { site: site.ownerHost, nav: ownerNav(site, '/pups/apps') })
}

// --- Comments --------------------------------------------------------------------------

export interface CommentsPage {
  /** What the receiver has put into the inbox; the page shows the comments. */
  inbox: InboxSummary
  moderation: ModerationView
  confirm: ConfirmOptions
  message?: string
  error?: string
}

/** /pups/comment-settings before the owner confirmed (same-domain mode without a page session). */
export const commentsUnlockPage = (site: OwnerSite, confirm: ConfirmOptions, error?: string) => page('Comments', `<h1>Comments</h1>
<p>Confirm that you are the owner of <strong>${h(site.ownerHost)}</strong> to change how comments are handled.</p>
${alert(error)}
<form method="post" data-session>
${confirmFields(confirm)}
<p><button type="submit" name="show" value="1">Continue</button></p>
</form>`, { site: site.ownerHost, nav: ownerNav(site, '/pups/comment-settings'), status: error ? 401 : 200 })

/** /pups/comment-settings, with comments on: the comments in the inbox, and auto-moderation. */
export const commentsPage = (site: OwnerSite, o: CommentsPage) => page('Comments', `<h1>Comments</h1>
${status(o.message)}
${alert(o.error)}
<form method="post" data-session>
${inboxSection({ ...o.inbox, mentionsOn: false })}
${moderationSection(o.moderation)}
${confirmFields({ legend: 'Confirm changes', ...o.confirm })}
<p><button type="submit" name="save_moderation" value="1">Save</button> <button type="submit" name="show" value="1" data-view>Reload</button></p>
</form>`, { site: site.ownerHost, nav: ownerNav(site, '/pups/comment-settings'), status: o.error ? 400 : 200 })

// --- Password --------------------------------------------------------------------------

export interface PasswordPage {
  hasPassword: boolean
  /** Passkey request options, if the owner has a passkey: then the password is only kept for the day it is lost. */
  passkeyOptions?: object
  message?: string
  error?: string
}

export function passwordPage(site: OwnerSite, o: PasswordPage): Response {
  const title = o.hasPassword ? 'Change your password' : 'Set a password'
  return page(title, `<h1>${title}</h1>
${o.passkeyOptions ? `<p>You have a passkey: you confirm with it, and the password is not accepted. The password is kept for the day you lose your passkeys.
After they were removed, with the recovery secret (see the README), you log in with it.</p>` : ''}
${status(o.message)}
${alert(o.error)}
<form method="post" data-session>
${newPasswordFields('New password', true)}
${confirmFields({
    passkeyOptions: o.passkeyOptions, hasPassword: o.hasPassword,
    legend: 'Confirm that it is you', passwordLabel: 'Current password',
  })}
<p><button type="submit">${o.hasPassword ? 'Change password' : 'Set password'}</button></p>
</form>`, { site: site.ownerHost, nav: ownerNav(site, '/pups/password'), status: o.error ? 400 : 200 })
}
