import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import AuthMenu from '../components/layout/AuthMenu'
import Header from '../components/layout/Header'
import MunicipalitySelector from '../components/layout/MunicipalitySelector'
import {
  broadcastRecolectorNotifications,
  fetchCollectionMap,
  fetchCollectionOverview,
  fetchCollectionZones,
  fetchGtfsShapes,
  fetchRecolectorProfile,
  sendRecolectorPosition,
  startRecolectorShift,
  stopRecolectorShift,
  stopRecolectorShiftOnExit,
} from '../lib/api'
import { useAppContext } from '../lib/AppContext'
import { getUserLocation } from '../lib/geolocation'
import { addGoogleMapTilesLayer } from '../lib/googleMapTiles'
import { makeNavigate, navigation } from '../lib/navigation'
import { userHasRole } from '../lib/roles'
import { useHashRoute } from '../lib/router'

const GPS_INTERVAL_MS = 1000
const GPS_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 9000 }
const BARRIO_DETECTION_FALLBACK_METERS = 4500

function formatTime(value) {
  if (!value) return 'Sin datos'
  return new Date(value).toLocaleTimeString('es-PY', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function normalizePoint(point) {
  if (Array.isArray(point)) return { lat: Number(point[0]), lon: Number(point[1]) }
  return {
    lat: Number(point?.lat ?? point?.currentLat ?? point?.centerLat),
    lon: Number(point?.lon ?? point?.currentLon ?? point?.centerLon),
  }
}

function isValidPoint(point) {
  return Number.isFinite(point?.lat) && Number.isFinite(point?.lon)
}

function normalizeLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase()
}

function pointInRing([lat, lon], ring = []) {
  const x = lon
  const y = lat
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersects = yi > y !== yj > y
      && x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function polygonContainsLatLon(polygon, lat, lon) {
  const rings = Array.isArray(polygon) ? polygon : []
  if (!rings.length) return false
  const outerRing = rings[0].map(([ringLon, ringLat]) => [ringLon, ringLat])
  const insideOuter = pointInRing([lat, lon], outerRing)
  if (!insideOuter) return false
  return !rings.slice(1).some((ring) => pointInRing([lat, lon], ring.map(([ringLon, ringLat]) => [ringLon, ringLat])))
}

function geometryContainsLatLon(geometry, lat, lon) {
  const { type, coordinates } = geometry || {}
  if (!type || !coordinates) return false

  if (type === 'Polygon') {
    return polygonContainsLatLon(coordinates, lat, lon)
  }

  if (type === 'MultiPolygon') {
    return coordinates.some((polygon) => polygonContainsLatLon(polygon, lat, lon))
  }

  return false
}

function haversineDistanceMeters(a, b) {
  if (!isValidPoint(a) || !isValidPoint(b)) return Number.POSITIVE_INFINITY
  const toRad = (value) => (value * Math.PI) / 180
  const earthRadius = 6371000
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * earthRadius * Math.asin(Math.sqrt(h))
}

function nearestZoneForPoint(point, features = [], zones = []) {
  let best = null
  for (const feature of features) {
    const zone = zoneFromFeature(feature, zones)
    const center = normalizePoint(zone)
    if (!zone || !isValidPoint(center)) continue
    const distanceMeters = haversineDistanceMeters(point, center)
    if (!best || distanceMeters < best.distanceMeters) {
      best = { zone, distanceMeters }
    }
  }
  return best?.distanceMeters <= BARRIO_DETECTION_FALLBACK_METERS ? best.zone : null
}

function featureContainsPoint(feature, point) {
  const normalized = normalizePoint(point)
  if (!feature?.geometry || !isValidPoint(normalized)) return false
  return geometryContainsLatLon(feature.geometry, normalized.lat, normalized.lon)
}

function matchZoneRecord(zones, feature) {
  const candidates = [
    feature?.properties?.id,
    feature?.properties?.slug,
    feature?.properties?.nombre,
    feature?.properties?.label,
  ].map(normalizeLabel).filter(Boolean)
  return zones.find((zone) =>
    candidates.includes(normalizeLabel(zone.id)) || candidates.includes(normalizeLabel(zone.label)),
  ) || null
}

function geometryCenter(geometry) {
  const coords = []
  const visit = (value) => {
    if (!Array.isArray(value)) return
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      coords.push({ lon: Number(value[0]), lat: Number(value[1]) })
      return
    }
    value.forEach(visit)
  }
  visit(geometry?.coordinates)
  if (!coords.length) return null
  const totals = coords.reduce((acc, coord) => ({
    lat: acc.lat + coord.lat,
    lon: acc.lon + coord.lon,
  }), { lat: 0, lon: 0 })
  return {
    lat: totals.lat / coords.length,
    lon: totals.lon / coords.length,
  }
}

function zoneFromFeature(feature, zones = []) {
  if (!feature) return null
  const zoneRecord = matchZoneRecord(zones, feature)
  const fallbackCenter = geometryCenter(feature.geometry)
  const label = zoneRecord?.label || feature.properties?.nombre || feature.properties?.label || feature.properties?.slug || 'Barrio detectado'
  const id = zoneRecord?.id || feature.properties?.slug || feature.properties?.id || label
  return {
    ...(zoneRecord || {}),
    id: String(id),
    label: String(label),
    centerLat: zoneRecord?.centerLat ?? fallbackCenter?.lat,
    centerLon: zoneRecord?.centerLon ?? fallbackCenter?.lon,
    feature,
  }
}

function detectZoneForPoint(point, features = [], zones = []) {
  if (!isValidPoint(point)) return null
  const feature = features.find((candidate) => featureContainsPoint(candidate, point))
  return zoneFromFeature(feature, zones) || nearestZoneForPoint(point, features, zones)
}

function clipRouteToFeature(coords, feature) {
  if (!feature?.geometry || coords.length < 2) return []

  const segments = []
  let currentSegment = []

  for (let index = 0; index < coords.length - 1; index += 1) {
    const start = coords[index]
    const end = coords[index + 1]
    const startInside = geometryContainsLatLon(feature.geometry, start[0], start[1])
    const endInside = geometryContainsLatLon(feature.geometry, end[0], end[1])
    const midpoint = [
      (start[0] + end[0]) / 2,
      (start[1] + end[1]) / 2,
    ]
    const midpointInside = geometryContainsLatLon(feature.geometry, midpoint[0], midpoint[1])

    if (startInside || endInside || midpointInside) {
      if (!currentSegment.length) currentSegment.push(start)
      currentSegment.push(end)
      continue
    }

    if (currentSegment.length >= 2) segments.push(currentSegment)
    currentSegment = []
  }

  if (currentSegment.length >= 2) segments.push(currentSegment)
  return segments
}

function normalizeRoutePoint(point) {
  const normalized = normalizePoint(point)
  return isValidPoint(normalized) ? [normalized.lat, normalized.lon] : null
}

function getRouteLayer(overview) {
  return overview?.routeLayers?.frequent || overview?.routeLayers?.latest || null
}

function getRouteFromOverview(overview, zone) {
  const layer = getRouteLayer(overview)
  const routeId = layer?.routeId || overview?.zone?.routeIds?.[0] || `REC-${zone?.id || 'manual'}`
  return {
    routeId,
    routeLabel: layer?.longName || layer?.shortName || `Ruta ${routeId}`,
    routeShortName: layer?.shortName || routeId,
    routeColor: layer?.color || '#146152',
    shapeId: layer?.shapeId || '',
    shapePoints: (layer?.shapePoints || []).map(normalizePoint).filter(isValidPoint),
  }
}

function truckIcon(isOnline) {
  return L.divIcon({
    className: '',
    html: `
      <div class="recolector-truck-marker ${isOnline ? 'is-online' : ''}">
        <img src="/trash-truck-reference.svg" alt="" draggable="false" />
      </div>
    `,
    iconSize: [54, 54],
    iconAnchor: [27, 27],
    popupAnchor: [0, -26],
  })
}

function RecolectorLiveMap({ zone, route, zoneFeature, routeSegments = [], currentPoint, online }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const routeLayerRef = useRef(null)
  const zoneLayerRef = useRef(null)
  const truckMarkerRef = useRef(null)
  const truckOnlineRef = useRef(null)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined
    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: true,
      scrollWheelZoom: true,
      dragging: true,
      tap: true,
      touchZoom: true,
      doubleClickZoom: true,
    })
    mapRef.current = map
    void addGoogleMapTilesLayer(L, map, { maxZoom: 19 })

    return () => {
      map.remove()
      mapRef.current = null
      routeLayerRef.current = null
      zoneLayerRef.current = null
      truckMarkerRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (routeLayerRef.current) {
      routeLayerRef.current.remove()
      routeLayerRef.current = null
    }
    if (zoneLayerRef.current) {
      zoneLayerRef.current.remove()
      zoneLayerRef.current = null
    }

    const routeLayers = routeSegments
      .map((segment) => segment.filter((point) => Array.isArray(point) && point.every(Number.isFinite)))
      .filter((segment) => segment.length > 1)

    if (zoneFeature?.geometry) {
      zoneLayerRef.current = L.geoJSON(zoneFeature, {
        interactive: false,
        style: {
          color: '#ff5a33',
          weight: 3,
          opacity: 0.9,
          fillColor: '#ff8b72',
          fillOpacity: 0.12,
        },
      }).addTo(map)
    }

    const zonePoint = normalizePoint(zone)
    const boundsPoints = [
      ...routeLayers.flat(),
      ...(isValidPoint(zonePoint) ? [[zonePoint.lat, zonePoint.lon]] : []),
    ]

    if (zoneLayerRef.current) {
      map.fitBounds(zoneLayerRef.current.getBounds(), { padding: [28, 28], maxZoom: 15, animate: false })
    } else if (boundsPoints.length > 1) {
      map.fitBounds(L.latLngBounds(boundsPoints), { padding: [28, 28], maxZoom: 15, animate: false })
    } else if (boundsPoints.length === 1) {
      map.setView(boundsPoints[0], 14)
    }

    window.setTimeout(() => map.invalidateSize({ pan: false }), 60)
  }, [route, routeSegments, zone, zoneFeature])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!isValidPoint(currentPoint)) {
      if (truckMarkerRef.current) {
        truckMarkerRef.current.remove()
        truckMarkerRef.current = null
        truckOnlineRef.current = null
      }
      return
    }

    const nextLatLng = [currentPoint.lat, currentPoint.lon]
    if (!truckMarkerRef.current) {
      truckMarkerRef.current = L.marker(nextLatLng, {
        icon: truckIcon(online),
        zIndexOffset: 600,
      }).addTo(map)
      truckOnlineRef.current = online
      if (online) {
        map.panTo(nextLatLng, { animate: true, duration: 0.45 })
      }
      return
    }

    truckMarkerRef.current.setLatLng(nextLatLng)
    if (truckOnlineRef.current !== online) {
      truckMarkerRef.current.setIcon(truckIcon(online))
      truckOnlineRef.current = online
    }
  }, [currentPoint, online])

  useEffect(() => {
    return () => {
      if (truckMarkerRef.current) {
        truckMarkerRef.current.remove()
        truckMarkerRef.current = null
      }
    }
  }, [])

  return <div className="recolector-real-map" ref={containerRef} aria-label="Mapa real del recorrido seleccionado" />
}

