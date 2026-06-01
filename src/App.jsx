import { useMemo } from 'react'
import LandingPage from './pages/LandingPage'
import MunitaPage from './pages/MunitaPage'
import MapaPage from './pages/MapaPage'
import BachesPage from './pages/BachesPage'
import DeveloperPage from './pages/DeveloperPage'
import AdminMunicipalPage from './pages/AdminMunicipalPage'
import ProfilePage from './pages/ProfilePage'
import RecolectorPage from './pages/RecolectorPage'
import LoginModal from './components/auth/LoginModal'
import MunicipalityStartupModal from './components/layout/MunicipalityStartupModal'
import RouteTransition from './components/routing/RouteTransition'
import { useHashRoute } from './lib/router'

function App() {
  const { path } = useHashRoute()

  const page = useMemo(() => {
    if (path === '/munita') return <MunitaPage />
    if (path === '/recoleccion') return <MapaPage />
    if (path === '/baches') return <BachesPage />
    if (path === '/desarrollador') return <DeveloperPage />
    if (path === '/admin-muni') return <AdminMunicipalPage />
    if (path === '/recolector') return <RecolectorPage />
    if (path === '/perfil') return <ProfilePage />
    return <LandingPage />
  }, [path])

  return (
    <>
      <RouteTransition routeKey={path}>{page}</RouteTransition>
      <MunicipalityStartupModal />
      <LoginModal />
    </>
  )
}

export default App
