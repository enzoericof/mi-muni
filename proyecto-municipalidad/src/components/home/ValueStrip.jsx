const items = [
  {
    num: '01',
    title: 'Una sola entrada',
    body: 'Trámites, recolección y servicios urbanos juntos; no más buscar entre seis sitios distintos.',
  },
  {
    num: '02',
    title: 'En lenguaje claro',
    body: 'Respuestas como te las daría un funcionario amable. Sin jerga, sin laberintos burocráticos.',
  },
  {
    num: '03',
    title: 'Siempre con la fuente',
    body: 'Cada respuesta enlaza al formulario o página oficial de la Municipalidad para que verifiques.',
  },
]

function ValueStrip() {
  return (
    <div className="value-strip">
      <div className="value-strip-inner">
        {items.map((item) => (
          <div key={item.num} className="value-card">
            <span className="value-num">{item.num}</span>
            <strong>{item.title}</strong>
            <p>{item.body}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

export default ValueStrip
