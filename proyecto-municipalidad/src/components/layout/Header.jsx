import { useEffect, useRef, useState } from 'react'
import MunicipalitySelector from './MunicipalitySelector'
import AuthMenu from './AuthMenu'

function Header({
  activeSection,
  navigation,
  onNavigate,
  adminShell = false,
  adminActions = null,
  adminNavigation = [],
  onAdminNavigate = null,
  suppressAdminShellNavigation = false,
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const headerRef = useRef(null)
  const usesPublicNavigationInAdminShell = adminShell && !suppressAdminShellNavigation && adminNavigation.length === 0
  const adminShellNavigation = usesPublicNavigationInAdminShell ? navigation : adminNavigation
  const adminShellNavigationLabel = usesPublicNavigationInAdminShell ? 'Secciones publicas' : 'Modulos del panel'

  useEffect(() => {
    if (!mobileOpen) return undefined
    const handleKey = (event) => {
      if (event.key === 'Escape') setMobileOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [mobileOpen])

  useEffect(() => {
    if (!mobileOpen) return undefined
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [mobileOpen])

  useEffect(() => {
    const headerNode = headerRef.current
    const root = document.documentElement
    if (!headerNode || !root) return undefined

    const syncHeaderHeight = () => {
      const nextHeight = `${headerNode.getBoundingClientRect().height}px`
      root.style.setProperty('--site-header-height', nextHeight)
    }

    syncHeaderHeight()

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncHeaderHeight) : null
    resizeObserver?.observe(headerNode)
    window.addEventListener('resize', syncHeaderHeight)
    window.visualViewport?.addEventListener('resize', syncHeaderHeight)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', syncHeaderHeight)
      window.visualViewport?.removeEventListener('resize', syncHeaderHeight)
    }
  }, [])

  const handleNavClick = (id) => {
    setMobileOpen(false)
    if (adminShell && !usesPublicNavigationInAdminShell) return
    onNavigate(id)
  }

  const handleAdminNavClick = (id) => {
    setMobileOpen(false)
    onAdminNavigate?.(id)
  }

  const headerClassName = [
    'site-header',
    adminShell ? 'is-admin-shell' : '',
    adminShell && adminShellNavigation.length === 0 ? 'is-admin-shell-without-nav' : '',
  ].filter(Boolean).join(' ')

  return (
    <header ref={headerRef} className={headerClassName}>
      <button
        className="brand-block"
        type="button"
        onClick={() => handleNavClick('inicio')}
        disabled={adminShell && !usesPublicNavigationInAdminShell}
      >
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 40 40" focusable="false">
            <rect className="brand-mark-bg" x="4" y="4" width="32" height="32" rx="10" />
            <path className="brand-mark-roof" d="M11.2 17.1 20 11.5l8.8 5.6" />
            <path className="brand-mark-building" d="M13.2 18.6h13.6v9.2H13.2z" />
            <path className="brand-mark-columns" d="M16.1 19.4v7.4M20 19.4v7.4M23.9 19.4v7.4" />
            <path className="brand-mark-base" d="M11.6 28.6h16.8" />
          </svg>
        </span>
        <span className="brand-copy">
          <strong>Mi Muni</strong>
        </span>
      </button>

      {!adminShell && (
        <nav className="site-nav" aria-label="Secciones">
          {navigation.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activeSection === item.id ? 'is-active' : ''}
              onClick={() => handleNavClick(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      )}

      {adminShell && adminShellNavigation.length > 0 && (
        <nav className="site-nav site-nav-admin-shell" aria-label="Módulos del panel">
          {adminShellNavigation.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activeSection === item.id ? 'is-active' : ''}
              onClick={() => {
                if (usesPublicNavigationInAdminShell) handleNavClick(item.id)
                else handleAdminNavClick(item.id)
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
      )}

      {!adminShell && (
        <div className="header-right">
          <MunicipalitySelector />
          <AuthMenu />
        </div>
      )}

      {adminShell && adminActions && (
        <div className="header-right admin-shell-header-actions">
          {adminActions}
        </div>
      )}

      <button
        type="button"
        className="hamburger-toggle"
        onClick={() => setMobileOpen(true)}
        aria-label="Abrir men\u00fa"
        aria-expanded={mobileOpen}
      >
        <span></span>
        <span></span>
        <span></span>
      </button>

      {mobileOpen && (
        <div
          className="mobile-drawer-overlay"
          role="presentation"
          onClick={() => setMobileOpen(false)}
        >
          <aside
            className="mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Men\u00fa principal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mobile-drawer-head">
              <strong>{'Men\u00fa'}</strong>
              <button
                type="button"
                className="mobile-drawer-close"
                onClick={() => setMobileOpen(false)}
                aria-label="Cerrar men\u00fa"
              >
                {'\u00d7'}
              </button>
            </div>

            <nav className="mobile-drawer-nav" aria-label={adminShell ? 'Módulos del panel' : 'Secciones'}>
              {(adminShell ? adminShellNavigation : navigation).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={activeSection === item.id ? 'is-active' : ''}
                  onClick={() => {
                    if (adminShell && !usesPublicNavigationInAdminShell) handleAdminNavClick(item.id)
                    else handleNavClick(item.id)
                  }}
                >
                  {item.label}
                </button>
              ))}
            </nav>

            <div className="mobile-drawer-divider" />

            <div className="mobile-drawer-section">
              <span className="mobile-drawer-label">Municipio</span>
              <MunicipalitySelector />
            </div>

            <div className="mobile-drawer-section">
              <span className="mobile-drawer-label">Cuenta</span>
              <AuthMenu />
            </div>
          </aside>
        </div>
      )}
    </header>
  )
}

export default Header
