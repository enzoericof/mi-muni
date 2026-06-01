const NOTIFICATION_CHANNELS = [
  { value: 'panel', label: 'Portal interno' },
  { value: 'email', label: 'Correo' },
  { value: 'both', label: 'Portal y correo' },
]

export default function TrashNotificationSheet({
  channelLabel,
  deletingId,
  notificationForm,
  notifications,
  onDelete,
  onFormChange,
  onSubmit,
  readOnly,
  serviceZones,
  status,
}) {
  if (readOnly) {
    return (
      <div className="trash-sheet-note">
        <strong>{'Modo solo lectura'}</strong>
        <span>{'Inicia sesion para configurar avisos por barrio.'}</span>
      </div>
    )
  }

  return (
    <div className="trash-notification-sheet">
      <div className="trash-notification-sheet-head">
        <strong>{'Notificaciones'}</strong>
      </div>

      <div className="trash-notification-layout">
        <form className="gtfs-notification-grid" onSubmit={onSubmit}>
          <section className="trash-notification-section">
            <div className="trash-notification-section-head">
              <span className="trash-notification-step">1</span>
              <strong>{'Seleccioná el barrio'}</strong>
            </div>

            <div className="trash-public-zone-list" aria-label="Barrio para alertas">
              {serviceZones.map((zone) => (
                <label
                  key={zone.id}
                  className={`trash-public-zone-option ${notificationForm.zoneId === zone.id ? 'is-selected' : ''}`.trim()}
                >
                  <input
                    type="checkbox"
                    checked={notificationForm.zoneId === zone.id}
                    onChange={() => onFormChange({ zoneId: notificationForm.zoneId === zone.id ? '' : zone.id })}
                  />
                  <span>{zone.label}</span>
                </label>
              ))}
              {!serviceZones.length ? (
                <div className="trash-sheet-note">
                  <strong>{'Sin barrios'}</strong>
                  <span>{'No hay barrios disponibles para esta ciudad.'}</span>
                </div>
              ) : null}
            </div>
          </section>

          <section className="trash-notification-section">
            <div className="trash-notification-section-head">
              <span className="trash-notification-step">2</span>
              <strong>{'Elegí el canal'}</strong>
            </div>

            <div className="trash-channel-list" aria-label="Canal para alertas">
              {NOTIFICATION_CHANNELS.map((channel) => (
                <label
                  key={channel.value}
                  className={`trash-channel-option ${notificationForm.channel === channel.value ? 'is-selected' : ''}`.trim()}
                >
                  <input
                    type="radio"
                    name="trash-notification-channel"
                    value={channel.value}
                    checked={notificationForm.channel === channel.value}
                    onChange={() => onFormChange({ channel: channel.value })}
                  />
                  <span>{channel.label}</span>
                </label>
              ))}
            </div>
          </section>

          <button type="submit" className="btn-secondary gtfs-notification-submit">
            {status === 'saving' ? 'Guardando...' : 'Notificar'}
          </button>
        </form>

        <section className="trash-saved-notifications" aria-label="Notificaciones guardadas">
          <div className="trash-notification-section-head">
            <strong>{'Guardadas'}</strong>
          </div>

          <div className="gtfs-notification-list">
            {notifications.length ? (
              notifications.map((notification) => (
                <article key={notification.id} className="gtfs-notification-item">
                  <div className="gtfs-notification-copy">
                    <strong>{serviceZones.find((zone) => zone.id === notification.zone_id)?.label || notification.zone_id}</strong>
                    <span>{`Canal: ${channelLabel(notification.channel)}`}</span>
                  </div>
                  <button
                    type="button"
                    className="gtfs-notification-delete"
                    onClick={() => onDelete(notification.id, notification.zone_id)}
                    disabled={deletingId === notification.id}
                  >
                    {deletingId === notification.id ? 'Borrando...' : 'Borrar'}
                  </button>
                </article>
              ))
            ) : (
              <div className="trash-sheet-note">
                <strong>{'Sin avisos configurados'}</strong>
                <span>{'Todavia no guardaste notificaciones.'}</span>
              </div>
            )}
          </div>
        </section>
      </div>

      {status === 'saved' && <span className="gtfs-form-feedback">{'Notificacion configurada.'}</span>}
      {status === 'error' && (
        <span className="gtfs-form-feedback is-error">{'No se pudo guardar o cargar las notificaciones.'}</span>
      )}
    </div>
  )
}
