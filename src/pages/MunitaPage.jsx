import { useEffect, useMemo, useRef, useState } from 'react'
import Header from '../components/layout/Header'
import Footer from '../components/layout/Footer'
import AssistantPanel from '../components/search/AssistantPanel'
import { askMunicipalAssistant } from '../lib/api'
import { useAppContext } from '../lib/AppContext'
import { useHashRoute } from '../lib/router'
import { navigation, makeNavigate } from '../lib/navigation'

const MUNITA_CONVERSATION_KEY = 'mimuni:munita-conversation'
const MAX_STORED_MESSAGES = 40

function getMunitaConversationKey({ sessionId, user }) {
  if (sessionId) return `${MUNITA_CONVERSATION_KEY}:session:${sessionId}`
  return `${MUNITA_CONVERSATION_KEY}:guest:${user?.id || user?.email || 'anonymous'}`
}

function normalizeStoredMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages
    .filter((message) => message && !message.loading)
    .map(({ animate: _animate, loading: _loading, ...message }) => message)
    .slice(-MAX_STORED_MESSAGES)
}

function readStoredConversation(storageKey) {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return normalizeStoredMessages(parsed?.messages)
  } catch (_error) {
    return []
  }
}

function persistStoredConversation(storageKey, messages) {
  if (typeof window === 'undefined') return
  try {
    const safeMessages = normalizeStoredMessages(messages)
    if (!safeMessages.length) {
      window.localStorage.removeItem(storageKey)
      return
    }
    window.localStorage.setItem(storageKey, JSON.stringify({ messages: safeMessages }))
  } catch (_error) {
    // La conversación sigue disponible en memoria aunque el navegador no permita persistirla.
  }
}

