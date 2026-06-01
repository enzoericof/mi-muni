import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { defaultMunicipality, findMunicipality, makeMunicipalityRecord } from '../data/municipalities'
import * as guestStorage from './guestState'
import {
  createAppSession,
  createGoogleAppSession,
  deleteAppSession,
  fetchAppSession,
  registerDifusorSession,
} from './api'

const USER_KEY = 'mimuni:user'
const AUTH_HINT_KEY = 'mimuni:auth-hint'
const LEGACY_SESSION_KEY = 'mimuni:app-session'
const LEGACY_ACCESS_TOKEN_KEY = 'mimuni:access-token'
const MUNICIPALITY_KEY = 'mimuni:municipality'
const MUNICIPALITY_ONBOARDING_KEY = 'mimuni:municipality-onboarding-v1'
const MUNITA_CONVERSATION_PREFIX = 'mimuni:munita-conversation:'

const GUEST_QUESTION_LIMIT = 2

const AppContext = createContext(null)

function readUser() {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(USER_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.id || !parsed?.email) return null
    return parsed
  } catch (_error) {
    return null
  }
}

function persistUser(user) {
  if (typeof window === 'undefined') return
  try {
    if (user) {
      window.localStorage.setItem(USER_KEY, JSON.stringify(user))
    } else {
      window.localStorage.removeItem(USER_KEY)
    }
  } catch (_error) {
    // noop
  }
}

function readAuthHint() {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(AUTH_HINT_KEY) === 'true'
  } catch (_error) {
    return false
  }
}

function persistAuthHint(value) {
  if (typeof window === 'undefined') return
  try {
    if (value) {
      window.localStorage.setItem(AUTH_HINT_KEY, 'true')
    } else {
      window.localStorage.removeItem(AUTH_HINT_KEY)
    }
  } catch (_error) {
    // noop
  }
}

function clearLegacyAuthStorage() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(LEGACY_SESSION_KEY)
    window.localStorage.removeItem(LEGACY_ACCESS_TOKEN_KEY)
  } catch (_error) {
    // noop
  }
}

function readMunicipality() {
  if (typeof window === 'undefined') return defaultMunicipality
  try {
    const raw = window.localStorage.getItem(MUNICIPALITY_KEY)
    if (!raw) return defaultMunicipality
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw)
      return findMunicipality(parsed?.key, parsed)
    }
    return findMunicipality(raw)
  } catch (_error) {
    return defaultMunicipality
  }
}

function persistMunicipality(value) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MUNICIPALITY_KEY, JSON.stringify(makeMunicipalityRecord(value)))
  } catch (_error) {
    // noop
  }
}

function readMunicipalityOnboardingCompleted() {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(MUNICIPALITY_ONBOARDING_KEY) === 'true'
  } catch (_error) {
    return false
  }
}

function persistMunicipalityOnboardingCompleted(value) {
  if (typeof window === 'undefined') return
  try {
    if (value) {
      window.localStorage.setItem(MUNICIPALITY_ONBOARDING_KEY, 'true')
    } else {
      window.localStorage.removeItem(MUNICIPALITY_ONBOARDING_KEY)
    }
  } catch (_error) {
    // noop
  }
}

function clearMunitaConversations() {
  if (typeof window === 'undefined') return
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index)
      if (key?.startsWith(MUNITA_CONVERSATION_PREFIX)) {
        window.localStorage.removeItem(key)
      }
    }
  } catch (_error) {
    // noop
  }
}

