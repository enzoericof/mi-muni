import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppContext } from '../../lib/AppContext'
import { getGoogleIdentityAvailability, renderGoogleSignInButton } from '../../lib/googleIdentity'

const INITIAL_REGISTER_FORM = {
  name: '',
  email: '',
  password: '',
  confirmPassword: '',
  phone: '',
}

function LoginModal() {
  const { loginModalOpen, loginPromptMessage, login, loginWithGoogle, registerDifusor, closeLoginModal } = useAppContext()
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [registerForm, setRegisterForm] = useState(INITIAL_REGISTER_FORM)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState('idle')
  const dialogRef = useRef(null)
  const googleButtonRef = useRef(null)
  const googleIdentity = getGoogleIdentityAvailability()
  const googleEnabled = googleIdentity.enabled

  const resetState = useCallback(() => {
    setMode('login')
    setEmail('')
    setPassword('')
    setRegisterForm(INITIAL_REGISTER_FORM)
    setError(null)
    setStatus('idle')
  }, [])

  useEffect(() => {
    if (!loginModalOpen) {
      resetState()
      return undefined
    }

    const handleKey = (event) => {
      if (event.key === 'Escape') closeLoginModal()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [loginModalOpen, closeLoginModal, resetState])

  const handleGoogleCredential = useCallback(
    async (response) => {
      if (!response?.credential) {
        setError('No recibimos la credencial de Google.')
        return
      }

      setStatus('google')
      setError(null)
      try {
        await loginWithGoogle({ credential: response.credential, mode })
      } catch (googleError) {
        setStatus('idle')
        setError(googleError.message || 'No se pudo iniciar sesión con Google.')
      }
    },
    [loginWithGoogle, mode],
  )

  useEffect(() => {
    if (!loginModalOpen || !googleEnabled || !googleButtonRef.current) return undefined

    let cancelled = false
    renderGoogleSignInButton(
      googleButtonRef.current,
      (response) => {
        if (!cancelled) void handleGoogleCredential(response)
      },
      {
        text: mode === 'register' ? 'signup_with' : 'continue_with',
      },
    ).catch(() => {
      if (!cancelled) setError('No pudimos cargar Google Sign-In.')
    })

    return () => {
      cancelled = true
      if (googleButtonRef.current) googleButtonRef.current.innerHTML = ''
    }
  }, [googleEnabled, handleGoogleCredential, loginModalOpen, mode])

  if (!loginModalOpen) return null

  const googleHelperText =
    googleIdentity.reason === 'unsupported-local-origin'
      ? 'Google Sign-In en local está habilitado solo en http://127.0.0.1:4173.'
      : 'Configura VITE_GOOGLE_CLIENT_ID para activar el acceso con Google.'

  const handleSubmit = async (event) => {
    event.preventDefault()
    const trimmedEmail = email.trim()
    const trimmedPassword = password.trim()
    if (!trimmedEmail || !trimmedPassword) {
      setError('Ingresa email y contraseña para continuar.')
      return
    }
    if (!/^\S+@\S+\.\S+$/.test(trimmedEmail)) {
      setError('Ingresa un email válido.')
      return
    }

    setStatus('loading')
    setError(null)
    try {
      await login({ email: trimmedEmail, password: trimmedPassword })
    } catch (loginError) {
      setStatus('idle')
      setError(loginError.message || 'No se pudo iniciar sesión.')
    }
  }

  const handleRegisterSubmit = async (event) => {
    event.preventDefault()
    const payload = {
      name: registerForm.name.trim(),
      email: registerForm.email.trim(),
      password: registerForm.password.trim(),
      confirmPassword: registerForm.confirmPassword.trim(),
      phone: registerForm.phone.trim(),
    }

    if (!payload.name || !payload.email || !payload.password || !payload.confirmPassword) {
      setError('Completa nombre, email y contraseña para crear la cuenta.')
      return
    }
    if (!/^\S+@\S+\.\S+$/.test(payload.email)) {
      setError('Ingresa un email válido.')
      return
    }
    if (payload.password.length < 6) {
      setError('La contraseña debe tener al menos 6 caracteres.')
      return
    }
    if (payload.password !== payload.confirmPassword) {
      setError('Las contraseñas no coinciden.')
      return
    }

    setStatus('registering')
    setError(null)
    try {
      await registerDifusor({
        name: payload.name,
        email: payload.email,
        password: payload.password,
        phone: payload.phone,
      })
    } catch (registerError) {
      setStatus('idle')
      setError(registerError.message || 'No se pudo crear la cuenta.')
    }
  }

  const switchMode = (nextMode) => {
    setMode(nextMode)
    setError(null)
    setStatus('idle')
  }

  return (
    <div
      className="login-modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeLoginModal()
      }}
    >
      <div className="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-modal-title" ref={dialogRef}>
        <button type="button" className="login-modal-close" onClick={closeLoginModal} aria-label="Cerrar">
          {'\u00d7'}
        </button>

        <h2 id="login-modal-title">{mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}</h2>
        <p className="login-modal-lede">
          {mode === 'login'
            ? 'Entra con tu cuenta para continuar en Mi Muni.'
            : 'Registrate como difusor para reportar y confirmar incidencias ciudadanas.'}
        </p>

        {loginPromptMessage && <div className="login-modal-prompt">{loginPromptMessage}</div>}
        {status === 'google' && (
          <div className="login-modal-status" role="status">
            {mode === 'register' ? 'Creando tu cuenta con Google...' : 'Validando tu cuenta de Google...'}
          </div>
        )}
        {error && <div className="login-modal-error" role="alert">{error}</div>}

        {mode === 'login' ? (
          <>
            <form className="login-modal-form" onSubmit={handleSubmit} noValidate>
              <label className="login-modal-field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="tu@email.com"
                  autoComplete="email"
                />
              </label>

              <label className="login-modal-field">
                <span>Contraseña</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Tu contraseña"
                  autoComplete="current-password"
                />
              </label>

              <div className="login-modal-actions">
                <button type="button" className="btn-ghost" onClick={closeLoginModal} disabled={status !== 'idle'}>
                  Cancelar
                </button>
                <button type="submit" className="btn-primary" disabled={status !== 'idle'}>
                  {status === 'loading' ? 'Entrando...' : status === 'google' ? 'Conectando...' : 'Entrar'}
                </button>
              </div>
            </form>

            <div className="login-modal-divider"><span>o continúa con Google</span></div>

            <div className="login-modal-google">
              {googleEnabled ? (
                <div ref={googleButtonRef} className="login-modal-google-button" />
              ) : (
                <button type="button" className="login-modal-google-fallback" disabled>
                  Continuar con Google
                </button>
              )}
              {!googleEnabled && (
                <small>{googleHelperText}</small>
              )}
            </div>

            <button type="button" className="login-modal-switch" onClick={() => switchMode('register')}>
              Crear cuenta nueva
            </button>
          </>
        ) : (
          <>
            <form className="login-modal-form" onSubmit={handleRegisterSubmit} noValidate>
              <label className="login-modal-field">
                <span>Nombre</span>
                <input
                  type="text"
                  value={registerForm.name}
                  onChange={(event) => setRegisterForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Tu nombre"
                  autoComplete="name"
                />
              </label>

              <label className="login-modal-field">
                <span>Email</span>
                <input
                  type="email"
                  value={registerForm.email}
                  onChange={(event) => setRegisterForm((current) => ({ ...current, email: event.target.value }))}
                  placeholder="tu@email.com"
                  autoComplete="email"
                />
              </label>

              <label className="login-modal-field">
                <span>Contraseña</span>
                <input
                  type="password"
                  value={registerForm.password}
                  onChange={(event) => setRegisterForm((current) => ({ ...current, password: event.target.value }))}
                  placeholder="Mínimo 6 caracteres"
                  autoComplete="new-password"
                />
              </label>

              <label className="login-modal-field">
                <span>Repetir contraseña</span>
                <input
                  type="password"
                  value={registerForm.confirmPassword}
                  onChange={(event) => setRegisterForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                  placeholder="Repite tu contraseña"
                  autoComplete="new-password"
                />
              </label>

              <label className="login-modal-field">
                <span>Teléfono opcional</span>
                <input
                  type="tel"
                  value={registerForm.phone}
                  onChange={(event) => setRegisterForm((current) => ({ ...current, phone: event.target.value }))}
                  placeholder="+595..."
                  autoComplete="tel"
                />
              </label>

              <div className="login-modal-actions">
                <button type="button" className="btn-ghost" onClick={() => switchMode('login')} disabled={status !== 'idle'}>
                  Volver
                </button>
                <button type="submit" className="btn-primary" disabled={status !== 'idle'}>
                  {status === 'registering' ? 'Creando...' : 'Crear cuenta'}
                </button>
              </div>
            </form>

            <div className="login-modal-divider"><span>o registrate con Google</span></div>

            <div className="login-modal-google login-modal-google-register">
              {googleEnabled ? (
                <div ref={googleButtonRef} className="login-modal-google-button" />
              ) : (
                <button type="button" className="login-modal-google-fallback" disabled>
                  Registrarse con Google
                </button>
              )}
              {!googleEnabled && (
                <small>{googleHelperText}</small>
              )}
            </div>
          </>
        )}

        <small className="login-modal-foot">
          Las cuentas nuevas se crean como difusor para reportar y confirmar incidencias ciudadanas.
        </small>
      </div>
    </div>
  )
}

export default LoginModal
