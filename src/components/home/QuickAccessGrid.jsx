function QuickAccessGrid({ items, onSelect }) {
  return (
    <div className="quick-access-shell">
      <div className="shortcut-grid" aria-label="Accesos rápidos">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`shortcut-card ${item.selected ? 'is-selected' : ''}`.trim()}
            onClick={(event) => {
              event.currentTarget.blur()
              onSelect(item)
            }}
          >
            <strong>{item.title}</strong>
          </button>
        ))}
      </div>
    </div>
  )
}

export default QuickAccessGrid
