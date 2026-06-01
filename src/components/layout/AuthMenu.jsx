import { useEffect, useRef, useState } from 'react'
import { useAppContext } from '../../lib/AppContext'
import { useHashRoute } from '../../lib/router'
import { getUserRoles, userHasRole } from '../../lib/roles'

function getInitials(name) {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((part) => part.charAt(0).toUpperCase()).join('')
}

function formatDisplayName(name) {
  return String(name || '').replace(/\bAdministracion\b/g, 'Administración')
}

const ROLE_LABELS = {
  admin: 'Administrador',
  desarrollador: 'Desarrollador',
  recolector: 'Recolector',
  difusor: 'Difusor',
}

const ROLE_ORDER = ['admin', 'desarrollador', 'recolector', 'difusor']

function formatRoles(roles) {
  const roleSet = new Set(roles)
  return ROLE_ORDER
    .filter((role) => roleSet.has(role))
    .map((role) => ROLE_LABELS[role])
    .join(', ')
}

function AuthMenu() {
  const { user, logout, openLoginModal } = useAppContext()
  const { path, navigate } = useHashRoute()
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const handleClick = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  if (!user) {
    return (
      <button type="button" className="auth-button" onClick={() => openLoginModal()}>
        Iniciar Sesión
      </button>
    )
  }

  const handleLogout = async () => {
    await logout()
    setOpen(false)
  }

  const goTo = (path) => {
    navigate(path)
    setOpen(false)
  }

  const roles = getUserRoles(user)
  const roleSummary = formatRoles(roles)
  const displayName = formatDisplayName(user.name)
  const isPublicView = ['/', '/munita', '/recoleccion', '/baches', '/perfil'].includes(path)
  const menuItems = [
    ...(isPublicView ? [{ key: 'profile', label: 'Mi Perfil', path: '/perfil' }] : []),
    ...(!isPublicView && (userHasRole(user, 'admin') || userHasRole(user, 'desarrollador') || userHasRole(user, 'recolector'))
      ? [{ key: 'public', label: 'Vista Pública', path: '/' }]
      : []),
    ...(userHasRole(user, 'admin')
      ? [{ key: 'admin', label: 'Panel Administrador', path: '/admin-muni' }]
      : []),
    ...(userHasRole(user, 'desarrollador')
      ? [{ key: 'developer', label: 'Panel Desarrollador', path: '/desarrollador' }]
      : []),
    ...(userHasRole(user, 'recolector')
      ? [{ key: 'collector', label: 'Panel Recolector', path: '/recolector' }]
      : []),
  ]

  return (
    <div className="auth-menu" ref={containerRef}>
      <button
        type="button"
        className="auth-menu-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="auth-avatar" aria-hidden="true">{getInitials(displayName)}</span>
        <span className="auth-name">Hola, {displayName.split(' ')[0]}</span>
        <span className="auth-caret" aria-hidden="true">{'\u25be'}</span>
      </button>

      {open && (
        <div className="auth-menu-popover" role="menu">
          <div className="auth-menu-header">
            <strong>{displayName}</strong>
            <small>{user.email}</small>
            {roleSummary ? <small>Roles: {roleSummary}</small> : null}
          </div>

          {menuItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className="auth-menu-item"
              onClick={() => goTo(item.path)}
              role="menuitem"
            >
              {item.label}
            </button>
          ))}

          <button type="button" className="auth-menu-item" onClick={handleLogout} role="menuitem">
            Cerrar Sesión
          </button>
        </div>
      )}
    </div>
  )
}

export default AuthMenu
