import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { fetchCollectionMap, fetchPotholesMap } from '../../lib/api'
import { useAppContext } from '../../lib/AppContext'
import { getUserLocation } from '../../lib/geolocation'
import { addGoogleMapTilesLayer } from '../../lib/googleMapTiles'

const ASU_CENTER = [-25.2867, -57.61]
const REFRESH_MS = 60_000

function truckMarkerHtml(color) {
  return `
    <div style="
      background:${color};
      border:2px solid #fff;
      border-radius:50%;
      width:24px;height:24px;
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 2px 6px rgba(0,0,0,0.32);
      font-size:13px;
    ">&#128666;</div>`
}

function userMarkerHtml() {
  return `
    <div style="
      background:#ff5a33;
      border:3px solid #fff;
      border-radius:50%;
      width:18px;height:18px;
      box-shadow:0 0 0 6px rgba(255,90,51,0.22);
    "></div>`
}

function routeColor(color) {
  return color && color.startsWith('#') ? color : `#${color || '44803f'}`
}

function applyMunicipalityView(map, municipality) {
  if (!map || !municipality) return

  const bbox = municipality?.bbox
  if (
    Number.isFinite(Number(bbox?.minLat)) &&
    Number.isFinite(Number(bbox?.maxLat)) &&
    Number.isFinite(Number(bbox?.minLon)) &&
    Number.isFinite(Number(bbox?.maxLon))
  ) {
    map.fitBounds([
      [Number(bbox.minLat), Number(bbox.minLon)],
      [Number(bbox.maxLat), Number(bbox.maxLon)],
    ], { padding: [12, 12], maxZoom: 13 })
    return
  }

  if (Number.isFinite(Number(municipality?.centerLat)) && Number.isFinite(Number(municipality?.centerLon))) {
    map.setView([Number(municipality.centerLat), Number(municipality.centerLon)], 12)
  }
}

function MiniTrashMap({ mode = 'collection', showOverlay = true, showMarkers = true }) {
  const { municipality } = useAppContext()
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const layersRef = useRef({ markers: null, user: null })
  const userLocationRef = useRef(null)
  const [mapData, setMapData] = useState(null)
  const [locationStatus, setLocationStatus] = useState('idle')
  const [primaryCount, setPrimaryCount] = useState(0)
  const isPotholesMode = mode === 'potholes'

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined

    let cancelled = false
    let baseLayer = null
    let resizeFrame = 0
    let resizeTimeout = 0
    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: true,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      keyboard: false,
    }).setView(ASU_CENTER, 12)

    void addGoogleMapTilesLayer(L, map, { maxZoom: 18 }).then((result) => {
      if (cancelled) {
        result.layer?.remove()
        return
      }
      baseLayer = result.layer
    })

    layersRef.current.markers = L.layerGroup().addTo(map)
    layersRef.current.user = L.layerGroup().addTo(map)
    mapRef.current = map

    // Leaflet previews inside hero cards sometimes mount before layout settles.
    // Re-invalidating the size avoids partially painted or blank mini maps.
    resizeFrame = window.requestAnimationFrame(() => {
      map.invalidateSize({ pan: false, animate: false })
      applyMunicipalityView(map, municipality)
    })
    resizeTimeout = window.setTimeout(() => {
      map.invalidateSize({ pan: false, animate: false })
      applyMunicipalityView(map, municipality)
    }, 180)

    return () => {
      cancelled = true
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame)
      if (resizeTimeout) window.clearTimeout(resizeTimeout)
      baseLayer?.remove()
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    applyMunicipalityView(mapRef.current, municipality)
  }, [
    municipality?.key,
    municipality?.centerLat,
    municipality?.centerLon,
    municipality?.bbox?.minLat,
    municipality?.bbox?.maxLat,
    municipality?.bbox?.minLon,
    municipality?.bbox?.maxLon,
  ])

  useEffect(() => {
    if (isPotholesMode || !showMarkers) return undefined

    let cancelled = false
    setLocationStatus('requesting')

    getUserLocation()
      .then((coords) => {
        if (cancelled) return
        userLocationRef.current = coords
        setLocationStatus('granted')

        const map = mapRef.current
        if (map && !municipality?.key) {
          map.setView([coords.lat, coords.lon], 13)
          const layer = layersRef.current.user
          if (layer) {
            layer.clearLayers()
            L.marker([coords.lat, coords.lon], {
              icon: L.divIcon({ className: '', html: userMarkerHtml(), iconSize: [18, 18], iconAnchor: [9, 9] }),
              interactive: false,
            }).addTo(layer)
          }
        }
      })
      .catch(() => {
        if (cancelled) return
        setLocationStatus('denied')
      })

    return () => {
      cancelled = true
    }
  }, [isPotholesMode, municipality?.key, showMarkers])

  useEffect(() => {
    let cancelled = false
    let timer = null

    async function tick() {
      let nextData = null
      try {
        nextData = isPotholesMode
          ? await fetchPotholesMap({ municipalitySlug: municipality?.key || '' })
          : await fetchCollectionMap({ municipalitySlug: municipality?.key || '' })
        if (cancelled) return
        setMapData(nextData)
        applyMunicipalityView(mapRef.current, nextData?.municipality || municipality)
      } catch (_error) {
        // silencioso: es solo preview
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(tick, REFRESH_MS)
        }
      }
    }

    tick()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [isPotholesMode, municipality?.key])

  useEffect(() => {
    const map = mapRef.current
    const layer = layersRef.current.markers
    if (!map || !layer) return

    layer.clearLayers()

    if (!showMarkers) {
      setPrimaryCount(0)
      return
    }

    if (isPotholesMode) {
      setPrimaryCount(0)
      return
    }

    if (!mapData) {
      setPrimaryCount(0)
      return
    }

    const vehicles = mapData.vehicles || []
    setPrimaryCount(vehicles.length)

    for (const vehicle of vehicles) {
      L.marker([vehicle.currentLat, vehicle.currentLon], {
        icon: L.divIcon({
          className: '',
          html: truckMarkerHtml(routeColor(vehicle.routeColor)),
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
        interactive: false,
      }).addTo(layer)
    }
  }, [isPotholesMode, mapData, showMarkers])

  return (
    <div className={`mini-trash-map ${isPotholesMode ? 'is-potholes' : ''}`}>
      <div
        ref={containerRef}
        className="mini-trash-map-canvas"
        aria-label={isPotholesMode ? 'Mapa de baches' : 'Mapa de recolección'}
      />
      {showOverlay && <div className="mini-trash-map-overlay">
        <span className={`mini-trash-map-pill ${isPotholesMode ? '' : 'is-collection'}`.trim()}>
          {isPotholesMode
            ? `${primaryCount} zonas priorizadas`
            : `🚚 ${primaryCount} ${primaryCount === 1 ? 'camión activo' : 'camiones activos'}`}
        </span>
        {!isPotholesMode && locationStatus === 'requesting' && (
          <span className="mini-trash-map-note">Solicitando ubicación…</span>
        )}
      </div>}
    </div>
  )
}

export default MiniTrashMap
