import Header from '../components/layout/Header'
import TrashMap from '../components/map/TrashMap'
import { useAppContext } from '../lib/AppContext'
import { useHashRoute } from '../lib/router'
import { navigation, makeNavigate } from '../lib/navigation'

function MapaPage() {
  const { user } = useAppContext()
  const { navigate } = useHashRoute()
  const handleNavigate = makeNavigate(navigate)
  const readOnly = !user

  return (
    <div className="municipal-app">
      <div className="ambient ambient-left" aria-hidden="true" />
      <div className="ambient ambient-right" aria-hidden="true" />
      <div className="grid-haze" aria-hidden="true" />

      <Header activeSection="mapa" navigation={navigation} onNavigate={handleNavigate} />

      <main className="page-shell page-shell-trash-public">
        <TrashMap readOnly={readOnly} />
      </main>
    </div>
  )
}

export default MapaPage
