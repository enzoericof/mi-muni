import Header from '../components/layout/Header'
import PotholesMap from '../components/map/PotholesMap'
import { useAppContext } from '../lib/AppContext'
import { useHashRoute } from '../lib/router'
import { makeNavigate, navigation } from '../lib/navigation'

function BachesLockedState() {
  const { openLoginModal } = useAppContext()

  return (
    <div className="potholes-locked-shell">
      <div className="potholes-locked-card">
        <span className="section-eyebrow">Baches</span>
        <h2>{'Inici\u00e1 sesi\u00f3n para usar este m\u00f3dulo'}</h2>
        <p>{'Entr\u00e1 para reportar baches, ver los cercanos y confirmar los que ya existen.'}</p>
        <button
          type="button"
          className="btn-primary potholes-locked-action"
          onClick={() => openLoginModal('Inici\u00e1 sesi\u00f3n para entrar al m\u00f3dulo de baches.')}
        >
          {'Inici\u00e1 sesi\u00f3n'}
        </button>
      </div>
    </div>
  )
}

function BachesPage() {
  const { user } = useAppContext()
  const { navigate } = useHashRoute()
  const handleNavigate = makeNavigate(navigate)

  return (
    <div className="municipal-app">
      <div className="ambient ambient-left" aria-hidden="true" />
      <div className="ambient ambient-right" aria-hidden="true" />
      <div className="grid-haze" aria-hidden="true" />

      <Header activeSection="baches" navigation={navigation} onNavigate={handleNavigate} />

      <main className="page-shell page-shell-baches-public">
        {user ? <PotholesMap /> : <BachesLockedState />}
      </main>
    </div>
  )
}

export default BachesPage
