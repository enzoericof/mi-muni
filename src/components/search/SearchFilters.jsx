function SearchFilters({ categories, contentTypes, sections, filters, onChange }) {
  return (
    <section className="filters-card">
      <span className="card-label">Filtros</span>
      <div className="filters-grid">
        <label>
          <span>Categoría</span>
          <select value={filters.categoria} onChange={(event) => onChange({ categoria: event.target.value })}>
            {categories.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Tipo de contenido</span>
          <select value={filters.tipo} onChange={(event) => onChange({ tipo: event.target.value })}>
            {contentTypes.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Sección</span>
          <select value={filters.seccion} onChange={(event) => onChange({ seccion: event.target.value })}>
            {sections.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label className="toggle-filter">
          <input
            type="checkbox"
            checked={filters.soloFuenteOficial}
            onChange={(event) => onChange({ soloFuenteOficial: event.target.checked })}
          />
          <span>Solo con fuente oficial</span>
        </label>
      </div>
    </section>
  )
}

export default SearchFilters