export function AppProvider({ children }) {
  const [user, setUser] = useState(() => readUser())
  const [sessionId, setSessionId] = useState('')
  const [actionUsage, setActionUsage] = useState({})
  const [authStatus, setAuthStatus] = useState(() => (readAuthHint() ? 'checking' : 'idle'))
  const [municipality, setMunicipalityState] = useState(() => readMunicipality())
  const [municipalityOnboardingOpen, setMunicipalityOnboardingOpen] = useState(() => !readMunicipalityOnboardingCompleted())
  const [guestState, setGuestState] = useState(() => guestStorage.load())
  const [loginModalOpen, setLoginModalOpen] = useState(false)
  const [loginPromptMessage, setLoginPromptMessage] = useState(null)

  useEffect(() => {
    clearLegacyAuthStorage()
  }, [])

  useEffect(() => {
    persistUser(user)
  }, [user])

  useEffect(() => {
    persistAuthHint(Boolean(user))
  }, [user])

  useEffect(() => {
    if (!readAuthHint()) {
      setAuthStatus((current) => (current === 'checking' ? 'idle' : current))
      return undefined
    }

    let cancelled = false
    async function hydrateSession() {
      try {
        const session = await fetchAppSession()
        if (cancelled) return
        if (!session?.sessionId || !session?.user) {
          clearMunitaConversations()
          setSessionId('')
          setUser(null)
          setActionUsage({})
          persistAuthHint(false)
          setAuthStatus('idle')
          return
        }
        setSessionId(session.sessionId)
        setUser(session.user)
        setActionUsage(session.usage || {})
        setAuthStatus('ready')
      } catch (_error) {
        if (cancelled) return
        clearMunitaConversations()
        setSessionId('')
        setUser(null)
        setActionUsage({})
        persistAuthHint(false)
        setAuthStatus('idle')
      }
    }

    void hydrateSession()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    persistMunicipality(municipality)
  }, [municipality])

  useEffect(() => {
    persistMunicipalityOnboardingCompleted(!municipalityOnboardingOpen)
  }, [municipalityOnboardingOpen])

  const login = useCallback(async (credentials) => {
    setAuthStatus('checking')
    try {
      const session = await createAppSession(credentials)
      setSessionId(session.sessionId)
      setUser(session.user)
      setActionUsage(session.usage || {})
      persistAuthHint(true)
      setGuestState(guestStorage.reset())
      setLoginModalOpen(false)
      setLoginPromptMessage(null)
      setAuthStatus('ready')
      return session.user
    } catch (error) {
      setAuthStatus('idle')
      throw error
    }
  }, [])

  const loginWithGoogle = useCallback(async ({ credential, mode = 'login' }) => {
    setAuthStatus('checking')
    try {
      const session = await createGoogleAppSession({ credential, mode })
      setSessionId(session.sessionId)
      setUser(session.user)
      setActionUsage(session.usage || {})
      persistAuthHint(true)
      setGuestState(guestStorage.reset())
      setLoginModalOpen(false)
      setLoginPromptMessage(null)
      setAuthStatus('ready')
      return session.user
    } catch (error) {
      setAuthStatus('idle')
      throw error
    }
  }, [])

  const registerDifusor = useCallback(async (payload) => {
    setAuthStatus('checking')
    try {
      const session = await registerDifusorSession(payload)
      setSessionId(session.sessionId)
      setUser(session.user)
      setActionUsage(session.usage || {})
      persistAuthHint(true)
      setGuestState(guestStorage.reset())
      setLoginModalOpen(false)
      setLoginPromptMessage(null)
      setAuthStatus('ready')
      return session.user
    } catch (error) {
      setAuthStatus('idle')
      throw error
    }
  }, [])

  const logout = useCallback(async () => {
    const currentSessionId = sessionId
    clearMunitaConversations()
    setSessionId('')
    setUser(null)
    setActionUsage({})
    persistAuthHint(false)
    setAuthStatus('idle')
    try {
      await deleteAppSession(currentSessionId)
    } catch (_error) {
      // La limpieza local alcanza si el servidor no responde.
    }
    if (typeof window !== 'undefined') {
      window.history.pushState(null, '', '/')
    }
  }, [sessionId])

  const setMunicipality = useCallback((keyOrObject) => {
    const next = typeof keyOrObject === 'object' && keyOrObject?.key
      ? findMunicipality(keyOrObject.key, keyOrObject)
      : findMunicipality(keyOrObject)
    setMunicipalityState(next)
    setMunicipalityOnboardingOpen(false)
    return next
  }, [])

  const completeMunicipalityOnboarding = useCallback(() => {
    setMunicipalityOnboardingOpen(false)
  }, [])

  const incrementGuestQuestions = useCallback(() => {
    const next = guestStorage.increment()
    setGuestState(next)
    return next
  }, [])

  const updateActionUsage = useCallback((nextUsage = {}) => {
    setActionUsage((current) => ({
      ...current,
      ...(nextUsage || {}),
    }))
  }, [])

  const openLoginModal = useCallback((message = null) => {
    setLoginPromptMessage(message)
    setLoginModalOpen(true)
  }, [])

  const closeLoginModal = useCallback(() => {
    setLoginModalOpen(false)
    setLoginPromptMessage(null)
  }, [])

  const guestQuestionCount = guestState.questionCount
  const guestQuestionsRemaining = Math.max(0, GUEST_QUESTION_LIMIT - guestQuestionCount)
  const munitaAskQuota = actionUsage?.munita_ask || null
  const canAskQuestion = user ? (munitaAskQuota?.allowed ?? true) : guestQuestionCount < GUEST_QUESTION_LIMIT
  const canReport = Boolean(user)

  const value = useMemo(
    () => ({
      user,
      municipality,
      guestQuestionCount,
      guestQuestionsRemaining,
      guestQuestionLimit: GUEST_QUESTION_LIMIT,
      actionUsage,
      munitaAskQuota,
      sessionId,
      accessToken: '',
      authStatus,
      municipalityOnboardingOpen,
      canAskQuestion,
      canReport,
      login,
      loginWithGoogle,
      registerDifusor,
      logout,
      setMunicipality,
      completeMunicipalityOnboarding,
      incrementGuestQuestions,
      updateActionUsage,
      loginModalOpen,
      loginPromptMessage,
      openLoginModal,
      closeLoginModal,
    }),
    [
      user,
      municipality,
      guestQuestionCount,
      guestQuestionsRemaining,
      actionUsage,
      munitaAskQuota,
      sessionId,
      authStatus,
      municipalityOnboardingOpen,
      canAskQuestion,
      canReport,
      login,
      loginWithGoogle,
      registerDifusor,
      logout,
      setMunicipality,
      completeMunicipalityOnboarding,
      incrementGuestQuestions,
      updateActionUsage,
      loginModalOpen,
      loginPromptMessage,
      openLoginModal,
      closeLoginModal,
    ],
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useAppContext() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useAppContext must be used inside <AppProvider>')
  return ctx
}
