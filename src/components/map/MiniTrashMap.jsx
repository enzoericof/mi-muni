import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { fetchCollectionMap, fetchPotholesMap } from '../../lib/api'
import { useAppContext } from '../../lib/AppContext'
import { getUserLocation } from '../../lib/geolocation'
import { addGoogleMapTilesLayer } from '../../lib/googleMapTiles'

const ASU_CENTER = [-25.2867, -57.61]
const REFRESH_MS = 60_000
const POTHOLE_PREVIEW_MARKERS = [
  { id: 'p-1', lat: -25.2974, lon: -57.5878, level: 'high' },
  { id: 'p-2', lat: -25.2898, lon: -57.6122, level: 'medium' },
  { id: 'p-3', lat: -25.311, lon: -57.5986, level: 'low' },
  { id: 'p-4', lat: -25.2799, lon: -57.5692, level: 'high' },
]

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

function potholeMarkerHtml(level) {
  const palette = {
    high: { fill: '#ff5a33', halo: 'rgba(255,90,51,0.22)' },
    medium: { fill: '#44803f', halo: 'rgba(68,128,63,0.2)' },
    low: { fill: '#146152', halo: 'rgba(20,97,82,0.18)' },
  }
  const token = palette[level] || palette.low

  return `
    <div style="
      background:${token.fill};
      border:2px solid #fff;
      border-radius:50%;
      width:18px;height:18px;
      box-shadow:0 0 0 7px ${token.halo}, 0 8px 16px rgba(0,0,0,0.18);
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
    })
    resizeTimeout = window.setTimeout(() => {
      map.invalidateSize({ pan: false, animate: false })
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
        applyMunicipalityView(mapRef.current, nextData?.municipality)
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
      setPrimaryCount(POTHOLE_PREVIEW_MARKERS.length)
      for (const marker of POTHOLE_PREVIEW_MARKERS) {
        L.marker([marker.lat, marker.lon], {
          icon: L.divIcon({
            className: '',
            html: potholeMarkerHtml(marker.level),
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          }),
          interactive: false,
        }).addTo(layer)
      }
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
            : `🚛 ${primaryCount} ${primaryCount === 1 ? 'camión activo' : 'camiones activos'}`}
        </span>
        {!isPotholesMode && locationStatus === 'requesting' && (
          <span className="mini-trash-map-note">Solicitando ubicación…</span>
        )}
      </div>}
    </div>
  )
}

export default MiniTrashMap
