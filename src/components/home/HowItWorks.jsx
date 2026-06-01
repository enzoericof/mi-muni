const steps = [
  {
    num: 'PASO 01',
    title: 'Elegí qué necesitás',
    body: 'Buscar un trámite, ver el mapa de recolección o conocer el proyecto.',
  },
  {
    num: 'PASO 02',
    title: 'Preguntá o explorá',
    body: 'Escribí tu duda en lenguaje normal o navegá por categorías.',
  },
  {
    num: 'PASO 03',
    title: 'Obtené tu respuesta',
    body: 'Información clara y enlaces oficiales para que continúes el trámite.',
  },
]

function HowItWorks() {
  return (
    <div className="how-it-works">
      <div className="shell">
        <div className="section-head">
          <span className="eyebrow">Así de simple</span>
          <h2>Tres pasos, ninguna burocracia.</h2>
          <p>Sin formularios para registrarte, sin instalar nada. Entrás, preguntás, encontrás.</p>
        </div>

        <div className="how-it-works-grid">
          {steps.map((step) => (
            <div key={step.num} className="value-card">
              <span className="value-num">{step.num}</span>
              <strong>{step.title}</strong>
              <p>{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default HowItWorks
