import { useEffect, useMemo, useState } from 'react'
import Header from '../components/layout/Header'
import Footer from '../components/layout/Footer'
import QuickAccessGrid from '../components/home/QuickAccessGrid'
import ResultsPanel from '../components/search/ResultsPanel'
import quickAccessItems from '../data/quickAccess'
import { fetchProcedureById } from '../lib/api'
import { useAppContext } from '../lib/AppContext'
import { useHashRoute } from '../lib/router'
import { navigation, makeNavigate } from '../lib/navigation'

function TramitesPage() {
  const defaultQuickAccess = quickAccessItems[0]
  const { municipality } = useAppContext()
  const { navigate } = useHashRoute()
  const handleNavigate = makeNavigate(navigate)

  const [selectedQuickAccess, setSelectedQuickAccess] = useState(defaultQuickAccess.id)
  const [searchState, setSearchState] = useState('searching')
  const [results, setResults] = useState([])

  useEffect(() => {
    let cancelled = false

    async function loadInitialProcedure() {
      setSearchState('searching')
      try {
        const result = await fetchProcedureById(defaultQuickAccess.id)
        if (cancelled) return
        setResults(result ? [result] : [])
        setSearchState(result ? 'results' : 'empty')
      } catch (_error) {
        if (cancelled) return
        setResults([])
        setSearchState('error')
      }
    }

    loadInitialProcedure()
    return () => {
      cancelled = true
    }
  }, [defaultQuickAccess.id])

  const handleQuickAccess = async (item) => {
    setSelectedQuickAccess(item.id)
    setSearchState('searching')

    try {
      const result = await fetchProcedureById(item.id)
      setResults(result ? [result] : [])
      setSearchState(result ? 'results' : 'empty')
    } catch (_error) {
      setResults([])
      setSearchState('error')
    }
  }

  const quickAccess = useMemo(
    () => quickAccessItems.map((item) => ({ ...item, selected: item.id === selectedQuickAccess })),
    [selectedQuickAccess],
  )

  return (
    <div className="municipal-app">
      <div className="ambient ambient-left" aria-hidden="true" />
      <div className="ambient ambient-right" aria-hidden="true" />
      <div className="grid-haze" aria-hidden="true" />

      <Header activeSection="tramites" navigation={navigation} onNavigate={handleNavigate} />

      <main className="page-shell page-shell-tramites">
        <section className="content-section">
          <div className="section-heading">
            <span className="section-eyebrow section-pill">Info</span>
            <h2>¿Qué trámite necesitás?</h2>
          </div>

          <div className="tramite-explorer">
            <aside className="tramite-nav">
              <span className="tramite-nav-label">Accesos rápidos</span>
              <QuickAccessGrid items={quickAccess} onSelect={handleQuickAccess} />
            </aside>

            <div className="tramite-result">
              <ResultsPanel state={searchState} results={results} />
            </div>
          </div>
        </section>

      </main>

      <Footer city={municipality} navigation={navigation} onNavigate={handleNavigate} />
    </div>
  )
}

export default TramitesPage
