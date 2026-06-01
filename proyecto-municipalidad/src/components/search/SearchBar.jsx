function SearchBar({ value, onChange, onSearch, status, suggestions, onSuggestionClick }) {
  return (
    <section className="search-card">
      <div className="search-card-head">
        <div>
          <span className="card-label">Buscador inteligente</span>
          <h3>Hacé una consulta municipal</h3>
        </div>
        <span className={`search-status is-${status}`}>{status === 'searching' ? 'Buscando' : 'Listo'}</span>
      </div>

      <div className="search-bar">
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Ej.: renovar licencia, habilitación comercial o pago de patente"
        />
        <button type="button" className="primary-action" onClick={onSearch}>
          Buscar
        </button>
      </div>

      <div className="search-suggestions">
        {suggestions.map((suggestion) => (
          <button key={suggestion} type="button" className="prompt-chip" onClick={() => onSuggestionClick(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>
    </section>
  )
}

export default SearchBar
