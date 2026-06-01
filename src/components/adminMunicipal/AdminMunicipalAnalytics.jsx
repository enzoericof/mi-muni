export default function AdminMunicipalAnalytics({
  distribution,
  incidentRanking,
  incidentSummary,
  reportSummary,
  totalConfirmations,
}) {
  const metrics = [
    { label: 'Baches abiertos', value: incidentSummary.open, tone: 'is-green' },
    { label: 'Alta prioridad', value: incidentSummary.priority.alta || 0, tone: 'is-orange' },
    { label: 'Resueltos', value: incidentSummary.status.resuelto || 0, tone: 'is-blue' },
    { label: 'Confirmaciones', value: totalConfirmations, tone: 'is-mint' },
  ]

  return (
    <section className="admin-muni-analytics-card admin-ops-card">
      <div className="admin-muni-card-head compact">
        <div>
          <span className="admin-muni-kicker">Analytics</span>
        </div>
        <span className="admin-muni-chip">{reportSummary.total} reportes totales</span>
      </div>

      <div className="admin-muni-metric-grid admin-ops-metric-grid">
        {metrics.map((metric) => (
          <article key={metric.label} className={`admin-muni-metric ${metric.tone}`}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </article>
        ))}
      </div>

      <div className="admin-muni-signal-row">
        <div className="admin-muni-trend-card">
          <div className="admin-muni-card-head compact">
            <div>
              <span className="admin-muni-kicker">TOP BARRIOS CON BACHES</span>
            </div>
          </div>

          <div className="admin-muni-ranking-list">
            {incidentRanking.length ? (
              incidentRanking.slice(0, 5).map((item, index) => {
                const maxCount = Math.max(...incidentRanking.map((entry) => entry.count), 1)
                return (
                  <div key={item.label} className="admin-muni-status-bar">
                    <div className="admin-muni-ranking-item">
                      <div className="admin-muni-ranking-copy">
                        <small className="admin-muni-ranking-index">#{index + 1}</small>
                        <strong>{item.label}</strong>
                      </div>
                      <div className="admin-muni-ranking-score">
                        <strong>{item.count}</strong>
                      </div>
                    </div>
                    <div className="admin-muni-ranking-track">
                      <span style={{ width: `${Math.round((item.count / maxCount) * 100)}%` }} />
                    </div>
                  </div>
                )
              })
            ) : (
              <div className="admin-muni-empty-block">Sin barrios activos para estos filtros.</div>
            )}
          </div>
        </div>

        <div className="admin-muni-trend-card">
          <div className="admin-muni-card-head compact">
            <div>
              <span className="admin-muni-kicker">PRIORIDAD ACTUAL</span>
            </div>
          </div>

          <div className="admin-muni-donut-layout">
            <div className="admin-muni-donut-ring" aria-hidden="true">
              {distribution.map((segment) => (
                <div
                  key={segment.key}
                  className={`admin-muni-donut-segment is-${segment.key}`}
                  style={{
                    '--segment-offset': segment.offset,
                    '--segment-size': segment.size,
                  }}
                />
              ))}

              <div className="admin-muni-donut-center">
                <strong>{incidentSummary.open}</strong>
                <span>baches abiertos</span>
              </div>
            </div>

            <div className="admin-muni-legend">
              {distribution.map((segment) => (
                <div key={segment.key} className="admin-muni-legend-item">
                  <div className="admin-muni-legend-label">
                    <span className={`admin-muni-legend-dot is-${segment.key}`} aria-hidden="true" />
                    <span className={`admin-muni-legend-badge is-${segment.key}`}>{segment.label}</span>
                  </div>
                  <strong>{segment.value}</strong>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
