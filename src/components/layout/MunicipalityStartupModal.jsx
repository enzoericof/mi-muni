import { useEffect, useMemo, useState } from 'react'
import staticMunicipalities from '../../data/municipalities'
import { fetchActiveMunicipalities } from '../../lib/api'
import { useAppContext } from '../../lib/AppContext'
import MunitaCharacter from '../search/MunitaCharacter'

function MunicipalityStartupModal() {
  const { municipalityOnboardingOpen, setMunicipality, municipality } = useAppContext()
  const [options, setOptions] = useState([])

  useEffect(() => {
    if (!municipalityOnboardingOpen) return

    let cancelled = false
    fetchActiveMunicipalities()
      .then((data) => {
        if (cancelled) return
        setOptions(data?.municipalities || [])
      })
      .catch(() => {
        if (cancelled) return
        setOptions([])
      })

    return () => {
      cancelled = true
    }
  }, [municipalityOnboardingOpen])

  const municipalities = useMemo(() => {
    const byKey = new Map()

    for (const item of staticMunicipalities) {
      byKey.set(item.key, { ...item, enabled: true })
    }

    for (const item of options) {
      const staticItem = staticMunicipalities.find((candidate) => candidate.key === item.key)
      byKey.set(item.key, {
        ...(staticItem || {}),
        key: item.key,
        label: staticItem?.label || item.label,
        enabled: true,
        geoReady: item.geoReady === true || staticItem?.geoReady === true,
        centerLat: item.centerLat ?? staticItem?.centerLat ?? null,
        centerLon: item.centerLon ?? staticItem?.centerLon ?? null,
        bbox: item.bbox && Object.keys(item.bbox || {}).length ? item.bbox : (staticItem?.bbox || {}),
      })
    }

    return [...byKey.values()].filter((item) => item.enabled)
  }, [options])

  if (!municipalityOnboardingOpen) return null

  return (
    <div className="municipality-startup-backdrop" role="presentation">
      <div className="municipality-startup-modal" role="dialog" aria-modal="true" aria-label="Elegir ciudad">
        <div className="municipality-startup-head">
          <div className="municipality-startup-hero">
            <div className="municipality-startup-copy">
              <span className="municipality-startup-kicker">Bienvenido a Mi Muni</span>
              <h2>{'Eleg\u00ed tu ciudad'}</h2>
            </div>
            <MunitaCharacter className="municipality-startup-character" />
          </div>
        </div>

        <div className="municipality-startup-list">
          {municipalities.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`municipality-startup-option ${municipality?.key === item.key ? 'is-selected' : ''}`.trim()}
              onClick={() => setMunicipality(item)}
            >
              <strong>{item.label}</strong>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default MunicipalityStartupModal
