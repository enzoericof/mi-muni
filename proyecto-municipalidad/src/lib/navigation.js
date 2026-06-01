export const navigation = [
  { id: 'inicio', label: 'Inicio' },
  { id: 'munita', label: 'Munita' },
  { id: 'mapa', label: 'Recolecci\u00f3n' },
  { id: 'baches', label: 'Baches' },
]

const NAV_TARGETS = {
  inicio: '/',
  munita: '/munita',
  mapa: '/recoleccion',
  baches: '/baches',
}

export function makeNavigate(navigate) {
  return (id) => navigate(NAV_TARGETS[id] ?? '/')
}
