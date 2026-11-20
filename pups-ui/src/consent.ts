import { alert, confirmFields, type ConfirmOptions, escapeHtml as h, page } from './html'
import { sanitizeText } from './sanitize'
import { permissionGroups, type ScopeView } from './scopes'
import { t } from './texts'

export interface ConsentOptions {
  clientHost: string
  /** Self-declared by the app; sanitized again here. */
  clientName?: string | null
  logo?: string | null
  redirectUri: string
  ownerHost: string
  /** The requested scopes, parsed. */
  scopes: Map<string, ScopeView>
  /** Whether the owner has approved this client before. */
  approvedBefore: boolean
  /** The signed authorization request, sent back with the decision. */
  request: string
  /** The URL of the apps page, linked from the consent screen. Default: /pups/apps. */
  appsPage?: string
  /** The URL the form posts to. Default: /oauth/authorize. */
  action?: string
  /** Set if the owner must confirm with a passkey or the password. */
  confirm?: ConfirmOptions
  error?: string
  status?: number
}

const isLoopbackRedirect = (uri: string) => {
  const u = new URL(uri)
  return u.protocol == 'http:' && (u.hostname == '127.0.0.1' || u.hostname == '[::1]')
}

/** The consent screen (RFC-6 "Consent"). The form posts to /oauth/authorize. */
export function consentPage(o: ConsentOptions): Response {
  const scopes = [...o.scopes.values()]
  const identifyOnly = scopes.every(x => x.kind == 'identify')
  const name = sanitizeText(o.clientName, 100)
  const app = `<strong>${h(o.clientHost)}</strong>`, me = `<strong>${h(o.ownerHost)}</strong>`
  // A request with only read scopes doesn't write anything.
  const verb = t(scopes.some(x => x.kind == 'write') ? 'consent.verbWrite' : 'consent.verbAccess')
  const title = t(identifyOnly ? 'title.signIn' : 'title.allow', { app: o.clientHost, me: o.ownerHost, verb })

  const body = `<h1>${o.logo ? `<img src="${h(o.logo)}" alt="" width="32" height="32"> ` : ''}${h(o.clientHost)}</h1>
<p>${t('consent.didYouMean', { name: name ? `“<bdi>${h(name)}</bdi>”` : app })}</p>
<p>${identifyOnly ? t('consent.signIn', { app, me }) : t('consent.wants', { app, verb, me })}</p>
${o.approvedBefore ? '' : `<p role="note">${t('consent.newApp', { app })}</p>`}
${isLoopbackRedirect(o.redirectUri) ? `<p role="note">${t('consent.loopback', { address: `<code>${h(new URL(o.redirectUri).host)}</code>` })}</p>` : ''}
${alert(o.error)}
<form method="post" action="${h(o.action ?? '/oauth/authorize')}">
<input type="hidden" name="request" value="${h(o.request)}">
${identifyOnly ? `<p>${t('consent.learnDomain', { app, me })}</p>
<input type="hidden" name="scope" value="identify">` : `<fieldset>
<legend>${t('consent.mayThen', { app: h(o.clientHost) })}</legend>
${permissionGroups(o.scopes, o.ownerHost)}
</fieldset>
<p>${t('consent.footer', { appsPage: h(o.appsPage ?? '/pups/apps') })}</p>`}
${o.confirm ? confirmFields(o.confirm) : ''}
<p>
<button type="submit" name="decision" value="approve">${t('consent.approve')}</button>
<button type="submit" name="decision" value="deny" data-skip-confirm>${t('consent.deny')}</button>
</p>
</form>`
  return page(title, body, { site: o.ownerHost, formAction: [new URL(o.redirectUri).origin], status: o.status })
}
