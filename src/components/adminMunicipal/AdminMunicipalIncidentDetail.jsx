import {
  POTHOLE_TYPE_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  formatDateTime,
} from '../../lib/adminMunicipalUtils'

function formatPriorityPillLabel(priorityBand) {
  return `Prioridad ${PRIORITY_LABELS[priorityBand] || 'Media'}`
}

function formatStatusTransition(reportStatus) {
  if (reportStatus === 'resuelto') return 'Abierto -> Reparado'
  if (reportStatus === 'descartado') return 'Abierto -> Descartado'
  return `Abierto -> ${STATUS_LABELS[reportStatus] || reportStatus}`
}

function buildTimeline({ detail, relatedReports = [] }) {
  const timeline = []
  const historyEntries = detail?.history || []
  const confirmations = detail?.confirmations || []

  for (const report of relatedReports) {
    timeline.push({
      id: `created-${report.id}`,
      title: 'Reporte creado',
      subtitle: report.reporterName || report.reporterEmail || 'Vecino',
      createdAt: report.createdAt,
      actor: '',
      note: report.referenceText || report.description || '',
    })

    const hasStatusHistory = historyEntries.some((entry) => entry.reportId === report.id)
    if (report.latestStatusAt && report.status && report.status !== 'nuevo' && !hasStatusHistory) {
      timeline.push({
        id: `status-synthetic-${report.id}`,
        title: 'Cambio de estado',
        subtitle: formatStatusTransition(report.status),
        createdAt: report.latestStatusAt,
        actor: 'admin-muni',
        note: '',
      })
    }
  }

  for (const entry of historyEntries) {
    timeline.push({
      id: `status-${entry.id}`,
      title: 'Cambio de estado',
      subtitle: entry.fromStatus && entry.toStatus
        ? `${STATUS_LABELS[entry.fromStatus] || entry.fromStatus} -> ${STATUS_LABELS[entry.toStatus] || entry.toStatus}`
        : STATUS_LABELS[entry.toStatus] || entry.toStatus || 'Actualización',
      createdAt: entry.createdAt,
      actor: entry.changedBy || 'admin-muni',
      note: entry.note || '',
    })
  }

  for (const confirmation of confirmations) {
    timeline.push({
      id: `confirmation-${confirmation.id}`,
      title: 'Confirmación recibida',
      subtitle: confirmation.confirmerName || confirmation.confirmerEmail || 'Vecino',
      createdAt: confirmation.createdAt,
      actor: '',
      note: confirmation.note || '',
    })
  }

  return timeline
    .filter((entry) => entry.createdAt)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
}

function HistoryList({ detail, relatedReports = [] }) {
  const history = buildTimeline({ detail, relatedReports })

  if (!history.length) {
    return <div className="admin-muni-empty-block">Todavía no hay historial de cambios para este bache.</div>
  }

  return (
    <div className="admin-muni-history-list">
      {history.map((entry) => (
        <article key={entry.id} className="admin-muni-history-item">
          <div>
            <strong>{entry.title}</strong>
            <span>{entry.subtitle}</span>
          </div>
          <small>{entry.actor ? `${entry.actor} · ` : ''}{formatDateTime(entry.createdAt)}</small>
          {entry.note ? <p>{entry.note}</p> : null}
        </article>
      ))}
    </div>
  )
}

export default function AdminMunicipalIncidentDetail({
  detail,
  incident,
  loading,
  relatedReports = [],
}) {
  const images = detail?.images || []

  return (
    <section className="admin-muni-side-card admin-muni-focus-card">
      <div className="admin-muni-focus-topline">
        <div>
          <span className="admin-muni-kicker">Detalle operativo</span>
          <h4>{incident ? POTHOLE_TYPE_LABELS[incident.potholeType] || 'Bache consolidado' : 'Seleccioná un bache'}</h4>
        </div>
        {incident ? (
          <span className={`admin-muni-priority-pill is-${incident.priorityBand}`}>
            {formatPriorityPillLabel(incident.priorityBand)}
          </span>
        ) : null}
      </div>

      {loading ? (
        <p className="admin-muni-inline-message">Cargando detalle...</p>
      ) : !incident ? (
        <div className="admin-muni-empty-block">Seleccioná un bache de la cola para ver reportes, imágenes e historial.</div>
      ) : (
        <>
          <p>{incident.description || detail?.description || 'Sin descripción ampliada.'}</p>

          <div className="admin-muni-focus-meta">
            <span>{incident.barrioLabel}</span>
            <span>{incident.reportCount} reportes</span>
            <span>{incident.confirmationCount} confirmaciones</span>
          </div>

          <div className="admin-muni-focus-signals">
            <article>
              <span>Prioridad</span>
              <strong>{PRIORITY_LABELS[incident.priorityBand] || 'Media'}</strong>
            </article>
            <article>
              <span>Impacto</span>
              <strong>{incident.impactScore}</strong>
            </article>
            <article>
              <span>Riesgo</span>
              <strong>{incident.riskScore}</strong>
            </article>
          </div>

          <div className="admin-muni-detail-block">
            <strong>Ubicación</strong>
            <span>{incident.referenceText || 'Sin referencia textual.'}</span>
            <small>{incident.lat.toFixed(5)}, {incident.lon.toFixed(5)}</small>
          </div>

          <div className="admin-muni-detail-block">
            <strong>Imágenes</strong>
            {images.length ? (
              <div className="admin-muni-image-grid">
                {images.map((image) => (
                  <a key={image.id} href={image.blobUrl} target="_blank" rel="noreferrer" className="admin-muni-image-tile">
                    <img src={image.blobUrl} alt={image.fileName || 'Bache'} />
                  </a>
                ))}
              </div>
            ) : (
              <span>Sin fotos cargadas.</span>
            )}
          </div>

          <div className="admin-muni-detail-block">
            <strong>Reportes agrupados</strong>
            <div className="admin-muni-related-list">
              {relatedReports.map((report) => (
                <article key={report.id} className="admin-muni-related-item">
                  <div>
                    <strong>#{report.id}</strong>
                    <span>{report.reporterName || report.reporterEmail || 'Vecino'}</span>
                  </div>
                  <small>{formatDateTime(report.createdAt)}</small>
                </article>
              ))}
            </div>
          </div>

          <div className="admin-muni-detail-block">
            <strong>Historial</strong>
            <HistoryList detail={detail} relatedReports={relatedReports} />
          </div>
        </>
      )}
    </section>
  )
}
