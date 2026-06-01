import { useLayoutEffect } from 'react'
import Header from '../components/layout/Header'
import Footer from '../components/layout/Footer'
import SplitHero from '../components/home/SplitHero'
import { useAppContext } from '../lib/AppContext'
import { useHashRoute } from '../lib/router'
import { navigation, makeNavigate } from '../lib/navigation'

function LandingPage() {
  const { municipality } = useAppContext()
  const { navigate } = useHashRoute()
  const handleNavigate = makeNavigate(navigate)

  useLayoutEffect(() => {
    const resetScroll = () => window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    const previous = 'scrollRestoration' in window.history ? window.history.scrollRestoration : null

    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual'
    }

    resetScroll()
    const rafId = window.requestAnimationFrame(resetScroll)
    const timeoutId = window.setTimeout(resetScroll, 80)

    const handlePageShow = () => resetScroll()
    window.addEventListener('pageshow', handlePageShow)

    return () => {
      window.cancelAnimationFrame(rafId)
      window.clearTimeout(timeoutId)
      window.removeEventListener('pageshow', handlePageShow)
      if (previous) {
        window.history.scrollRestoration = previous
      }
    }
  }, [])

  return (
    <div className="municipal-app">
      <div className="ambient ambient-left" aria-hidden="true" />
      <div className="ambient ambient-right" aria-hidden="true" />
      <div className="grid-haze" aria-hidden="true" />

      <Header activeSection="inicio" navigation={navigation} onNavigate={handleNavigate} />

      <main className="page-shell page-shell-landing">
        <SplitHero />
      </main>

      <Footer city={municipality} navigation={navigation} onNavigate={handleNavigate} />
    </div>
  )
}

export default LandingPage
