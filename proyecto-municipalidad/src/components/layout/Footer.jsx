const pendingLinks = ['Políticas de uso', 'Privacidad', 'Términos', 'Accesibilidad']

function Footer({ city, navigation, onNavigate }) {
  return (
    <footer id="info" className="site-footer">
      <div className="site-footer-main">
        <div className="site-footer-copy">
          <strong>Mi Muni</strong>
          <p>Información municipal clara para {city.label}.</p>
          <p className="site-footer-context">
            Proyecto académico desarrollado en la cátedra Ingeniería del Software, a cargo del profesor
            PhD Luca Cernuzzi.
          </p>
        </div>

        <div className="site-footer-columns">
          <div className="site-footer-column">
            <span className="site-footer-title">Créditos</span>
            <p>Desarrollo a cargo de Enzo Erico, Horacio Aranda y Federico Alonso.</p>
            <p>Mentoría a cargo de Ing. Raúl Gutiérrez e Ing. Erik Wasmosy.</p>
          </div>

          <div className="site-footer-column">
            <span className="site-footer-title">Navegación</span>
            <nav className="site-footer-nav" aria-label="Pie de página">
              {navigation.map((item) => (
                <button key={item.id} type="button" onClick={() => onNavigate(item.id)}>
                  {item.label}
                </button>
              ))}
            </nav>
          </div>

          <div className="site-footer-column">
            <span className="site-footer-title">Ciudad</span>
            <p>{city.label}, Paraguay</p>
          </div>
        </div>
      </div>

      <div className="site-footer-bottom">
        <div className="site-footer-pending" aria-label="Enlaces legales pendientes">
          {pendingLinks.map((label) => (
            <button key={label} type="button" className="site-footer-disabled" disabled>
              {label}
            </button>
          ))}
        </div>
      </div>
    </footer>
  )
}

export default Footer
