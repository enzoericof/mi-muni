import MiniTrashMap from '../map/MiniTrashMap'
import { useHashRoute } from '../../lib/router'

function HeroPotholes() {
  const { navigate } = useHashRoute()

  function openPotholesMap() {
    navigate('/baches')
  }

  function handleMapKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openPotholesMap()
  }

  return (
    <div className="hero-card hero-card-potholes">
      <div className="hero-card-eyebrow">
        <span className="eyebrow">Baches</span>
      </div>
      <h2 className="hero-card-title">Mapa de baches</h2>
      <p className="hero-card-lede">
        Reportá y confirmá baches, para priorizar arreglos en tu zona.
      </p>

      <div
        className="hero-map-frame hero-map-frame-action"
        role="button"
        tabIndex={0}
        aria-label="Abrir mapa de baches"
        onClick={openPotholesMap}
        onKeyDown={handleMapKeyDown}
      >
        <MiniTrashMap mode="potholes" showOverlay={false} showMarkers />
      </div>

      <div className="hero-map-foot">
        <button type="button" className="btn-secondary btn-arrow hero-cta-button hero-cta-button-green" onClick={openPotholesMap}>
          Ver mapa de baches
        </button>
      </div>
    </div>
  )
}

export default HeroPotholes
