import { isCspOrigin, visible } from './sanitize'
import { t } from './texts'

/**
 * HTML of the owner pages. Plain semantic markup without classes or inline styles; the look
 * comes from /pups/assets/owner.css, the passkey ceremonies from /pups/assets/owner.js
 * (both in public/). See the comment in owner.css for the structure.
 */

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const h = escapeHtml

export interface PageOptions {
  /** The owner's domain, shown in the header. */
  site?: string
  /** Navigation of the management pages. */
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
      'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src https: data:; ` +
        `form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
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
  legend?: string
  /** Label of the password field. */
  passwordLabel?: string
}

/**
 * The fieldset in which the owner confirms an action with a passkey or the password. With
 * a passkey, owner.js asks for it when the form is submitted with an empty password field.
 */
export function confirmFields(o: ConfirmOptions): string {
  const hint = t(o.passkeyOptions && o.hasPassword ? 'confirm.passkeyOrPassword' : o.passkeyOptions ? 'confirm.passkey' : 'confirm.password')
  return `<fieldset data-confirm>
<legend>${o.legend ? h(o.legend) : t('confirm.legend')}</legend>
<p>${hint}</p>
<input type="hidden" name="passkey" value="">
${o.hasPassword ? `<label>${o.passwordLabel ? h(o.passwordLabel) : t('confirm.passwordLabel')} <input type="password" name="password" autocomplete="current-password"></label>` : ''}
${o.passkeyOptions ? jsonScript('passkey-get-options', o.passkeyOptions) : ''}
</fieldset>`
}

/** A timestamp for tables. */
export const time = (ms: number | null) => ms
  ? `<time datetime="${new Date(ms).toISOString()}">${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC</time>`
  : 'never'