function RecolectorGate() {
  const { user, openLoginModal } = useAppContext()

  return (
    <section className="admin-ops-login-card panel-login-gate recolector-login-card">
      <div className="admin-ops-login-copy">
        <span className="admin-muni-kicker">Recolector</span>
        <h2>{user ? 'Tu usuario no tiene acceso a este panel' : 'Panel Recolector'}</h2>
        <p>
          {user
            ? 'Este espacio está reservado para usuarios con perfil de recolector.'
            : 'Iniciá sesión como recolector para iniciar viajes.'}
        </p>
      </div>
      {!user ? (
        <div className="admin-ops-login-actions">
          <button type="button" className="admin-muni-primary-button" onClick={() => openLoginModal()}>
            Iniciar Sesión
          </button>
        </div>
      ) : null}
    </section>
  )
}

function RecolectorDashboard() {
  const { municipality } = useAppContext()
  const [mapData, setMapData] = useState(null)
  const [barrios, setBarrios] = useState([])
  const [serviceZones, setServiceZones] = useState([])
  const [selectedZoneId, setSelectedZoneId] = useState('')
  const [overview, setOverview] = useState(null)
  const [routeSegments, setRouteSegments] = useState([])
  const [shift, setShift] = useState(null)
  const [currentPoint, setCurrentPoint] = useState(null)
  const [gpsStatus, setGpsStatus] = useState('idle')
  const [notifyStatus, setNotifyStatus] = useState('idle')
  const [notifyZoneIds, setNotifyZoneIds] = useState([])
  const [message, setMessage] = useState('')
  const [lastPulseAt, setLastPulseAt] = useState('')
  const [error, setError] = useState('')
  const timerRef = useRef(null)
  const watchRef = useRef(null)
  const shiftRef = useRef(null)
  const currentPointRef = useRef(null)
  const barriosRef = useRef([])
  const zonesRef = useRef([])
  const selectedZoneIdRef = useRef('')
  const shapeCacheRef = useRef(new Map())
  const mountedRef = useRef(false)
  const positionReadingRef = useRef(false)
  const positionSendingRef = useRef(false)

  const zones = serviceZones.length ? serviceZones : mapData?.zones || []
  const selectedZone = zones.find((zone) => zone.id === selectedZoneId) || zones[0] || null
  const selectedZoneFeature = useMemo(() => {
    const zoneRecord = selectedZone || { id: selectedZoneId, label: selectedZoneId }
    return barrios.find((feature) => {
      const detected = zoneFromFeature(feature, zones)
      return detected?.id === zoneRecord.id || normalizeLabel(detected?.label) === normalizeLabel(zoneRecord.label)
    }) || null
  }, [barrios, selectedZone, selectedZoneId, zones])
  const selectedRoute = useMemo(() => getRouteFromOverview(overview, selectedZone), [overview, selectedZone])
  const online = shift?.status === 'online'
  const canStart = Boolean(barrios.length && selectedRoute.routeId && !online)
  const canNotify = Boolean(notifyZoneIds.length && notifyStatus !== 'sending')

  function resolveDetectedZone(point) {
    const activeBarrios = barriosRef.current.length ? barriosRef.current : barrios
    const activeZones = zonesRef.current.length ? zonesRef.current : zones
    const detected = detectZoneForPoint(point, activeBarrios, activeZones)
    if (!detected) return null
    if (detected.id !== selectedZoneIdRef.current) {
      selectedZoneIdRef.current = detected.id
      setSelectedZoneId(detected.id)
    }
    return detected
  }

  useEffect(() => {
    mountedRef.current = true
    const handlePageHide = () => {
      const activeShift = shiftRef.current
      stopGpsLoop()
      if (activeShift?.id && activeShift.status === 'online') {
        stopRecolectorShiftOnExit(activeShift.id)
      }
    }
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      mountedRef.current = false
      window.removeEventListener('pagehide', handlePageHide)
      const activeShift = shiftRef.current
      stopGpsLoop()
      if (activeShift?.id && activeShift.status === 'online') {
        stopRecolectorShiftOnExit(activeShift.id)
      }
    }
  }, [])

  useEffect(() => {
    shiftRef.current = shift
  }, [shift])

  useEffect(() => {
    barriosRef.current = barrios
  }, [barrios])

  useEffect(() => {
    zonesRef.current = zones
  }, [zones])

  useEffect(() => {
    selectedZoneIdRef.current = selectedZoneId
  }, [selectedZoneId])

  useEffect(() => {
    currentPointRef.current = currentPoint
  }, [currentPoint])

  useEffect(() => {
    if (barrios.length && isValidPoint(currentPoint)) {
      resolveDetectedZone(currentPoint)
    }
  }, [barrios, currentPoint])

  useEffect(() => {
    let cancelled = false
    async function loadPanel() {
      setGpsStatus('loading')
      setError('')
      try {
        const [nextMap, nextProfile] = await Promise.all([
          fetchCollectionMap({ municipalitySlug: municipality?.key || 'asuncion' }),
          fetchRecolectorProfile(),
        ])
        if (cancelled) return
        setMapData(nextMap)
        setShift(nextProfile?.activeShift || null)
        const firstZoneId = nextProfile?.activeShift?.barrioSlug || ''
        setSelectedZoneId(firstZoneId)
        setCurrentPoint(
          nextProfile?.activeShift?.lastLat && nextProfile?.activeShift?.lastLon
            ? { lat: nextProfile.activeShift.lastLat, lon: nextProfile.activeShift.lastLon }
            : null,
        )
        setGpsStatus('ready')
      } catch (loadError) {
        if (cancelled) return
        setGpsStatus('error')
        setError(loadError.message || 'No se pudo cargar el panel del recolector.')
      }
    }
    void loadPanel()
    return () => {
      cancelled = true
    }
  }, [municipality?.key])

  useEffect(() => {
    let cancelled = false
    async function loadZones() {
      try {
        const payload = await fetchCollectionZones({
          municipalitySlug: municipality?.key || 'asuncion',
          includeGeometry: true,
        })
        if (cancelled) return
        setBarrios(payload.features || [])
        setServiceZones(payload.zones || [])
        setNotifyZoneIds((current) => current.filter((zoneId) => (payload.zones || []).some((zone) => zone.id === zoneId)))
        if (!selectedZoneIdRef.current && payload.zones?.[0]?.id) {
          selectedZoneIdRef.current = payload.zones[0].id
          setSelectedZoneId(payload.zones[0].id)
        }
      } catch (_loadError) {
        if (!cancelled) {
          setBarrios([])
          setServiceZones([])
        }
      }
    }
    void loadZones()
    return () => {
      cancelled = true
    }
  }, [municipality?.key])

  useEffect(() => {
    if (!selectedZoneId) return undefined
    let cancelled = false
    async function loadOverview() {
      try {
        const nextOverview = await fetchCollectionOverview(selectedZoneId, { municipalitySlug: municipality?.key || 'asuncion' })
        if (!cancelled) setOverview(nextOverview)
      } catch (_error) {
        if (!cancelled) setOverview(null)
      }
    }
    void loadOverview()
    return () => {
      cancelled = true
    }
  }, [municipality?.key, selectedZoneId])

  useEffect(() => {
    let cancelled = false
    async function loadRouteSegments() {
      const layer = getRouteLayer(overview)
      const fallbackPoints = [
        ...(layer?.shapePoints || []),
        ...(overview?.zone?.stopMarkers || []),
      ].map(normalizeRoutePoint).filter(Boolean)

      let coords = fallbackPoints
      if (layer?.shapeId) {
        if (shapeCacheRef.current.has(layer.shapeId)) {
          coords = shapeCacheRef.current.get(layer.shapeId)
        } else {
          try {
            const shapes = await fetchGtfsShapes(layer.shapeId)
            const nextCoords = (shapes || [])
              .map((point) => normalizeRoutePoint({
                lat: point.lat ?? point.shape_pt_lat,
                lon: point.lon ?? point.shape_pt_lon,
              }))
              .filter(Boolean)
            shapeCacheRef.current.set(layer.shapeId, nextCoords)
            coords = nextCoords
          } catch (_shapeError) {
            coords = fallbackPoints
          }
        }
      }

      if (cancelled) return
      setRouteSegments(selectedZoneFeature ? clipRouteToFeature(coords, selectedZoneFeature) : [])
    }

    void loadRouteSegments()
    return () => {
      cancelled = true
    }
  }, [overview, selectedZoneFeature])

  useEffect(() => {
    if (online) startRealGpsLoop()
    else stopGpsLoop()
  }, [online])

  async function pushPosition(point) {
    const activeShift = shiftRef.current
    if (!activeShift?.id || !isValidPoint(point)) return
    const detectedZone = resolveDetectedZone(point)
    const routeForDetectedZone = getRouteFromOverview(
      detectedZone?.id === selectedZone?.id ? overview : null,
      detectedZone || selectedZone,
    )
    const nextShift = await sendRecolectorPosition({
      shiftId: activeShift.id,
      lat: point.lat,
      lon: point.lon,
      barrioSlug: detectedZone?.id,
      barrioLabel: detectedZone?.label,
      routeId: detectedZone ? routeForDetectedZone.routeId : undefined,
      routeLabel: detectedZone ? routeForDetectedZone.routeLabel : undefined,
    })
    if (!mountedRef.current) return
    setError('')
    currentPointRef.current = point
    setShift(nextShift)
    setCurrentPoint(point)
    setLastPulseAt(new Date().toISOString())
  }

  function stopGpsLoop() {
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (watchRef.current && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current)
      watchRef.current = null
    }
    positionReadingRef.current = false
    positionSendingRef.current = false
  }

  function startRealGpsLoop() {
    stopGpsLoop()
    if (!navigator.geolocation) {
      setError('Este navegador no tiene GPS disponible para reportar el viaje.')
      return
    }

    const sendDevicePosition = (point) => {
      if (!mountedRef.current) return
      currentPointRef.current = point
      setCurrentPoint(point)
      resolveDetectedZone(point)
      if (positionSendingRef.current) return
      positionSendingRef.current = true
      void pushPosition(point)
        .catch((sendError) => {
          setError(sendError.message || 'No se pudo enviar la posicion real.')
        })
        .finally(() => {
          if (!mountedRef.current) return
          positionSendingRef.current = false
        })
    }

    const readDevicePosition = () => {
      if (positionReadingRef.current) return
      positionReadingRef.current = true
      navigator.geolocation.getCurrentPosition(
        (position) => {
          positionReadingRef.current = false
          sendDevicePosition({
            lat: position.coords.latitude,
            lon: position.coords.longitude,
          })
        },
        () => {
          positionReadingRef.current = false
          if (!mountedRef.current) return
          if (!currentPointRef.current) {
            setError('No se pudo leer el GPS real. Revisá los permisos de ubicación del navegador.')
          }
        },
        GPS_OPTIONS,
      )
    }

    watchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        sendDevicePosition({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        })
      },
      () => {
        if (!mountedRef.current) return
        if (!currentPointRef.current) {
          setError('No se pudo leer el GPS real. Revisá los permisos de ubicación del navegador.')
        }
      },
      GPS_OPTIONS,
    )
    readDevicePosition()
    timerRef.current = window.setInterval(readDevicePosition, GPS_INTERVAL_MS)
  }

  async function resolveInitialPoint() {
    try {
      return await getUserLocation({ timeoutMs: 9000, enableHighAccuracy: true, maximumAge: 0 })
    } catch (_error) {
      throw new Error('No se pudo tomar tu ubicación real. Revisá los permisos de GPS del navegador.')
    }
  }

  async function handleStartShift() {
    if (!canStart) return
    setGpsStatus('starting')
    setMessage('')
    setError('')
    try {
      const initialPoint = await resolveInitialPoint()
      const detectedZone = resolveDetectedZone(initialPoint)
      if (!detectedZone) {
        throw new Error('No pudimos detectar el barrio con tu GPS. Probá iniciar el viaje dentro del mapa municipal.')
      }
      const detectedRoute = getRouteFromOverview(detectedZone.id === selectedZone?.id ? overview : null, detectedZone)
      const nextShift = await startRecolectorShift({
        routeId: detectedRoute.routeId,
        routeLabel: detectedRoute.routeLabel,
        barrioSlug: detectedZone.id,
        barrioLabel: detectedZone.label,
        lat: initialPoint?.lat,
        lon: initialPoint?.lon,
      })
      if (!mountedRef.current) {
        stopRecolectorShiftOnExit(nextShift?.id)
        return
      }
      setShift(nextShift)
      shiftRef.current = nextShift
      currentPointRef.current = initialPoint
      setCurrentPoint(initialPoint)
      setLastPulseAt(new Date().toISOString())
      setGpsStatus('online')
      setMessage(`Viaje iniciado en ${detectedZone.label}.`)
    } catch (startError) {
      setGpsStatus('error')
      setError(startError.message || 'No se pudo iniciar el viaje.')
    }
  }

  async function handleStopShift() {
    if (!shift?.id) return
    setGpsStatus('stopping')
    setError('')
    stopGpsLoop()
    try {
      const nextShift = await stopRecolectorShift(shift.id)
      if (!mountedRef.current) return
      shiftRef.current = nextShift
      setShift(nextShift)
      setGpsStatus('ready')
      setMessage('Viaje finalizado. El mapa deja de recibir tu GPS.')
    } catch (stopError) {
      setGpsStatus('error')
      setError(stopError.message || 'No se pudo finalizar el viaje.')
    }
  }

  function toggleNotifyZone(zoneId) {
    setNotifyZoneIds((current) => (
      current.includes(zoneId)
        ? current.filter((id) => id !== zoneId)
        : [...current, zoneId]
    ))
  }

  function selectAllNotifyZones() {
    setNotifyZoneIds(zones.map((zone) => zone.id).filter(Boolean))
  }

  function clearNotifyZones() {
    setNotifyZoneIds([])
  }

  async function handleBroadcastNotifications() {
    if (!canNotify) return
    setNotifyStatus('sending')
    setError('')
    setMessage('')
    try {
      const result = await broadcastRecolectorNotifications({
        zoneIds: notifyZoneIds,
        channel: 'all',
        shiftId: shiftRef.current?.id || null,
        message: 'El recolector aviso que hoy recorrera tu barrio. Prepara tus residuos para la recoleccion.',
      })
      if (!mountedRef.current) return
      setNotifyStatus('sent')
      const emailNote = result.email?.attempted
        ? ` Correos: ${result.email.sent || 0} enviados${result.email.skipped ? `, ${result.email.skipped} pendientes por configurar SMTP` : ''}${result.email.failed ? `, ${result.email.failed} fallidos` : ''}.`
        : ''
      setMessage(
        result.count
          ? `Notificaciones enviadas a ${result.count} suscriptor${result.count === 1 ? '' : 'es'} de ${notifyZoneIds.length} barrio${notifyZoneIds.length === 1 ? '' : 's'}.${emailNote}`
          : `No hay vecinos suscriptos en los ${notifyZoneIds.length} barrio${notifyZoneIds.length === 1 ? '' : 's'} seleccionados.`,
      )
    } catch (notifyError) {
      if (!mountedRef.current) return
      setNotifyStatus('error')
      setError(notifyError.message || 'No se pudieron enviar las notificaciones.')
    }
  }

  return (
    <section className="recolector-shell">
      <div className="recolector-hero">
        <div>
          <h1>Panel Recolector</h1>
        </div>
        <div className="recolector-live-card">
          <span className={`recolector-dot ${online ? 'is-online' : ''}`} />
          <div>
            <strong>{online ? 'Viaje activo' : 'Sin viaje activo'}</strong>
          </div>
        </div>
      </div>

      {error ? <p className="recolector-alert is-error">{error}</p> : null}
      {message ? <p className="recolector-alert">{message}</p> : null}

      <div className="recolector-grid">
        <article className="recolector-card recolector-notify-card">
          <div className="recolector-card-head">
            <div>
              <span>1</span>
              <h2>Notificaciones</h2>
            </div>
          </div>
          <p className="recolector-card-helper">
            Elegí los barrios que vas a recorrer hoy y avisale a los vecinos suscriptos.
          </p>
          <div className="recolector-zone-actions">
            <button type="button" onClick={selectAllNotifyZones} disabled={!zones.length}>
              Todos
            </button>
            <button type="button" onClick={clearNotifyZones} disabled={!notifyZoneIds.length}>
              Limpiar
            </button>
          </div>
          <div className="recolector-zone-list" aria-label="Barrios a notificar">
            {zones.map((zone) => (
              <label key={zone.id} className={`recolector-zone-option ${notifyZoneIds.includes(zone.id) ? 'is-selected' : ''}`.trim()}>
                <input
                  type="checkbox"
                  checked={notifyZoneIds.includes(zone.id)}
                  onChange={() => toggleNotifyZone(zone.id)}
                />
                <span>{zone.label}</span>
              </label>
            ))}
            {!zones.length ? <div className="recolector-empty">No hay barrios cargados para esta ciudad.</div> : null}
          </div>
          <button
            type="button"
            className="recolector-action-button is-notify recolector-wide-button"
            disabled={!canNotify}
            onClick={handleBroadcastNotifications}
          >
            {notifyStatus === 'sending' ? 'Notificando...' : `Notificar ${notifyZoneIds.length || ''}`.trim()}
          </button>
        </article>

        <article className="recolector-card">
          <div className="recolector-card-head">
            <div>
              <span>2</span>
              <h2>Viaje</h2>
            </div>
          </div>
          <div className="recolector-route-preview">
            <RecolectorLiveMap
              zone={selectedZone}
              route={selectedRoute}
              zoneFeature={selectedZoneFeature}
              routeSegments={routeSegments}
              currentPoint={currentPoint}
              online={online}
            />
          </div>
          <div className="recolector-trip-summary">
            <span>Barrio <strong>{selectedZone?.label || 'Sin seleccion'}</strong></span>
          </div>
          <div className="recolector-actions">
            <button type="button" className="recolector-action-button is-start" disabled={!canStart || gpsStatus === 'starting'} onClick={handleStartShift}>
              {gpsStatus === 'starting' ? 'Iniciando...' : 'Iniciar viaje'}
            </button>
            <button type="button" className="recolector-action-button is-stop" disabled={!online || gpsStatus === 'stopping'} onClick={handleStopShift}>
              {gpsStatus === 'stopping' ? 'Finalizando...' : 'Finalizar viaje'}
            </button>
          </div>
        </article>

        <article className="recolector-card">
          <div className="recolector-card-head">
            <div>
              <span>3</span>
              <h2>GPS</h2>
            </div>
          </div>
          <div className={`recolector-gps-status ${online ? 'is-online' : ''}`}>
            <span className="recolector-gps-pulse" />
            <div>
              <strong>{online ? 'Enviando ubicación' : 'GPS apagado'}</strong>
              <small>{lastPulseAt ? `Último pulso ${formatTime(lastPulseAt)}` : 'Se activa al iniciar viaje.'}</small>
            </div>
          </div>
          <div className="recolector-gps-chip">
            <span className={online ? 'is-on' : ''} />
            {online ? 'Visible en el mapa público' : 'No se está compartiendo ubicación'}
          </div>
          <div className="recolector-metrics">
            <div>
              <span>Lat</span>
              <strong>{isValidPoint(currentPoint) ? currentPoint.lat.toFixed(6) : '--'}</strong>
            </div>
            <div>
              <span>Lon</span>
              <strong>{isValidPoint(currentPoint) ? currentPoint.lon.toFixed(6) : '--'}</strong>
            </div>
            <div>
              <span>Envío</span>
              <strong>{online ? `cada ${GPS_INTERVAL_MS / 1000}s` : 'pausado'}</strong>
            </div>
          </div>
        </article>
      </div>
    </section>
  )
}

function RecolectorPage() {
  const { user } = useAppContext()
  const { navigate } = useHashRoute()
  const handleNavigate = makeNavigate(navigate)

  return (
    <div className="municipal-app admin-muni-theme-light recolector-theme">
      <div className="ambient ambient-left" aria-hidden="true" />
      <div className="ambient ambient-right" aria-hidden="true" />
      <div className="grid-haze" aria-hidden="true" />
      <Header
        activeSection=""
        navigation={navigation}
        onNavigate={handleNavigate}
        adminShell
        suppressAdminShellNavigation
        adminActions={(
          <>
            <MunicipalitySelector />
            <AuthMenu />
          </>
        )}
      />
      <main className={`page-shell page-shell-info recolector-page-shell ${!userHasRole(user, 'recolector') ? 'page-shell-panel-login' : ''}`.trim()}>
        {userHasRole(user, 'recolector') ? <RecolectorDashboard /> : <RecolectorGate />}
      </main>
    </div>
  )
}

export default RecolectorPage
