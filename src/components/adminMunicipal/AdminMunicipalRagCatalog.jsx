const SOURCE_LABELS = {
  html: 'HTML',
  pdf: 'PDF',
  image: 'Imagen',
  manual: 'Manual',
}

function formatDate(value) {
  if (!value) return 'Sin fecha'
  return new Date(value).toLocaleDateString('es-PY', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function excerpt(value, maxLength = 220) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return 'Sin texto disponible.'
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`
}

function AdminMunicipalRagCatalog({
  catalog,
  filters,
  loading,
  onFilterChange,
  onToggleVisibility,
  savingItemId,
}) {
  return (
    <section className="admin-muni-queue-card admin-muni-rag-card">
      <div className="admin-muni-card-head admin-ops-queue-head">
        <div>
          <span className="admin-muni-kicker">Info futura</span>
          <h3>Catálogo curable de fuentes</h3>
        </div>
        <div className="admin-muni-filter-row admin-muni-rag-filters">
          <label>
            <span>Tipo</span>
            <select value={filters.sourceType} onChange={(event) => onFilterChange({ sourceType: event.target.value })}>
              <option value="">Todos</option>
              <option value="html">HTML</option>
              <option value="pdf">PDF</option>
              <option value="image">Imagen</option>
            </select>
          </label>
          <label>
            <span>Visibilidad</span>
            <select value={filters.visibility} onChange={(event) => onFilterChange({ visibility: event.target.value })}>
              <option value="">Todos</option>
              <option value="visible">Visible</option>
              <option value="hidden">Oculto</option>
            </select>
          </label>
        </div>
      </div>

      <div className="admin-muni-rag-list">
        {loading ? (
          <p className="admin-muni-inline-message">Cargando catálogo...</p>
        ) : catalog.length ? (
          catalog.map((item) => (
            <article className="admin-muni-rag-item" key={item.id}>
              <div className="admin-muni-rag-item-main">
                <div className="admin-muni-rag-title-row">
                  <span className={`admin-runtime-badge ${item.visible ? 'is-on' : 'is-off'}`}>
                    {item.visible ? 'Visible' : 'Oculto'}
                  </span>
                  <span className="admin-muni-chip">{SOURCE_LABELS[item.sourceType] || item.sourceType}</span>
                  <span className="admin-muni-chip">v{item.version || 1}</span>
                  <small>{formatDate(item.indexedAt)}</small>
                </div>
                <h4>{item.title}</h4>
                <p>{item.summary || item.text || 'Sin resumen disponible.'}</p>
                {item.previousContentHash && (
                  <div className="admin-muni-rag-diff">
                    <div>
                      <strong>Versión anterior</strong>
                      <span>{excerpt(item.previousText)}</span>
                    </div>
                    <div>
                      <strong>Versión nueva</strong>
                      <span>{excerpt(item.text || item.summary)}</span>
                    </div>
                  </div>
                )}
                <div className="admin-muni-rag-meta">
                  <span>{item.municipalityName || 'Municipalidad'}</span>
                  {item.previousContentHash && <span>Cambio detectado {formatDate(item.changedAt)}</span>}
                  {item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer">Fuente</a>}
                </div>
              </div>
              <button
                type="button"
                className={`admin-muni-ghost-button is-compact ${item.visible ? 'is-danger' : ''}`}
                disabled={savingItemId === item.id}
                onClick={() => onToggleVisibility(item)}
              >
                {savingItemId === item.id ? 'Guardando...' : item.visible ? 'Ocultar' : 'Publicar'}
              </button>
            </article>
          ))
        ) : (
          <p className="admin-muni-inline-message">
            El catálogo curable de fuentes y la capa de curaduría se implementarán en la siguiente etapa.
          </p>
        )}
      </div>
    </section>
  )
}

export default AdminMunicipalRagCatalog
