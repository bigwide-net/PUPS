// The only script of the PUPS owner pages. It runs WebAuthn ceremonies, asks for the password,
// and holds the page session; without it, the forms have a password field (passkeys don't
// work), and every page view is confirmed.
//
// - A form with `[data-confirm]` is confirmed when it is submitted: with the passkey, if the
//   page offers passkey options (the password is not accepted then), otherwise with the
//   password, asked for in a dialog. A filled password field in the page (the login page)
//   needs no dialog. Submit buttons with `data-skip-confirm` (e.g. Deny) and `data-view`
//   (e.g. Reload, which needs no confirmation with a session) submit without asking.
// - A button with `data-passkey-create` registers a new passkey (setup and sign-in pages);
//   in a form with `[data-confirm]` it first confirms as above.
// - The page session (RFC-6 "Deployment modes"): forms with `data-session` (the management
//   pages) are sent with fetch and the header PUPS-Session, the session or `new`. After a
//   confirmation, or with a valid session, the server answers with a renewed session in the
//   same header, and the answer replaces the page. The links of the owner navigation load
//   the same way while there is a session. The session lives in a variable of this script
//   only: never in a cookie or storage, so reloading the page or opening another tab needs a
//   new confirmation.
(() => {
  const HEADER = 'PUPS-Session'
  let session = null

  const b64u = {
    dec: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0)).buffer,
    enc: b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  }
  const options = id => {
    const el = document.getElementById(id)
    return el && JSON.parse(el.textContent)
  }
  const toJSON = cred => {
    if (cred.toJSON) return cred.toJSON()
    const r = cred.response
    const out = {
      id: cred.id, rawId: b64u.enc(cred.rawId), type: cred.type, response: {},
      clientExtensionResults: cred.getClientExtensionResults(), authenticatorAttachment: cred.authenticatorAttachment,
    }
    for (const k of ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle', 'attestationObject'])
      if (r[k]) out.response[k] = b64u.enc(r[k])
    if (r.getTransports) out.response.transports = r.getTransports()
    return out
  }
  const requestOptions = o => PublicKeyCredential.parseRequestOptionsFromJSON
    ? PublicKeyCredential.parseRequestOptionsFromJSON(o)
    : { ...o, challenge: b64u.dec(o.challenge), allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: b64u.dec(c.id) })) }
  const creationOptions = o => PublicKeyCredential.parseCreationOptionsFromJSON
    ? PublicKeyCredential.parseCreationOptionsFromJSON(o)
    : { ...o, challenge: b64u.dec(o.challenge), user: { ...o.user, id: b64u.dec(o.user.id) },
        excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: b64u.dec(c.id) })) }

  const showError = (form, message) => {
    let el = form.querySelector('[data-passkey-error]')
    if (!el) {
      el = document.createElement('p')
      el.setAttribute('role', 'alert')
      el.setAttribute('data-passkey-error', '')
      form.prepend(el)
    }
    el.textContent = message
  }

  // Asks for the password in a dialog. Resolves to the password, or null if cancelled.
  const askPassword = confirm => new Promise(resolve => {
    const dialog = document.createElement('dialog')
    dialog.innerHTML = '<form method="dialog"><h2></h2><label><span></span> <input type="password" name="password" autocomplete="current-password" required></label>' +
      '<p><button value="ok">Confirm</button> <button value="cancel" formnovalidate>Cancel</button></p></form>'
    dialog.querySelector('h2').textContent = confirm.dataset.legend || 'Confirm that it is you'
    dialog.querySelector('span').textContent = confirm.dataset.label || 'Password'
    const input = dialog.querySelector('input')
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue == 'ok' ? input.value : null)
      dialog.remove()
    })
    document.body.append(dialog)
    dialog.showModal()
  })

  // The confirmation of a form: {passkey} or {password}, {} if the page's password field is
  // filled, or null if the owner cancelled. Throws if the passkey didn't work.
  const confirmation = async (form, confirm) => {
    const typed = form.querySelector('input[name="password"]')
    if (typed && typed.value) return {}
    const getOptions = options('passkey-get-options')
    if (getOptions) return { passkey: JSON.stringify(toJSON(await navigator.credentials.get({ publicKey: requestOptions(getOptions) }))) }
    const password = await askPassword(confirm)
    return password == null ? null : { password }
  }

  // Loads an owner page with the session, and shows it in place of this one.
  const load = async (url, init, push, form) => {
    let res
    try {
      res = await fetch(url, { ...init, headers: { [HEADER]: session || 'new' }, cache: 'no-store' })
    } catch (err) {
      if (form) showError(form, `The server could not be reached (${err.message || err}).`)
      return
    }
    session = res.headers.get(HEADER)
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
    document.title = doc.title
    document.body.replaceWith(document.adoptNode(doc.body))
    // A parsed page has the content of noscript as elements: the password fields for pages without script.
    for (const n of document.querySelectorAll('noscript')) n.remove()
    history[push ? 'pushState' : 'replaceState'](null, '', res.url)
    scrollTo(0, 0)
    const first = document.querySelector('main [role=alert], main [role=status], main h1')
    if (first) {
      first.tabIndex = -1
      first.focus()
    }
  }

  // Submits the form as if `submitter` had been clicked, with the fields in `values` set.
  const send = (form, submitter, values) => {
    if (form.hasAttribute('data-session')) {
      const body = new URLSearchParams(new FormData(form))
      if (submitter && submitter.name) body.append(submitter.name, submitter.value)
      for (const [name, value] of Object.entries(values)) body.set(name, value)
      return load(new URL(form.getAttribute('action') || '', location.href), { method: 'POST', body }, false, form)
    }
    const hidden = (name, value) => {
      const i = document.createElement('input')
      i.type = 'hidden'
      i.name = name
      i.value = value
      form.append(i)
    }
    for (const [name, value] of Object.entries(values)) {
      const i = form.querySelector(`input[name="${name}"]`)
      if (i) i.value = value
      else hidden(name, value)
    }
    if (submitter && submitter.name) hidden(submitter.name, submitter.value)
    form.submit()
  }

  document.addEventListener('submit', async e => {
    const form = e.target
    const submitter = e.submitter
    const confirm = form.querySelector('[data-confirm]')
    const ask = confirm && !(submitter && (submitter.hasAttribute('data-skip-confirm') || submitter.hasAttribute('data-view')))
    if (!ask && !form.hasAttribute('data-session')) return
    e.preventDefault()
    if (!ask) return send(form, submitter, {})
    try {
      const values = await confirmation(form, confirm)
      if (values) send(form, submitter, values)
    } catch (err) {
      showError(form, `The passkey did not work (${err.message || err}).`)
    }
  })

  document.addEventListener('click', async e => {
    const link = e.target.closest && e.target.closest('nav[aria-label="Owner pages"] a[href]')
    if (link && session && !e.defaultPrevented && !e.button && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && link.origin == location.origin) {
      e.preventDefault()
      return load(link.href, {}, true)
    }
    const button = e.target.closest && e.target.closest('[data-passkey-create]')
    if (!button) return
    const form = button.form
    try {
      // Adding a passkey to an existing owner needs a confirmation first: one of the existing
      // passkeys, or the password.
      const confirm = form.querySelector('[data-confirm]')
      const values = confirm ? await confirmation(form, confirm) : {}
      if (!values) return
      values.passkey_registration = JSON.stringify(toJSON(await navigator.credentials.create({ publicKey: creationOptions(options('passkey-create-options')) })))
      send(form, null, values)
    } catch (err) {
      showError(form, `The passkey could not be registered (${err.message || err}).`)
    }
  })

  // Back and forward between pages loaded with the session.
  addEventListener('popstate', () => session ? load(location.href) : location.reload())
})()
