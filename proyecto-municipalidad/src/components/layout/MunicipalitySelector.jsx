import { useEffect, useMemo, useRef, useState } from 'react'
import staticMunicipalities from '../../data/municipalities'
import { fetchActiveMunicipalities } from '../../lib/api'
import { useAppContext } from '../../lib/AppContext'

function MunicipalitySelector() {
  const { municipality, setMunicipality } = useAppContext()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [toast, setToast] = useState(null)
  const [seededList, setSeededList] = useState(null)
  const containerRef = useRef(null)

  useEffect(() => {
    fetchActiveMunicipalities()
      .then((data) => setSeededList(data?.municipalities || []))
      .catch(() => setSeededList([]))
  }, [])

  useEffect(() => {
    if (!open) return undefined

    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false)
      }
    }

    const handleKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open])

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(timer)
  }, [toast])

  const municipalities = useMemo(() => {
    const byKey = new Map()

    for (const item of staticMunicipalities) {
      byKey.set(item.key, {
        ...item,
        enabled: true,
      })
    }

    for (const item of seededList || []) {
      const staticItem = staticMunicipalities.find((candidate) => candidate.key === item.key)
      byKey.set(item.key, {
        ...(staticItem || {}),
        key: item.key,
        label: staticItem?.label || item.label,
        enabled: true,
        geoReady: item.geoReady === true || staticItem?.geoReady === true,
        centerLat: item.centerLat ?? staticItem?.centerLat ?? null,
        centerLon: item.centerLon ?? staticItem?.centerLon ?? null,
        bbox: item.bbox && Object.keys(item.bbox || {}).length ? item.bbox : (staticItem?.bbox || {}),
      })
    }

    return [...byKey.values()]
  }, [seededList])

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return municipalities
    return municipalities.filter((item) => item.label.toLowerCase().includes(term))
  }, [query, municipalities])

  const handleSelect = (item) => {
    if (!item.enabled) {
      setToast(`${item.label}: pr\u00f3ximamente. A\u00fan no est\u00e1 integrado.`)
      return
    }

    setMunicipality(item)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="municipality-selector" ref={containerRef}>
      <button
        type="button"
        className="municipality-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="municipality-trigger-label">{municipality.label}</span>
        <span className="municipality-trigger-caret" aria-hidden="true">{'\u25be'}</span>
      </button>

      {open && (
        <div className="municipality-popover" role="listbox">
          <input
            type="text"
            className="municipality-search"
            placeholder="Buscar municipio..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
            aria-label="Buscar municipio"
          />
          <ul className="municipality-list">
            {filtered.length === 0 && (
              <li className="municipality-empty">Sin coincidencias.</li>
            )}
            {filtered.map((item) => {
              const isSelected = item.key === municipality.key
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    className={`municipality-option ${isSelected ? 'is-selected' : ''} ${item.enabled ? '' : 'is-disabled'}`}
                    onClick={() => handleSelect(item)}
                    role="option"
                    aria-selected={isSelected}
                  >
                    <span>{item.label}</span>
                    {!item.enabled && <small>Pr\u00f3ximamente</small>}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {toast && <div className="municipality-toast" role="status">{toast}</div>}
    </div>
  )
}

export default MunicipalitySelector
