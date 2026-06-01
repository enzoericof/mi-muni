import { useEffect, useMemo, useState } from 'react'
import { fetchProcedureSection } from '../../lib/api'

const sectionLabels = {
  descripcion: 'Descripción',
  requisitos: 'Requisitos',
  pasos: 'Pasos',
  costos: 'Costos',
  plazos: 'Plazos',
  lugar_canal: 'Canales',
  horarios: 'Horarios',
  resultado: 'Resultado',
  observaciones: 'Observaciones',
}

const orderedKeys = ['descripcion', 'requisitos', 'pasos', 'costos', 'plazos', 'lugar_canal', 'horarios', 'resultado', 'observaciones']

function normalizeFallbackContent(result, sectionKey) {
  const rawContent = sectionKey === 'descripcion' ? result.descripcion : result.secciones?.[sectionKey]
  if (Array.isArray(rawContent)) return rawContent.filter(Boolean)
  return [rawContent].filter(Boolean)
}

function ProcedureCard({ result }) {
  const sectionOrder = result.sectionOrder ?? orderedKeys

  const availableSections = useMemo(
    () =>
      sectionOrder.filter((key) => {
        const content = key === 'descripcion' ? result.descripcion : result.secciones?.[key]
        return Array.isArray(content) ? content.length : Boolean(content)
      }),
    [result, sectionOrder],
  )

  const [activeSection, setActiveSection] = useState(availableSections[0] ?? 'descripcion')
  const [sectionCache, setSectionCache] = useState({})
  const [sectionState, setSectionState] = useState('idle')

  useEffect(() => {
    setActiveSection(availableSections[0] ?? 'descripcion')
    setSectionCache({})
    setSectionState('idle')
  }, [result.id, availableSections])

  useEffect(() => {
    let cancelled = false

    async function loadSection() {
      if (!result.id || !activeSection) return
      if (sectionCache[activeSection]) return

      setSectionState('loading')

      try {
        const sectionResult = await fetchProcedureSection(result.id, activeSection)
        if (cancelled) return
        setSectionCache((prev) => ({ ...prev, [activeSection]: sectionResult }))
        setSectionState('ready')
      } catch (_error) {
        if (cancelled) return
        setSectionCache((prev) => ({
          ...prev,
          [activeSection]: {
            section: activeSection,
            label: sectionLabels[activeSection] ?? activeSection,
            content: normalizeFallbackContent(result, activeSection),
            citations: [],
            source: result.fuente?.titulo ?? null,
            sourceUrl: result.fuente?.url ?? null,
            grounded: false,
            model: null,
          },
        }))
        setSectionState('error')
      }
    }

    loadSection()
    return () => { cancelled = true }
  }, [activeSection, result, sectionCache])

  const sectionResult = sectionCache[activeSection]
  const normalizedContent = sectionResult?.content?.length
    ? sectionResult.content
    : normalizeFallbackContent(result, activeSection)

  return (
    <article className="result-card">
      <div className="result-summary">
        <h3>{result.titulo}</h3>
        {result.resumen ? <p>{result.resumen}</p> : null}
      </div>

      <div className="result-detail-layout">
        <div className="result-section-nav">
          {availableSections.map((key) => (
            <button
              key={key}
              type="button"
              className={activeSection === key ? 'is-active' : ''}
              onClick={() => setActiveSection(key)}
            >
              {sectionLabels[key]}
            </button>
          ))}
        </div>

        <div className="result-section-content">
          <span className="section-content-label">
            {sectionLabels[activeSection] ?? sectionResult?.label ?? activeSection}
          </span>

          {sectionState === 'loading' && !sectionResult ? (
            <p className="section-loading">Consultando...</p>
          ) : null}

          {normalizedContent.length > 1 ? (
            <ul className="section-list">
              {normalizedContent.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="section-text">{normalizedContent[0] ?? 'Contenido en preparación.'}</p>
          )}
        </div>
      </div>

      <footer>
        <strong>{sectionResult?.source || result.fuente?.titulo || 'Fuente pendiente'}</strong>
        <a href={sectionResult?.sourceUrl || result.fuente?.url || '#'} target="_blank" rel="noreferrer">
          Abrir fuente oficial
        </a>
      </footer>
    </article>
  )
}

export default ProcedureCard
