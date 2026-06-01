import { BellIcon, LocationIcon, MapExpandIcon } from './MapIcons'

export default function TrashMapControls({
  isFullscreen,
  locatingUser,
  notificationOpen,
  onLocateUser,
  onToggleNotifications,
  onToggleFullscreen,
}) {
  return (
    <div className="trash-screen-controls">
      <button
        type="button"
        className={`trash-map-control ${notificationOpen ? 'is-active' : ''}`}
        onClick={onToggleNotifications}
        aria-label="Abrir notificaciones"
        title="Notificaciones"
      >
        <BellIcon className="trash-map-icon" />
      </button>
      <button
        type="button"
        className="trash-map-control"
        onClick={onLocateUser}
        disabled={locatingUser}
        aria-label="Ir a mi ubicación"
        title="Ir a mi ubicación"
      >
        <LocationIcon className="trash-map-icon" />
      </button>
      <button
        type="button"
        className="trash-map-control"
        onClick={onToggleFullscreen}
        title={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
        aria-label={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
      >
        <MapExpandIcon active={isFullscreen} className="trash-map-icon" />
      </button>
    </div>
  )
}
