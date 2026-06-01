import { useEffect, useMemo, useState, useCallback } from 'react'

const ROUTE_CHANGE_EVENT = 'mimuni:routechange'

const ROUTE_ALIASES = {
  '/ciudad': '/',
  '/mapa': '/recoleccion',
  '/mapa-basura': '/recoleccion',
  '/admin': '/desarrollador',
  '/admin-interno': '/desarrollador',
  '/admin-recoleccion': '/desarrollador',
}

function normalize(rawUrl) {
  let value = rawUrl || '/'
  if (value.startsWith('#')) value = value.slice(1)
  if (!value.startsWith('/')) value = `/${value}`

  const [pathPart, queryPart = ''] = value.split('?')
  const aliased = ROUTE_ALIASES[pathPart] ?? pathPart
  const path = aliased === '' ? '/' : aliased

  const params = {}
  if (queryPart) {
    const search = new URLSearchParams(queryPart)
    for (const [key, val] of search.entries()) {
      params[key] = val
    }
  }

  const canonicalPath = queryPart ? `${path}?${queryPart}` : path
  return { path, params, query: queryPart, canonicalPath }
}

function readCurrent() {
  if (typeof window === 'undefined') return { path: '/', params: {}, query: '', canonicalPath: '/' }

  const legacyHash = String(window.location.hash || '')
  if (legacyHash.startsWith('#/')) {
    return normalize(legacyHash.slice(1))
  }

  return normalize(`${window.location.pathname}${window.location.search}`)
}

export function buildPath(path, params) {
  const safePath = path.startsWith('/') ? path : `/${path}`
  if (!params || Object.keys(params).length === 0) return safePath

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `${safePath}?${qs}` : safePath
}

export function useHashRoute() {
  const [route, setRoute] = useState(readCurrent)

  useEffect(() => {
    const handleChange = () => {
      const nextRoute = readCurrent()
      const currentPath = `${window.location.pathname}${window.location.search}`
      const hasLegacyHash = String(window.location.hash || '').startsWith('#/')

      if (currentPath !== nextRoute.canonicalPath || hasLegacyHash) {
        window.history.replaceState(null, '', nextRoute.canonicalPath)
      }
      setRoute(nextRoute)
    }
    handleChange()
    window.addEventListener(ROUTE_CHANGE_EVENT, handleChange)
    window.addEventListener('popstate', handleChange)
    window.addEventListener('hashchange', handleChange)
    return () => {
      window.removeEventListener(ROUTE_CHANGE_EVENT, handleChange)
      window.removeEventListener('popstate', handleChange)
      window.removeEventListener('hashchange', handleChange)
    }
  }, [])

  const navigate = useCallback((path, options = {}) => {
    const { params, replace = false } = options
    const nextPath = buildPath(path, params)
    if (replace) {
      window.history.replaceState(null, '', nextPath)
    } else {
      window.history.pushState(null, '', nextPath)
    }
    window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT))
    setRoute(normalize(nextPath))
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [])

  return useMemo(() => ({ ...route, navigate }), [route, navigate])
}
