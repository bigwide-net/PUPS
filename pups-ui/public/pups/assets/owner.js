// The only script of the PUPS owner pages. It runs WebAuthn ceremonies and puts the result
// into a hidden form field; without it, the forms work with the password alone.
//
// - A form with a confirmation fieldset (`fieldset[data-confirm]`) asks for a passkey when it
//   is submitted with an empty password field, if the page offers passkey options. Submit
//   buttons with `data-skip-confirm` (e.g. Deny) submit without asking.
// - A button with `data-passkey-create` registers a new passkey (setup and sign-in pages);
//   in a form with a confirmation fieldset it first asks for an existing passkey, if needed.
(() => {
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

  // Submits the form as if `submitter` had been clicked, with a field set to `value`.
  const submitWith = (form, submitter, field, value) => {
    form.querySelector(`input[name="${field}"]`).value = JSON.stringify(value)
    if (submitter && submitter.name) {
      const i = document.createElement('input')
      i.type = 'hidden'
      i.name = submitter.name
      i.value = submitter.value
      form.append(i)
    }
    form.submit()
  }

  for (const fieldset of document.querySelectorAll('fieldset[data-confirm]')) {
    const form = fieldset.form || fieldset.closest('form')
    form.addEventListener('submit', async e => {
      const getOptions = options('passkey-get-options')
      const password = form.querySelector('input[name="password"]')
      if (!getOptions || (password && password.value) || (e.submitter && e.submitter.hasAttribute('data-skip-confirm'))) return
      e.preventDefault()
      try {
        const cred = await navigator.credentials.get({ publicKey: requestOptions(getOptions) })
        submitWith(form, e.submitter, 'passkey', toJSON(cred))
      } catch (err) {
        showError(form, `The passkey did not work (${err.message || err}).${password ? ' You can enter your password instead.' : ''}`)
      }
    })
  }

  for (const button of document.querySelectorAll('[data-passkey-create]')) {
    button.addEventListener('click', async () => {
      const form = button.form
      try {
        // Adding a passkey to an existing owner needs a confirmation first: the password, or
        // one of the existing passkeys.
        const getOptions = options('passkey-get-options')
        const password = form.querySelector('input[name="password"]')
        if (form.querySelector('fieldset[data-confirm]') && getOptions && !(password && password.value)) {
          const assertion = await navigator.credentials.get({ publicKey: requestOptions(getOptions) })
          form.querySelector('input[name="passkey"]').value = JSON.stringify(toJSON(assertion))
        }
        const cred = await navigator.credentials.create({ publicKey: creationOptions(options('passkey-create-options')) })
        submitWith(form, null, 'passkey_registration', toJSON(cred))
      } catch (err) {
        showError(button.form, `The passkey could not be registered (${err.message || err}).`)
      }
    })
  }
})()
