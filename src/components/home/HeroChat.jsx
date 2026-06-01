import { useState } from 'react'
import { useHashRoute } from '../../lib/router'
import { useAppContext } from '../../lib/AppContext'
import MunitaAvatar from '../search/MunitaAvatar'
import MunitaCharacter from '../search/MunitaCharacter'

function HeroChat() {
  const { navigate } = useHashRoute()
  const { user, canAskQuestion, guestQuestionsRemaining, guestQuestionLimit, munitaAskQuota, openLoginModal } = useAppContext()
  const [query, setQuery] = useState('')

  const handleSubmit = (event) => {
    event.preventDefault()
    const trimmed = query.trim()
    if (!trimmed) return
    if (!canAskQuestion) {
      if (!user) {
        openLoginModal(`Llegaste al límite de ${guestQuestionLimit} consultas como invitado. Iniciá sesión para seguir preguntando.`)
      }
      return
    }
    navigate('/munita', { params: { q: trimmed } })
  }

  return (
    <div className="hero-command-panel">
      <div className="hero-chat-intro">
        <MunitaAvatar className="hero-munita-avatar" />
        <div className="hero-chat-copy">
          <strong>¡Munita está para ayudarte!</strong>
          <span>Chateá con Munita si tenés dudas.</span>
        </div>
      </div>

      <MunitaCharacter className="hero-munita-character" />

      <form className="hero-chat-form hero-command-form" onSubmit={handleSubmit}>
        <div className="hero-chat-row hero-command-row">
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Pregúntale a Munita..."
            aria-label="Consulta para Munita"
          />
          <button type="submit" className="btn-primary hero-cta-button">Consultar</button>
        </div>
      </form>

      {!user && (
        <small className="hero-chat-quota">
          {guestQuestionsRemaining > 0
            ? `Te ${guestQuestionsRemaining === 1 ? 'queda' : 'quedan'} ${guestQuestionsRemaining} ${guestQuestionsRemaining === 1 ? 'consulta' : 'consultas'} como invitado.`
            : 'Llegaste al límite de consultas. Iniciá sesión para seguir.'}
        </small>
      )}
      {user && munitaAskQuota && !munitaAskQuota.unlimited && (
        <small className="hero-chat-quota">
          {munitaAskQuota.remainingToday > 0
            ? `Munita hoy: ${munitaAskQuota.remainingToday} ${munitaAskQuota.remainingToday === 1 ? 'consulta restante' : 'consultas restantes'}.`
            : 'Munita hoy: sin consultas restantes.'}
        </small>
      )}
    </div>
  )
}

export default HeroChat
