import { useEffect, useState } from 'react'
import ProcedureCard from './ProcedureCard'

function ResultsPanel({ state, results }) {
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    setActiveIndex(0)
  }, [results])

  const activeResult = results[activeIndex] ?? results[0]

  return (
    <section className="results-panel">
      {state === 'idle' ? (
        <div className="empty-card">
          <strong>Seleccioná un trámite</strong>
          <p>Elegí una opción de la lista para ver requisitos, pasos y costos.</p>
        </div>
      ) : null}

      {state === 'searching' ? (
        <div className="empty-card">
          <strong>Buscando...</strong>
          <p>Cargando información del trámite.</p>
        </div>
      ) : null}

      {state === 'empty' ? (
        <div className="empty-card">
          <strong>Sin resultados</strong>
          <p>No hay ficha disponible para esta consulta.</p>
        </div>
      ) : null}

      {state === 'error' ? (
        <div className="empty-card">
          <strong>Error de conexión</strong>
          <p>Verificá que el backend esté corriendo en el puerto 8787.</p>
        </div>
      ) : null}

      {state === 'results' ? (
        <div className="results-list">
          {results.length > 1 ? (
            <div className="result-switcher">
              {results.map((result, index) => (
                <button
                  key={result.id || result.titulo}
                  type="button"
                  className={index === activeIndex ? 'is-active' : ''}
                  onClick={() => setActiveIndex(index)}
                >
                  {result.titulo}
                </button>
              ))}
            </div>
          ) : null}

          {activeResult ? <ProcedureCard result={activeResult} /> : null}
        </div>
      ) : null}
    </section>
  )
}

export default ResultsPanel
