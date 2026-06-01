const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client'
const SUPPORTED_LOCAL_ORIGINS = new Set([
  'http://127.0.0.1:4173',
  'http://localhost:4173',
])

let googleIdentityPromise = null
let googleIdentityInitializedClientId = ''
let googleIdentityCallback = null

export function getGoogleClientId() {
  return String(import.meta.env.VITE_GOOGLE_CLIENT_ID || '').trim()
}

export function getGoogleIdentityAvailability() {
  const clientId = getGoogleClientId()
  if (!clientId) {
    return {
      enabled: false,
      reason: 'missing-client-id',
    }
  }

  if (typeof window === 'undefined') {
    return {
      enabled: false,
      reason: 'browser-required',
    }
  }

  const origin = window.location.origin
  const isLocalOrigin = /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname)

  if (isLocalOrigin && !SUPPORTED_LOCAL_ORIGINS.has(origin)) {
    return {
      enabled: false,
      reason: 'unsupported-local-origin',
    }
  }

  return {
    enabled: true,
    reason: 'ok',
  }
}

export function loadGoogleIdentityScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('google-identity-browser-required'))
  if (window.google?.accounts?.id) return Promise.resolve(window.google)
  if (googleIdentityPromise) return googleIdentityPromise

  googleIdentityPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GOOGLE_IDENTITY_SCRIPT}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(window.google), { once: true })
      existing.addEventListener('error', () => reject(new Error('google-identity-load-failed')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = GOOGLE_IDENTITY_SCRIPT
    script.async = true
    script.defer = true
    script.onload = () => resolve(window.google)
    script.onerror = () => reject(new Error('google-identity-load-failed'))
    document.head.appendChild(script)
  })

  return googleIdentityPromise
}

async function ensureGoogleIdentityInitialized(callback) {
  const clientId = getGoogleClientId()
  const google = await loadGoogleIdentityScript()

  googleIdentityCallback = callback
  if (googleIdentityInitializedClientId === clientId) return google

  google.accounts.id.initialize({
    client_id: clientId,
    callback: (response) => googleIdentityCallback?.(response),
    auto_select: false,
    cancel_on_tap_outside: true,
  })

  googleIdentityInitializedClientId = clientId
  return google
}

export async function renderGoogleSignInButton(container, callback, options = {}) {
  const availability = getGoogleIdentityAvailability()
  if (!availability.enabled || !container) return false

  const google = await ensureGoogleIdentityInitialized(callback)
  container.innerHTML = ''
  google.accounts.id.renderButton(container, {
    theme: 'outline',
    size: 'large',
    text: options.text || 'continue_with',
    shape: 'rectangular',
    width: 360,
  })
  return true
}
