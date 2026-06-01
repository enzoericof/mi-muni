import RevealSection from '../layout/RevealSection'

const sources = [
  {
    title: 'Portal Muni',
    body: 'Páginas oficiales de trámites y servicios.',
  },
  {
    title: 'Documentos',
    body: 'Formularios y requisitos en PDF público.',
  },
  {
    title: 'Portales ciudadanos',
    body: 'Recaudación, mapas e información institucional.',
  },
]

const features = [
  {
    title: 'Asistente con fuentes',
    body: 'Preguntá en lenguaje natural. Cada respuesta enlaza al documento o página oficial.',
  },
  {
    title: 'Mapa de recolección',
    body: 'Seguimiento de camiones por zona, horarios y cobertura por barrio.',
  },
  {
    title: 'Trámites organizados',
    body: 'Requisitos, costos, plazos y canales agrupados por categoría.',
  },
]

const team = [
  { role: 'Desarrollo', value: 'Enzo Erico, Horacio Aranda, Federico Alonso' },
  { role: 'Mentoría', value: 'Ing. Raúl Gutiérrez, Ing. Erik Wasmosy' },
  { role: 'Cátedra', value: 'Ingeniería del Software · PhD Luca Cernuzzi' },
]

function InfoSections({ onNavigate }) {
  return (
    <>
      <section className="info-hero">
        <div className="shell info-hero-inner">
          <span className="eyebrow">Sobre el proyecto</span>
          <h1>Una Muni más cerca, gracias a la información ordenada.</h1>
          <p className="info-lede">
            Mi Muni es un proyecto que reúne y organiza la información pública de la Municipalidad
            de Asunción para que cualquier ciudadano pueda encontrar, en segundos, lo que necesita:
            trámites, requisitos y servicios urbanos.
          </p>
        </div>
      </section>

      <RevealSection className="info-section">
        <div className="shell info-block">
          <div className="info-block-head">
            <span className="eyebrow">El problema</span>
            <h2>La información existe, pero está dispersa.</h2>
          </div>
          <p>
            La Municipalidad publica mucho: formularios, ordenanzas, requisitos, mapas y portales.
            Pero esa información está repartida en distintas páginas, subsecciones y archivos PDF,
            y eso hace que el ciudadano común pierda tiempo, o directamente desista.
          </p>
        </div>
      </RevealSection>

      <RevealSection className="info-section">
        <div className="shell info-block">
          <div className="info-block-head">
            <span className="eyebrow">Nuestra propuesta</span>
            <h2>Un solo lugar, una sola pregunta.</h2>
          </div>
          <p>
            Mi Muni centraliza esa información y la hace fácil de consultar: respondemos preguntas
            en lenguaje natural y mostramos el mapa de servicios urbanos. Siempre con enlace a la
            fuente oficial, para que puedas verificar.
          </p>

          <div className="info-features-grid">
            {features.map((feature) => (
              <div key={feature.title} className="value-card">
                <strong>{feature.title}</strong>
                <p>{feature.body}</p>
              </div>
            ))}
          </div>
        </div>
      </RevealSection>

      <RevealSection className="info-section">
        <div className="shell info-block">
          <div className="info-block-head">
            <span className="eyebrow">Fuentes oficiales</span>
            <h2>De dónde sale la información.</h2>
          </div>
          <p>
            Trabajamos exclusivamente con material público y oficial publicado por la Municipalidad
            de Asunción y portales asociados.
          </p>

          <div className="info-sources-grid">
            {sources.map((source) => (
              <div key={source.title} className="info-source-card">
                <strong>{source.title}</strong>
                <p>{source.body}</p>
              </div>
            ))}
          </div>
        </div>
      </RevealSection>

      <RevealSection className="info-section">
        <div className="shell info-block">
          <div className="info-block-head">
            <span className="eyebrow">El equipo</span>
            <h2>Proyecto académico de Ingeniería del Software.</h2>
          </div>

          <dl className="info-team">
            {team.map((entry) => (
              <div key={entry.role} className="info-team-row">
                <dt>{entry.role}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </RevealSection>

      <RevealSection className="info-section">
        <div className="shell info-cta">
          <div>
            <h2>¿Listo para empezar?</h2>
            <p>Probá Munita o consultá el mapa de recolección.</p>
          </div>
          <div className="info-cta-actions">
            <button type="button" className="btn-dark" onClick={() => onNavigate('munita')}>
              Hablar con Munita
            </button>
            <button type="button" className="btn-ghost" onClick={() => onNavigate('mapa')}>
              Ver basura
            </button>
          </div>
        </div>
      </RevealSection>
    </>
  )
}

export default InfoSections
