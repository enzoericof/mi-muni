import { useEffect, useMemo, useRef, useState } from 'react'
import MunitaAvatar from './MunitaAvatar'

function formatMessageDateTime(value) {
  if (!value) return ''
  try {
    const date = new Date(value)
    const day = String(date.getDate()).padStart(2, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const year = String(date.getFullYear()).slice(-2)
    const hour = String(date.getHours()).padStart(2, '0')
    const minute = String(date.getMinutes()).padStart(2, '0')
    return `${day}/${month}/${year}, ${hour}:${minute}`
  } catch (_error) {
    return ''
  }
}

function AssistantMessage({ message }) {
  const [visibleSummary, setVisibleSummary] = useState(message.animate ? '' : message.summary || '')
  const [visibleAction, setVisibleAction] = useState(message.animate ? '' : message.action || '')
  const [animationDone, setAnimationDone] = useState(!message.animate)

  useEffect(() => {
    if (message.loading) {
      setVisibleSummary('Buscando en fuentes municipales...')
      setVisibleAction('')
      setAnimationDone(false)
      return undefined
    }

    if (!message.animate) {
      setVisibleSummary(message.summary || '')
      setVisibleAction(message.action || '')
      setAnimationDone(true)
      return undefined
    }

    const fullSummary = message.summary || ''
    const fullAction = message.action || ''
    let summaryIndex = 0
    let actionIndex = 0

    setVisibleSummary('')
    setVisibleAction('')
    setAnimationDone(false)

    const timer = window.setInterval(() => {
      if (summaryIndex < fullSummary.length) {
        summaryIndex += Math.max(1, Math.ceil(fullSummary.length / 80))
        setVisibleSummary(fullSummary.slice(0, summaryIndex))
        return
      }

      if (actionIndex < fullAction.length) {
        actionIndex += Math.max(1, Math.ceil(fullAction.length / 80))
        setVisibleAction(fullAction.slice(0, actionIndex))
        return
      }

      setAnimationDone(true)
      window.clearInterval(timer)
    }, 22)

    return () => window.clearInterval(timer)
  }, [message])

  const isAssistant = message.role !== 'user'
  const userInitial = message.profileInitial || 'I'
  const userLabel = message.profileName || 'Invitado'
  const primaryCitation = message.citations?.find((citation) => citation?.url) || (
    message.sourceUrl ? { url: message.sourceUrl, titulo: message.source || 'Fuente oficial' } : null
  )
  const showSources = isAssistant && !message.loading && animationDone && primaryCitation?.url
  const messageDateTime = formatMessageDateTime(message.createdAt)

  return (
    <article
      className={`assistant-bubble ${message.role === 'user' ? 'assistant-bubble-user' : 'assistant-bubble-bot'}`}
    >
      <div className="bubble-meta">
        <span className="bubble-avatar" aria-label={message.role === 'user' ? userLabel : 'Munita'}>
          {message.role === 'user' ? userInitial : <MunitaAvatar className="munita-avatar-inline" />}
        </span>
        <span className="bubble-who">{message.role === 'user' ? userLabel : 'Munita'}</span>
      </div>
      {message.title && message.role !== 'user' ? <strong className="bubble-title">{message.title}</strong> : null}
      <p className="bubble-summary">{visibleSummary}</p>
      {visibleAction ? <p className="bubble-action">{visibleAction}</p> : null}
      {messageDateTime ? <time className="bubble-timestamp" dateTime={message.createdAt}>{messageDateTime}</time> : null}

      {showSources ? (
        <div className="bubble-sources">
          <span className="bubble-source-label">Fuente</span>
          <a
            href={primaryCitation.url}
            target="_blank"
            rel="noreferrer"
            className="bubble-source-link"
          >
            {primaryCitation.titulo || primaryCitation.title || primaryCitation.label || 'Fuente oficial'}
          </a>
        </div>
      ) : null}
    </article>
  )
}

function AssistantPanel({ query, onQueryChange, onSubmit, state, messages, municipality }) {
  const chatRef = useRef(null)
  const visibleMessages = useMemo(
    () => messages.filter((message) => message.id !== 'assistant-welcome'),
    [messages],
  )

  useEffect(() => {
    const node = chatRef.current
    if (!node) return
    node.scrollTop = node.scrollHeight
  }, [visibleMessages])

  return (
    <section className="assistant-card">
      <div className="assistant-card-head">
        <div className="assistant-card-title-row">
          <MunitaAvatar className="assistant-card-avatar" />
          <div>
            <span className="section-eyebrow">Munita</span>
            <p>Tu IA para orientarte con trámites, servicios y consultas municipales de {municipality?.label || 'Asunción'}.</p>
          </div>
        </div>
        <p>Escribí tu consulta y Munita te ayuda a encontrar información municipal según la ciudad seleccionada.</p>
      </div>

      <div className="assistant-body">
        <div
          ref={chatRef}
          className={`assistant-chat ${visibleMessages.length ? '' : 'assistant-chat-empty'}`}
          aria-live="polite"
        >
          {visibleMessages.length
            ? visibleMessages.map((message) => <AssistantMessage key={message.id} message={message} />)
            : (
              <div className="assistant-empty-state">
                <strong>¿Qué querés resolver hoy?</strong>
                <span>Preguntá por requisitos, pasos, pagos, horarios o dónde consultar una gestión municipal.</span>
              </div>
            )}
        </div>

        <form
          className="assistant-form"
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
        >
          <div className="assistant-input-row">
            <input
              id="assistant-query"
              type="text"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Ej.: ¿Qué necesito para habilitar un comercio?"
            />
            <button type="submit" className="btn-primary" disabled={state === 'thinking'}>
              {state === 'thinking' ? 'Pensando' : 'Enviar'}
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}

export default AssistantPanel
