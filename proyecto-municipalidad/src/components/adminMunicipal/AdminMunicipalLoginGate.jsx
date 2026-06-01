import AuthMenu from '../layout/AuthMenu'
import Header from '../layout/Header'
import MunicipalitySelector from '../layout/MunicipalitySelector'

export default function AdminMunicipalLoginGate({ message, navigation, onNavigate, onLoginClick, user }) {
  return (
    <div className="municipal-app admin-muni-theme-light admin-login-theme">
      <div className="ambient ambient-left" aria-hidden="true" />
      <div className="ambient ambient-right" aria-hidden="true" />
      <div className="grid-haze" aria-hidden="true" />
      <Header
        activeSection=""
        navigation={navigation}
        onNavigate={onNavigate}
        adminShell
        suppressAdminShellNavigation
        adminActions={(
          <>
            <MunicipalitySelector />
            <AuthMenu />
          </>
        )}
      />
      <main className="page-shell page-shell-admin-muni page-shell-panel-login">
        <div className="admin-muni-shell admin-ops-shell">
          <section className="admin-ops-login-card panel-login-gate admin-login-card">
            <div className="admin-ops-login-copy">
              <span className="admin-muni-kicker">Administrador</span>
              <h2>Panel Administrador</h2>
              <p>{message || 'Iniciá sesión como administrador para gestionar cambios.'}</p>
            </div>
            <div className="admin-ops-login-actions">
              {!user && (
                <button type="button" className="admin-muni-primary-button" onClick={onLoginClick}>
                  Iniciar Sesión
                </button>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
