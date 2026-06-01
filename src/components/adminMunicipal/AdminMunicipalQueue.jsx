import {
  POTHOLE_TYPE_LABELS,
  PRIORITY_LABELS,
} from '../../lib/adminMunicipalUtils'

function ImpactPill({ level }) {
  return <span className={`admin-muni-chip admin-muni-impact-pill is-${level}`}>Impacto {level}</span>
}

function RiskPill({ level }) {
  return <span className={`admin-muni-chip admin-muni-risk-pill is-${level}`}>Riesgo {level}</span>
}

function formatPriorityPillLabel(priorityBand) {
  return `Prioridad ${PRIORITY_LABELS[priorityBand] || 'Media'}`
}

function toQueueStatusValue(status) {
  return status === 'resuelto' ? 'resuelto' : 'abierto'
}

function resolveOpenStatus(currentStatus) {
  return currentStatus === 'resuelto' ? 'nuevo' : currentStatus
}

function QueueMiniCard({ incident, selected, onSelect }) {
  return (
    <button
      type="button"
      className={`admin-muni-queue-mini-card ${selected ? 'is-selected' : ''}`}
      onClick={() => onSelect(incident.incidentId)}
    >
      <div className="admin-muni-queue-mini-top">
        <strong>{incident.barrioLabel}</strong>
        <span className={`admin-muni-priority-pill is-${incident.priorityBand}`}>
          {formatPriorityPillLabel(incident.priorityBand)}
        </span>
      </div>

      <span className="admin-muni-queue-mini-type">
        {POTHOLE_TYPE_LABELS[incident.potholeType] || 'Bache'}
      </span>

      <p>{incident.referenceText || incident.description || 'Sin referencia cargada.'}</p>

      <div className="admin-muni-queue-mini-meta">
        <span>Riesgo {incident.riskScore}</span>
        <span>Impacto {incident.impactScore}</span>
        <span>{incident.confirmationCount} confirmaciones</span>
      </div>
    </button>
  )
}

export default function AdminMunicipalQueue({
  barrioOptions,
  detailContent,
  filters,
  incidents,
  mapContent,
  onFilterChange,
  onSelectIncident,
  onToggleIncidentStatus,
  queueSort,
  setQueueSort,
  savingId,
  selectedIncidentId,
}) {
  return (
    <section className="admin-muni-queue-card admin-ops-card admin-muni-queue-board">
      <div className="admin-muni-card-head admin-ops-queue-head">
        <div>
          <span className="admin-muni-kicker">Análisis Individual</span>
        </div>
        <span className="admin-muni-chip">{incidents.length} baches</span>
      </div>

      <div className="admin-muni-filter-row admin-muni-filter-row-wide">
        <label>
          <span>Ordenar por</span>
          <select value={queueSort} onChange={(event) => setQueueSort(event.target.value)}>
            <option value="priority">Prioridad</option>
            <option value="impact">Impacto</option>
            <option value="risk">Riesgo</option>
          </select>
        </label>

        <label>
          <span>Barrio</span>
          <select value={filters.barrioSlug} onChange={(event) => onFilterChange({ barrioSlug: event.target.value })}>
            <option value="">Todos</option>
            {barrioOptions.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="admin-muni-queue-top-grid">
        <section className="admin-muni-queue-section is-wide admin-muni-queue-primary-list">
          <div className="admin-muni-card-head compact">
            <div>
              <h3>Todos los baches</h3>
            </div>
            <span className="admin-muni-chip">{incidents.length}</span>
          </div>

          <div className="admin-muni-queue-main-list">
            {incidents.length ? (
              incidents.map((incident) => (
                (() => {
                  const primaryDetail = POTHOLE_TYPE_LABELS[incident.potholeType] || 'Bache'

                  return (
                <article
                  key={incident.incidentId}
                  className={`admin-muni-queue-main-card ${selectedIncidentId === incident.incidentId ? 'is-selected' : ''}`}
                  onClick={() => onSelectIncident(incident.incidentId)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelectIncident(incident.incidentId)
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="admin-muni-queue-main-top">
                    <div>
                      <strong>{incident.barrioLabel}</strong>
                      {primaryDetail ? <span>{primaryDetail}</span> : null}
                    </div>
                  </div>

                  <div className="admin-muni-focus-meta admin-muni-incident-meta">
                    <label className={`admin-muni-chip-select is-${toQueueStatusValue(incident.status)}`}>
                      <span className="sr-only">Estado</span>
                      <select
                        value={toQueueStatusValue(incident.status)}
                        disabled={savingId === incident.incidentId}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          event.stopPropagation()
                          const nextStatus = event.target.value === 'resuelto' ? 'resuelto' : resolveOpenStatus(incident.status)
                          onToggleIncidentStatus?.(incident, nextStatus)
                        }}
                      >
                        <option value="abierto">Abierto</option>
                        <option value="resuelto">Reparado</option>
                      </select>
                    </label>
                    {queueSort === 'priority' ? (
                      <span className={`admin-muni-priority-pill is-${incident.priorityBand}`}>
                        {formatPriorityPillLabel(incident.priorityBand)}
                      </span>
                    ) : null}
                    {queueSort === 'impact' ? <ImpactPill level={incident.impactLevel} /> : null}
                    {queueSort === 'risk' ? <RiskPill level={incident.riskLevel || 'medio'} /> : null}
                  </div>
                </article>
                  )
                })()
              ))
            ) : (
              <div className="admin-muni-empty-block">Sin resultados.</div>
            )}
          </div>
        </section>

        <div className="admin-muni-queue-side-stack">
          <div className="admin-muni-queue-map-shell">
            {mapContent}
          </div>

          {detailContent}
        </div>
      </div>
    </section>
  )
}
