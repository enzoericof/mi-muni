import MiniTrashMap from '../map/MiniTrashMap'
import { useHashRoute } from '../../lib/router'

function HeroMiniMap() {
  const { navigate } = useHashRoute()

  function openCollectionMap() {
    navigate('/recoleccion')
  }

  function handleMapKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openCollectionMap()
  }

  return (
    <div className="hero-card hero-card-map">
      <div className="hero-card-eyebrow">
        <span className="eyebrow">Recolección</span>
      </div>
      <h2 className="hero-card-title">Mapa de recolectores</h2>
      <p className="hero-card-lede">
        Seguí camiones recolectores en tiempo real.
      </p>

      <div
        className="hero-map-frame hero-map-frame-action"
        role="button"
        tabIndex={0}
        aria-label="Abrir mapa de recolección"
        onClick={openCollectionMap}
        onKeyDown={handleMapKeyDown}
      >
        <MiniTrashMap showOverlay={false} showMarkers={false} />
      </div>

      <div className="hero-map-foot">
        <button type="button" className="btn-primary btn-arrow hero-cta-button" onClick={openCollectionMap}>
          Ver recolección
        </button>
      </div>
    </div>
  )
}

export default HeroMiniMap