function MunitaPage() {
  const {
    municipality,
    sessionId,
    user,
    canAskQuestion,
    munitaAskQuota,
    guestQuestionLimit,
    guestQuestionsRemaining,
    incrementGuestQuestions,
    updateActionUsage,
    openLoginModal,
  } = useAppContext()
  const { params, navigate } = useHashRoute()
  const handleNavigate = makeNavigate(navigate)
  const autoQueryHandledRef = useRef('')
  const skipNextPersistRef = useRef(false)
  const conversationStorageKey = useMemo(
    () => getMunitaConversationKey({ sessionId, user }),
    [sessionId, user?.id, user?.email],
  )

  const [assistantQuery, setAssistantQuery] = useState('')
  const [assistantState, setAssistantState] = useState('ready')
  const [assistantMessages, setAssistantMessages] = useState([])
  const [conversationHydrated, setConversationHydrated] = useState(false)

  useEffect(() => {
    setConversationHydrated(false)
    const storedMessages = readStoredConversation(conversationStorageKey)
    skipNextPersistRef.current = true
    setAssistantMessages(storedMessages)
    setAssistantState(storedMessages.length ? 'answered' : 'ready')
    setConversationHydrated(true)
  }, [conversationStorageKey])

  useEffect(() => {
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false
      return
    }
    persistStoredConversation(conversationStorageKey, assistantMessages)
  }, [assistantMessages, conversationStorageKey])

  const submitAssistantQuery = async (rawQuery) => {
    const trimmedQuery = rawQuery.trim()
    if (!trimmedQuery) return

    if (!canAskQuestion) {
      setAssistantQuery('')
      if (!user) {
        openLoginModal(`Llegaste al límite de ${guestQuestionLimit} consultas como invitado. Iniciá sesión para seguir preguntando.`)
      }
      return
    }

    const timestamp = Date.now()
    const userMessage = {
      id: `user-${timestamp}`,
      role: 'user',
      summary: trimmedQuery,
      citations: [],
      createdAt: new Date(timestamp).toISOString(),
      profileName: user?.name || 'Invitado',
      profileInitial: (user?.name || user?.email || 'I').trim().charAt(0).toUpperCase(),
    }
    const loadingMessageId = `assistant-${timestamp}`
    const assistantCreatedAt = new Date().toISOString()

    setAssistantMessages((prev) => [
      ...prev,
      userMessage,
      {
        id: loadingMessageId,
        role: 'assistant',
        title: 'Munita',
        summary: '',
        action: '',
        citations: [],
        createdAt: assistantCreatedAt,
        loading: true,
      },
    ])
    setAssistantState('thinking')
    setAssistantQuery('')

    try {
      const result = await askMunicipalAssistant(trimmedQuery, {
        municipalitySlug: municipality?.key || '',
        municipalityName: municipality?.label || '',
      })
      const answer = result.answer

      if (result.usage) {
        updateActionUsage(result.usage)
      }

      if (!user) {
        incrementGuestQuestions()
      }

      setAssistantMessages((prev) =>
        prev.map((message) =>
          message.id === loadingMessageId
            ? {
                id: loadingMessageId,
                role: 'assistant',
                title: answer.title || 'Munita',
                summary: answer.summary,
                action: answer.grounded ? answer.action : '',
                citations: (answer.citations ?? []).slice(0, 1),
                source: answer.grounded ? answer.source : null,
                sourceUrl: answer.grounded ? answer.sourceUrl : null,
                createdAt: message.createdAt || new Date().toISOString(),
                animate: true,
              }
            : message,
        ),
      )

      setAssistantState('answered')
    } catch (error) {
      if (error?.payload?.usage) {
        updateActionUsage(error.payload.usage)
      }

      setAssistantMessages((prev) =>
        prev.map((message) =>
          message.id === loadingMessageId
            ? {
                id: loadingMessageId,
                role: 'assistant',
                title: 'Munita',
                summary:
                  error?.code === 'action-limit-exceeded'
                    ? (error.message || 'Llegaste al límite diario de consultas para Munita.')
                    : 'No pude consultar la información municipal en este momento.',
                action:
                  error?.code === 'action-limit-exceeded'
                    ? 'Podés volver a intentar mañana o ajustar esta política si querés otro límite.'
                    : 'Verificá si el backend local está corriendo en el puerto 8787.',
                citations: [],
                createdAt: message.createdAt || new Date().toISOString(),
                animate: true,
              }
            : message,
        ),
      )
      setAssistantState('error')
    }
  }

  const handleAssistantSubmit = () => submitAssistantQuery(assistantQuery)

  useEffect(() => {
    if (!conversationHydrated) return
    const incoming = params.q
    if (!incoming) return
    if (autoQueryHandledRef.current === incoming) return
    autoQueryHandledRef.current = incoming
    submitAssistantQuery(incoming)
    navigate('/munita', { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationHydrated, params.q])

  return (
    <div className="municipal-app municipal-app-munita">
      <div className="ambient ambient-left" aria-hidden="true" />
      <div className="ambient ambient-right" aria-hidden="true" />
      <div className="grid-haze" aria-hidden="true" />

      <Header activeSection="munita" navigation={navigation} onNavigate={handleNavigate} />

      <main className="page-shell page-shell-tramites page-shell-munita">
        <section className="content-section content-section-support">
          <div className="section-heading">
            <span className="section-eyebrow section-pill">Munita</span>
            <h2>Hablá con Munita si tenés preguntas</h2>
          </div>

          {!user && (
            <div className="quota-banner">
              {guestQuestionsRemaining > 0
                ? `Modo invitado: ${guestQuestionsRemaining} ${guestQuestionsRemaining === 1 ? 'consulta restante' : 'consultas restantes'}.`
                : 'Llegaste al límite de consultas como invitado. Iniciá sesión para continuar.'}
              {' '}
              <button type="button" className="link-button" onClick={() => openLoginModal()}>
                Iniciar sesión
              </button>
            </div>
          )}
          {user && munitaAskQuota && !munitaAskQuota.unlimited && (
            <div className="quota-banner">
              {munitaAskQuota.remainingToday > 0
                ? `Te quedan ${munitaAskQuota.remainingToday} ${munitaAskQuota.remainingToday === 1 ? 'consulta' : 'consultas'} a Munita por hoy.`
                : `Llegaste al límite diario de ${munitaAskQuota.dailyLimit} ${munitaAskQuota.dailyLimit === 1 ? 'consulta' : 'consultas'} para Munita.`}
            </div>
          )}
          <AssistantPanel
            query={assistantQuery}
            onQueryChange={setAssistantQuery}
            onSubmit={handleAssistantSubmit}
            state={assistantState}
            messages={assistantMessages}
            user={user}
            municipality={municipality}
          />
        </section>
      </main>

      <Footer city={municipality} navigation={navigation} onNavigate={handleNavigate} />
    </div>
  )
}

export default MunitaPage
