import { isCspOrigin, visible } from './sanitize'
import { t } from './texts'

/**
 * HTML of the owner pages. Plain semantic markup without classes or inline styles; the look
 * comes from /pups/assets/owner.css, the passkey ceremonies and the page session from
 * /pups/assets/owner.js (both in public/). See the comment in owner.css for the structure.
 *
 * Forms with `data-session` (the management pages) are sent by owner.js with the page session, and their answer replaces
 * the page; submit buttons with `data-view` only show the page again, which needs no confirmation with a session.
 */

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const h = escapeHtml

export interface PageOptions {
  /** The owner's domain, shown in the header. */
  site?: string
  /** Navigation of the management pages. Pages with it are also sent with `Cross-Origin-Opener-Policy: same-origin`. */
  nav?: string
  /** Extra form-action sources (the consent page redirects to the app after the POST). */
  formAction?: string[]
  status?: number
}

export function page(title: string, body: string, opts: PageOptions = {}): Response {
  // Only plain origins may enter the CSP header, so no value can add a directive.
  const formAction = ["'self'", ...(opts.formAction ?? []).filter(isCspOrigin)].join(' ')
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${h(title)}</title>
<link rel="stylesheet" href="/pups/assets/owner.css">
</head>
<body>
<header>
<p>Personal Upload Server${opts.site ? ` for <strong>${h(opts.site)}</strong>` : ''}</p>
${opts.nav ?? ''}
</header>
<main>
${body}
</main>
<script src="/pups/assets/owner.js" defer></script>
</body>
</html>
`, {
    status: opts.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; ` +
        `form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      // The management pages may hold a page session (owner.js): no page that opened them keeps a handle on them.
      ...opts.nav && { 'cross-origin-opener-policy': 'same-origin' },
    },
  })
}

export const alert = (message?: string) => message ? `<p role="alert">${h(visible(message))}</p>` : ''
export const status = (message?: string) => message ? `<p role="status">${h(visible(message))}</p>` : ''

export const errorPage = (title: string, message: string, code = 400) =>
  page(title, `<h1>${h(title)}</h1>\n${alert(message)}`, { status: code })

/** Embeds JSON for the page script. */
export const jsonScript = (id: string, value: unknown) =>
  `<script type="application/json" id="${id}">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`

export interface ConfirmOptions {
  /** Passkey request options (for navigator.credentials.get), if the owner has a passkey. */
  passkeyOptions?: object
  hasPassword: boolean
  /** The title of the password dialog and fieldset. */
  legend?: string
  /** Label of the password field. */
  passwordLabel?: string
  /** The password field is part of the page, also with JavaScript (the login page). */
  inline?: boolean
}

/**
 * How the owner confirms a form (`[data-confirm]`). With a passkey, the page shows nothing: owner.js asks for the
 * passkey when the form is submitted, and the server doesn't accept the password (RFC-6 "Owner authentication").
 * Without one, owner.js asks for the password in a dialog; the page has a password field only without JavaScript
 * (`noscript`), or with `inline`.
 */
export function confirmFields(o: ConfirmOptions): string {
  if (o.passkeyOptions) return `<div data-confirm hidden>
<input type="hidden" name="passkey" value="">
${jsonScript('passkey-get-options', o.passkeyOptions)}
</div>
<noscript><p>${t('confirm.passkeyNeedsScript')}</p></noscript>`
  if (!o.hasPassword) return ''
  const legend = o.legend ? h(o.legend) : t('confirm.legend')
  const label = o.passwordLabel ? h(o.passwordLabel) : t('confirm.passwordLabel')
  const field = `<fieldset>
<legend>${legend}</legend>
<label>${label} <input type="password" name="password" autocomplete="current-password"${o.inline ? ' required' : ''}></label>
</fieldset>`
  return `<div data-confirm data-legend="${legend}" data-label="${label}">
${o.inline ? field : `<noscript>${field}</noscript>`}
</div>`
}

/** A timestamp for tables. */
export const time = (ms: number | null) => ms
  ? `<time datetime="${new Date(ms).toISOString()}">${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC</time>`
  : 'never'
