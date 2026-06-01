import { useEffect, useState } from 'react'
import Header from '../components/layout/Header'
import { useAppContext } from '../lib/AppContext'
import { fetchDifusorProfile } from '../lib/api'
import { makeNavigate, navigation } from '../lib/navigation'
import { getUserRoles, userHasRole } from '../lib/roles'
import { useHashRoute } from '../lib/router'

function ProfileGate() {
  const { openLoginModal } = useAppContext()

  return (
    <section className="content-section">
      <div className="section-heading">
        <span className="section-eyebrow">Perfil</span>
        <h2>Iniciá sesión para ver tu perfil</h2>
        <p className="section-description">El perfil cambia según tu rol dentro de Mi Muni.</p>
        <button type="button" className="btn-primary" onClick={() => openLoginModal()}>
          Iniciar sesión
        </button>
      </div>
    </section>
  )
}

function DifusorProfile() {
  const [profile, setProfile] = useState(null)
  const [status, setStatus] = useState('loading')

  useEffect(() => {
    let cancelled = false

    async function loadProfile() {
      try {
        const nextProfile = await fetchDifusorProfile()
        if (cancelled) return
        setProfile(nextProfile)
        setStatus('ready')
      } catch (_error) {
        if (cancelled) return
        setStatus('error')
      }
    }

    void loadProfile()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="content-section">
      <div className="section-heading">
        <span className="section-eyebrow">Difusor</span>
        <h2>Mi impacto ciudadano</h2>
        <p className="section-description">Tus reportes de baches y avisos de recolección quedan reunidos en este perfil.</p>
      </div>

      <div className="profile-metric-grid">
        <article className="profile-card">
          <span>Reportes hechos</span>
          <strong>{profile?.reportCount ?? '-'}</strong>
        </article>
        <article className="profile-card">
          <span>Ya solucionados</span>
          <strong>{profile?.resolvedCount ?? '-'}</strong>
        </article>
        <article className="profile-card">
          <span>Abiertos</span>
          <strong>{profile?.openCount ?? '-'}</strong>
        </article>
      </div>

      <div className="profile-card">
        <h3>Alertas recibidas</h3>
        {status === 'error' && <p>No se pudo cargar tu perfil.</p>}
        {profile?.events?.length ? (
          <div className="profile-list">
            {profile.events.map((event) => (
              <article key={event.id}>
                <strong>{event.message}</strong>
                <span>{new Date(event.createdAt).toLocaleString('es-PY')}</span>
              </article>
            ))}
          </div>
        ) : (
          <p>Todavía no hay alertas de recolectores para tus barrios configurados.</p>
        )}
      </div>
    </section>
  )
}

function ProfilePage() {
  const { user } = useAppContext()
  const { navigate } = useHashRoute()
  const handleNavigate = makeNavigate(navigate)
  const roles = getUserRoles(user)

  return (
    <div className="municipal-app">
      <div className="ambient ambient-left" aria-hidden="true" />
      <div className="ambient ambient-right" aria-hidden="true" />
      <div className="grid-haze" aria-hidden="true" />
      <Header activeSection="" navigation={navigation} onNavigate={handleNavigate} />
      <main className="page-shell page-shell-info">
        {!user && <ProfileGate />}
        {userHasRole(user, 'difusor') && <DifusorProfile />}
        {user && !roles.includes('difusor') && !roles.includes('recolector') && (
          <section className="content-section">
            <div className="section-heading">
              <span className="section-eyebrow">Perfil</span>
              <h2>{user.name}</h2>
              <p className="section-description">Roles activos: {roles.join(', ') || user.role}</p>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

export default ProfilePage
