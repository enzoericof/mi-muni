import { useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  createCollectionNotification,
  deleteCollectionNotification,
  fetchCollectionMap,
  fetchCollectionNotificationEvents,
  fetchCollectionNotifications,
  fetchCollectionOverview,
  fetchCollectionZones,
  fetchGtfsShapes,
} from '../../lib/api'
import { useAppContext } from '../../lib/AppContext'
import { addGoogleMapTilesLayer } from '../../lib/googleMapTiles'
import TrashMapControls from './TrashMapControls'
import TrashNotificationSheet from './TrashNotificationSheet'

const ASU_CENTER = [-25.2867, -57.61]
const MAP_REFRESH_MS = 3000
const OVERVIEW_REFRESH_MS = 15000
const HIDDEN_TAB_REFRESH_MS = 15000
const ROUTE_SHAPE_REFRESH_EVERY = 20
const CITY_PADDING = [36, 36]
const ZONE_PADDING = [28, 28]
const SELECTED_ZONE_STROKE_COLOR = '#ff5a33'
const SELECTED_ZONE_FILL_COLOR = '#ff8b72'
const ROUTE_STROKE_COLOR = '#146152'
const VEHICLE_ANIMATION_FALLBACK_MS = 2800
const VEHICLE_ANIMATION_MIN_MS = 900
const VEHICLE_ANIMATION_MAX_MS = 4200
const VEHICLE_ANIMATION_LOOKAHEAD = 1.18
const VEHICLE_STALE_UPDATE_MS = 12000
const ROUTE_INTERPOLATION_MAX_SEGMENT_METERS = 300
const NOTIFICATION_EVENT_POLL_MS = 7000
const NOTIFICATION_EVENT_STORAGE_KEY = 'mimuni:collection-notification-last-event'

function getMapRefreshDelay() {
  return document.visibilityState === 'hidden' ? HIDDEN_TAB_REFRESH_MS : MAP_REFRESH_MS
}

function getVehicleAnimationDuration(record, now) {
  const elapsedSinceUpdate = Number.isFinite(record.lastUpdateAt) ? now - record.lastUpdateAt : VEHICLE_ANIMATION_FALLBACK_MS
  const targetDuration = (elapsedSinceUpdate || VEHICLE_ANIMATION_FALLBACK_MS) * VEHICLE_ANIMATION_LOOKAHEAD
  return Math.max(VEHICLE_ANIMATION_MIN_MS, Math.min(VEHICLE_ANIMATION_MAX_MS, targetDuration))
}

function routeColor(color) {
  return color && color.startsWith('#') ? color : `#${color || '44803f'}`
}

function truckIcon(_color, isHighlighted = false) {
  return L.divIcon({
    className: '',
    html: `
      <div class="trash-truck-marker ${isHighlighted ? 'is-highlighted' : ''}">
        <img class="trash-truck-image" src="/trash-truck-reference.svg" alt="" draggable="false" />
      </div>`,
    iconSize: isHighlighted ? [62, 62] : [54, 54],
    iconAnchor: isHighlighted ? [31, 31] : [27, 27],
    popupAnchor: [0, -28],
  })
}

function positionAlongRouteShape(routeShape, distanceMeters) {
  const points = routeShape?.points || []
  if (!points.length) return null

  const lastPoint = points[points.length - 1]
  const totalDistance = Number(routeShape.totalDistanceMeters || lastPoint.cumulativeDistanceMeters || 0)
  if (!Number.isFinite(totalDistance) || totalDistance <= 0) {
    return [Number(lastPoint.lat), Number(lastPoint.lon)]
  }

  const targetDistance = Math.max(0, Math.min(totalDistance, Number(distanceMeters || 0)))
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const next = points[index]
    const nextDistance = Number(next.cumulativeDistanceMeters || 0)
    if (targetDistance > nextDistance) continue

    const previousDistance = Number(previous.cumulativeDistanceMeters || 0)
    const segmentDistance = nextDistance - previousDistance
    if (segmentDistance > ROUTE_INTERPOLATION_MAX_SEGMENT_METERS) {
      const snapPoint = targetDistance - previousDistance < segmentDistance / 2 ? previous : next
      return [Number(snapPoint.lat), Number(snapPoint.lon)]
    }
    const progress = segmentDistance > 0 ? (targetDistance - previousDistance) / segmentDistance : 0
    const lat = Number(previous.lat) + (Number(next.lat) - Number(previous.lat)) * progress
    const lon = Number(previous.lon) + (Number(next.lon) - Number(previous.lon)) * progress
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null
  }

  return [Number(lastPoint.lat), Number(lastPoint.lon)]
}

function positionAlongRouteDistance(routeShape, distanceMeters) {
  const totalDistance = Number(routeShape?.totalDistanceMeters || 0)
  if (!Number.isFinite(totalDistance) || totalDistance <= 0) {
    return positionAlongRouteShape(routeShape, distanceMeters)
  }

  const normalizedDistance = ((Number(distanceMeters || 0) % totalDistance) + totalDistance) % totalDistance
  return positionAlongRouteShape(routeShape, normalizedDistance)
}

function distanceFromVehicleProgress(routeShape, vehicle) {
  const points = routeShape?.points || []
  const lastPoint = points[points.length - 1]
  const totalDistance = Number(routeShape?.totalDistanceMeters || lastPoint?.cumulativeDistanceMeters || 0)
  if (vehicle?.progress === null || vehicle?.progress === undefined || vehicle?.progress === '') return null
  const progress = Number(vehicle.progress)
  if (!Number.isFinite(totalDistance) || totalDistance <= 0 || !Number.isFinite(progress)) return null
  return Math.max(0, Math.min(totalDistance, progress * totalDistance))
}

function setMarkerPositionSmooth(marker, map, latLng) {
  const nextLatLng = L.latLng(latLng)
  const layerPoint = map.project(nextLatLng, map.getZoom()).subtract(map.getPixelOrigin())

  marker._latlng = nextLatLng
  if (marker._icon) {
    L.DomUtil.setPosition(marker._icon, layerPoint)
  }
  if (marker._shadow) {
    L.DomUtil.setPosition(marker._shadow, layerPoint)
  }
}

function snapVehicleMarker(record, map, latLng, routeShape = null, routeDistance = null) {
  setMarkerPositionSmooth(record.marker, map, latLng)
  record.routeShape = routeShape
  record.from = latLng
  record.to = latLng
  record.fromPoint = routeShape ? null : map.latLngToLayerPoint(latLng)
  record.toPoint = routeShape ? null : map.latLngToLayerPoint(latLng)
  record.fromDistance = routeDistance
  record.toDistance = routeDistance
  record.currentDistance = routeDistance
  record.rawTargetDistance = routeDistance
  record.velocityMetersPerMs = 0
  record.startedAt = performance.now()
  record.lastUpdateAt = performance.now()
  record.duration = 0
  record.forceSnap = false
}

function syncVehicleMarkerToMap(record, map) {
  if (!record?.marker || !map) return

  if (record.routeShape && Number.isFinite(record.currentDistance)) {
    const routeLatLng = positionAlongRouteDistance(record.routeShape, record.currentDistance)
    if (routeLatLng) {
      snapVehicleMarker(record, map, routeLatLng, record.routeShape, record.currentDistance)
      return
    }
  }

  const fallbackLatLng = record.to || record.from || record.marker.getLatLng()
  snapVehicleMarker(record, map, fallbackLatLng, null, null)
}

function animateVehicleMarker(record, vehicle, map, routeShape = null) {
  const targetLatLng = [vehicle.currentLat, vehicle.currentLon]
  const currentLatLng = record.marker.getLatLng()
  const targetLat = Number(targetLatLng[0])
  const targetLng = Number(targetLatLng[1])
  if (!Number.isFinite(targetLat) || !Number.isFinite(targetLng)) return

  const now = performance.now()
  const targetDistance = distanceFromVehicleProgress(routeShape, vehicle)
  const duration = getVehicleAnimationDuration(record, now)
  const elapsedSinceUpdate = Number.isFinite(record.lastUpdateAt) ? Math.max(1, now - record.lastUpdateAt) : duration
  const isStaleUpdate = elapsedSinceUpdate >= VEHICLE_STALE_UPDATE_MS
  const shouldSnap = record.forceSnap || document.visibilityState === 'hidden' || isStaleUpdate

  if (routeShape && targetDistance !== null) {
    const previousRawTarget = Number.isFinite(record.rawTargetDistance) ? record.rawTargetDistance : targetDistance
    const hasBackwardJump = targetDistance + 1 < previousRawTarget
    const currentDistance = Number.isFinite(record.currentDistance)
      ? record.currentDistance
      : Number.isFinite(record.toDistance)
        ? record.toDistance
        : targetDistance
    const fromDistance = hasBackwardJump ? targetDistance : currentDistance
    const routeLatLng = positionAlongRouteDistance(routeShape, targetDistance) || [targetLat, targetLng]

    if (shouldSnap || hasBackwardJump) {
      snapVehicleMarker(record, map, routeLatLng, routeShape, targetDistance)
      return
    }

    record.routeShape = routeShape
    record.fromDistance = fromDistance
    record.toDistance = targetDistance
    record.currentDistance = fromDistance
    record.rawTargetDistance = targetDistance
    record.velocityMetersPerMs = 0
    record.from = positionAlongRouteDistance(routeShape, record.fromDistance) || [currentLatLng.lat, currentLatLng.lng]
    record.to = routeLatLng
    record.fromPoint = null
    record.toPoint = null
    record.startedAt = now
    record.lastUpdateAt = now
    record.duration = duration
    record.forceSnap = false
    return
  }

  const targetPoint = map.latLngToLayerPoint([targetLat, targetLng])

  if (shouldSnap) {
    snapVehicleMarker(record, map, [targetLat, targetLng], null, null)
    return
  }

  record.routeShape = null
  record.fromDistance = null
  record.toDistance = null
  record.currentDistance = null
  record.from = [currentLatLng.lat, currentLatLng.lng]
  record.to = [targetLat, targetLng]
  record.fromPoint = map.latLngToLayerPoint(currentLatLng)
  record.toPoint = targetPoint
  record.startedAt = now
  record.lastUpdateAt = now
  record.duration = duration
  record.forceSnap = false
}

function depotIcon() {
  return L.divIcon({
    className: '',
    html: `
      <div class="trash-depot-marker">
        <svg viewBox="0 0 72 72" aria-hidden="true">
          <defs>
            <linearGradient id="depot-green" x1="18" y1="16" x2="54" y2="58" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#1d7a66" />
              <stop offset="1" stop-color="#0f4f43" />
            </linearGradient>
          </defs>
          <circle cx="36" cy="36" r="32" fill="#fff" />
          <circle cx="36" cy="36" r="29" fill="none" stroke="#146152" stroke-width="4" />
          <path d="M19 37 L36 25 L53 37 V52 H19 Z" fill="url(#depot-green)" />
          <path d="M16 38 L36 23 L56 38" fill="none" stroke="#ff5a33" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
          <rect x="26" y="41" width="20" height="11" rx="3" fill="#fff" opacity="0.96" />
          <path d="M31 47 H41" stroke="#146152" stroke-width="3" stroke-linecap="round" />
          <path d="M36 33 C39 33 42 36 42 39 M42 39 H38 M42 39 V35" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M31 39 C30 36 32 33 35 33 M35 33 L33 37 M35 33 L38 35" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>`,
    iconSize: [42, 42],
    iconAnchor: [21, 21],
    popupAnchor: [0, -22],
  })
}

function userLocationIcon() {
  return L.divIcon({
    className: '',
    html: `
      <div class="trash-user-location-marker">
        <span></span>
      </div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })
}

function formatTime(value) {
  if (!value) return 'Sin dato'
  return new Date(value).toLocaleTimeString('es-PY', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatShortDate(value) {
  if (!value) return 'Sin fecha'
  return new Date(value).toLocaleDateString('es-PY', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function popupForRoute(route) {
  return `
    <div style="min-width:220px">
      <strong>${route.accent || 'Ruta'}</strong><br/>
      <span style="color:${route.color};font-weight:700">${route.shortName}</span>
      <div style="margin-top:6px;font-size:12px;color:#476257">${route.longName}</div>
      <div style="margin-top:8px;font-size:12px;color:#476257">
        Duración estimada: <strong>${route.durationMinutes || 0} min</strong><br/>
        Referencia: <strong>${route.referenceDate ? new Date(route.referenceDate).toLocaleString('es-PY', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Sin fecha'}</strong>
      </div>
    </div>
  `
}

function popupForVehicle(vehicle) {
  return `
    <div style="min-width:210px">
      <strong>${vehicle.routeLongName}</strong><br/>
      <span style="color:${vehicle.routeColor};font-weight:700">${vehicle.routeShortName}</span>
      <div style="margin-top:8px;font-size:12px;color:#476257">
        Estado: <strong>${vehicle.status === 'active' ? 'En ruta' : 'En espera'}</strong><br/>
        Siguiente referencia: <strong>${vehicle.nextStop?.stop_name || 'Sin dato'}</strong><br/>
        Fuente: <strong>${vehicle.sourceLabel}</strong>
      </div>
    </div>
  `
}

function normalizeLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase()
}

function normalizePoint(point) {
  if (!point) return null
  const lat = Number(point.lat ?? point.centerLat)
  const lon = Number(point.lon ?? point.centerLon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return [lat, lon]
}

function latLngBoundsFromBbox(bounds) {
  if (!bounds) return null
  const minLat = Number(bounds.minLat)
  const maxLat = Number(bounds.maxLat)
  const minLon = Number(bounds.minLon)
  const maxLon = Number(bounds.maxLon)
  if (![minLat, maxLat, minLon, maxLon].every((value) => Number.isFinite(value))) return null
  return L.latLngBounds([
    [minLat, minLon],
    [maxLat, maxLon],
  ])
}

function matchZoneRecord(zones, zoneId) {
  const normalizedZoneId = normalizeLabel(zoneId)
  return zones.find((zone) =>
    normalizeLabel(zone.id) === normalizedZoneId ||
    normalizeLabel(zone.label) === normalizedZoneId,
  ) || null
}

function matchFeatureZone(feature, zoneId, zoneRecord = null) {
  const normalizedZoneId = normalizeLabel(zoneId)
  const normalizedZoneLabel = normalizeLabel(zoneRecord?.label)
  return [
    feature?.properties?.id,
    feature?.properties?.slug,
    feature?.properties?.nombre,
    feature?.properties?.label,
  ].some((value) => {
    const normalizedValue = normalizeLabel(value)
    return normalizedValue === normalizedZoneId || (normalizedZoneLabel && normalizedValue === normalizedZoneLabel)
  })
}

function pointInRing([lat, lon], ring = []) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersects = yi > lat !== yj > lat
      && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function featureContainsPoint(feature, point) {
  const normalized = normalizePoint(point)
  if (!feature?.geometry || !normalized) return false

  const [lat, lon] = normalized
  return geometryContainsLatLon(feature.geometry, lat, lon)
}

function geometryContainsLatLon(geometry, lat, lon) {
  const { type, coordinates } = geometry || {}
  if (!type || !coordinates) return false

  if (type === 'Polygon') {
    return coordinates.some((ring) => pointInRing([lat, lon], ring.map(([ringLon, ringLat]) => [ringLat, ringLon])))
  }

  if (type === 'MultiPolygon') {
    return coordinates.some((polygon) =>
      polygon.some((ring) => pointInRing([lat, lon], ring.map(([ringLon, ringLat]) => [ringLat, ringLon]))),
    )
  }

  return false
}

function buildCityBounds(mapData) {
  const municipalityBounds = latLngBoundsFromBbox(mapData?.municipality?.bbox)
  const points = [
    ...(mapData?.vehicles || []).map((vehicle) => [vehicle.currentLat, vehicle.currentLon]),
    ...(mapData?.zones || []).map((zone) => normalizePoint(zone)).filter(Boolean),
    ...(mapData?.depots || []).map((depot) => normalizePoint(depot)).filter(Boolean),
  ]

  if (points.length) return L.latLngBounds(points)
  return municipalityBounds
}

function invalidateLeafletMap(map) {
  const container = typeof map?.getContainer === 'function' ? map.getContainer() : null
  if (!map || !map._loaded || !map._mapPane || !container?.isConnected) return

  try {
    map.invalidateSize({ pan: false, animate: false })
  } catch (_error) {
    // Ignoramos resizes tardíos cuando Leaflet todavía está montando o ya se desmontó.
  }
}

function clipRouteToFeature(coords, feature) {
  if (!feature?.geometry || coords.length < 2) return [coords]

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
    const keepSegment = startInside || endInside || midpointInside

    if (keepSegment) {
      if (!currentSegment.length) currentSegment.push(start)
      currentSegment.push(end)
      continue
    }

    if (currentSegment.length >= 2) {
      segments.push(currentSegment)
    }
    currentSegment = []
  }

  if (currentSegment.length >= 2) {
    segments.push(currentSegment)
  }

  return segments.length ? segments : []
}

export default function TrashMap() {
  const { user, openLoginModal, municipality } = useAppContext()
  const mapRef = useRef(null)
  const mapStageRef = useRef(null)
  const leafletRef = useRef(null)
  const shapeCacheRef = useRef(new Map())
  const cityRouteShapesRef = useRef({})
  const mapFetchCountRef = useRef(0)
  const overviewCacheRef = useRef(new Map())
  const vehicleMarkersRef = useRef(new Map())
  const vehicleAnimationFrameRef = useRef(null)
  const userPositionRef = useRef(null)
  const layersRef = useRef({
    hit: null,
    zone: null,
    frequent: null,
    latest: null,
    vehicle: null,
    depots: null,
    userLocation: null,
  })
  const viewportRef = useRef({
    target: 'city',
    pending: true,
  })

  const [mapStatus, setMapStatus] = useState('loading')
  const [detailStatus, setDetailStatus] = useState('idle')
  const [mapData, setMapData] = useState(null)
  const [barrios, setBarrios] = useState([])
  const [serviceZones, setServiceZones] = useState([])
  const [selectedZoneId, setSelectedZoneId] = useState('')
  const [selectedServiceZoneId, setSelectedServiceZoneId] = useState('')
  const [overview, setOverview] = useState(null)
  const [refreshingMap, setRefreshingMap] = useState(false)
  const [visibleRouteLayer, setVisibleRouteLayer] = useState('none')
  const [routePanelStage, setRoutePanelStage] = useState('idle')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [locatingUser, setLocatingUser] = useState(false)
  const [locationMessage, setLocationMessage] = useState('')
  const [notificationOpen, setNotificationOpen] = useState(false)
  const [notificationStatus, setNotificationStatus] = useState('idle')
  const [notifications, setNotifications] = useState([])
  const [notificationEvent, setNotificationEvent] = useState(null)
  const [deletingNotificationId, setDeletingNotificationId] = useState(null)
  const [notificationForm, setNotificationForm] = useState({
    zoneId: '',
    channel: 'panel',
  })
  const selectedZoneRecord = matchZoneRecord(serviceZones, selectedZoneId)
  const selectedBarrioFeature = barrios.find((feature) => matchFeatureZone(feature, selectedZoneId, selectedZoneRecord)) || null
  const selectedBarrioSlug = selectedZoneRecord?.id || selectedBarrioFeature?.properties?.slug || ''
  const selectedZoneLabel = selectedZoneRecord?.label || selectedBarrioFeature?.properties?.nombre || selectedZoneId || ''
  const selectedRouteLabel = visibleRouteLayer === 'latest' ? 'última pasada' : 'ruta frecuente'

  useEffect(() => {
    if (!user) {
      setNotificationEvent(null)
      return undefined
    }

    let cancelled = false
    let timeoutId = null
    const readLastEventId = () => {
      try {
        return Number(window.localStorage.getItem(NOTIFICATION_EVENT_STORAGE_KEY) || 0)
      } catch (_error) {
        return 0
      }
    }
    const persistLastEventId = (eventId) => {
      try {
        window.localStorage.setItem(NOTIFICATION_EVENT_STORAGE_KEY, String(eventId))
      } catch (_error) {
        // La notificación ya se muestra aunque el navegador bloquee localStorage.
      }
    }
    let lastEventId = readLastEventId()

    async function pollNotificationEvents() {
      try {
        const events = await fetchCollectionNotificationEvents({ sinceId: lastEventId, channel: 'panel', limit: 5 })
        if (cancelled) return
        if (events.length) {
          const latestEvent = events[events.length - 1]
          lastEventId = Math.max(...events.map((event) => Number(event.id) || 0), lastEventId)
          persistLastEventId(lastEventId)
          setNotificationEvent(latestEvent)
        }
      } catch (_error) {
        // El polling no debe tapar el mapa si la sesión venció o el backend demora.
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(pollNotificationEvents, NOTIFICATION_EVENT_POLL_MS)
        }
      }
    }

    void pollNotificationEvents()
    return () => {
      cancelled = true
      if (timeoutId) window.clearTimeout(timeoutId)
    }
  }, [user])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') return
      if (vehicleAnimationFrameRef.current) {
        window.cancelAnimationFrame(vehicleAnimationFrameRef.current)
        vehicleAnimationFrameRef.current = null
      }
      for (const record of vehicleMarkersRef.current.values()) {
        record.forceSnap = true
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    if (leafletRef.current) return

    let cancelled = false
    let baseLayer = null
    const map = L.map(mapRef.current, {
      center: ASU_CENTER,
      zoom: 13,
      zoomControl: false,
    })

    void addGoogleMapTilesLayer(L, map).then((result) => {
      if (cancelled) {
        result.layer?.remove()
        return
      }
      baseLayer = result.layer
    })

    map.createPane('barrio-hit-pane')
    map.getPane('barrio-hit-pane').style.zIndex = '410'

    layersRef.current.hit = L.layerGroup().addTo(map)
    layersRef.current.zone = L.layerGroup().addTo(map)
    layersRef.current.frequent = L.layerGroup().addTo(map)
    layersRef.current.latest = L.layerGroup().addTo(map)
    layersRef.current.vehicle = L.layerGroup().addTo(map)
    layersRef.current.depots = L.layerGroup().addTo(map)
    layersRef.current.userLocation = L.layerGroup().addTo(map)

    const handleViewportChangeStart = () => {
      if (vehicleAnimationFrameRef.current) {
        window.cancelAnimationFrame(vehicleAnimationFrameRef.current)
        vehicleAnimationFrameRef.current = null
      }
      for (const record of vehicleMarkersRef.current.values()) {
        record.forceSnap = true
      }
    }

    const handleViewportChangeEnd = () => {
      for (const record of vehicleMarkersRef.current.values()) {
        syncVehicleMarkerToMap(record, map)
      }
      invalidateLeafletMap(map)
    }

    map.on('zoomstart movestart', handleViewportChangeStart)
    map.on('zoomend moveend viewreset resize', handleViewportChangeEnd)

    leafletRef.current = map

    return () => {
      cancelled = true
      baseLayer?.remove()
      map.off('zoomstart movestart', handleViewportChangeStart)
      map.off('zoomend moveend viewreset resize', handleViewportChangeEnd)
      if (vehicleAnimationFrameRef.current) {
        window.cancelAnimationFrame(vehicleAnimationFrameRef.current)
        vehicleAnimationFrameRef.current = null
      }
      vehicleMarkersRef.current.clear()
      map.remove()
      leafletRef.current = null
    }
  }, [])

  const focusUserLocation = useCallback((lat, lon) => {
    const map = leafletRef.current
    if (!map) return
    map.flyTo([lat, lon], 16, { duration: 0.45 })
  }, [])

  const paintUserLocation = useCallback((point) => {
    const layer = layersRef.current.userLocation
    if (!layer || !point) return
    layer.clearLayers()
    L.marker([point.lat, point.lon], {
      icon: userLocationIcon(),
      interactive: false,
    })
      .bindTooltip('Tu ubicación', {
        direction: 'top',
        offset: [0, -10],
        opacity: 0.96,
      })
      .addTo(layer)
  }, [])

  const requestUserLocation = useCallback(() => {
    if (!navigator.geolocation || locatingUser) {
      if (!navigator.geolocation) setLocationMessage('Tu navegador no permite usar ubicación.')
      return
    }

    setLocatingUser(true)
    setLocationMessage('')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextPoint = {
          lat: Number(position.coords.latitude.toFixed(6)),
          lon: Number(position.coords.longitude.toFixed(6)),
        }
        userPositionRef.current = nextPoint
        paintUserLocation(nextPoint)
        focusUserLocation(nextPoint.lat, nextPoint.lon)
        setLocatingUser(false)
      },
      (error) => {
        setLocatingUser(false)
        setLocationMessage(
          error?.code === 1
            ? 'La ubicación está bloqueada en el navegador.'
            : 'No se pudo obtener tu ubicación.',
        )
      },
      {
        enableHighAccuracy: true,
        timeout: 9000,
        maximumAge: 180000,
      },
    )
  }, [focusUserLocation, locatingUser, paintUserLocation])

  useEffect(() => {
    if (!locationMessage) return undefined
    const timeout = window.setTimeout(() => setLocationMessage(''), 3600)
    return () => window.clearTimeout(timeout)
  }, [locationMessage])

  useEffect(() => {
    let cancelled = false

    async function loadBarrios() {
      try {
        const payload = await fetchCollectionZones({
          municipalitySlug: municipality?.key || '',
          includeGeometry: true,
        })
        if (cancelled) return
        const nextBarrios = [...(payload.features || [])].sort((left, right) =>
          String(left.properties?.nombre || '').localeCompare(String(right.properties?.nombre || ''), 'es-PY'),
        )
        setBarrios(nextBarrios)
        setServiceZones(payload.zones || [])
      } catch (_error) {
        if (!cancelled) {
          setBarrios([])
          setServiceZones([])
        }
      }
    }

    loadBarrios()
    return () => {
      cancelled = true
    }
  }, [municipality?.key])

  useEffect(() => {
    overviewCacheRef.current.clear()
    cityRouteShapesRef.current = {}
    mapFetchCountRef.current = 0
    setSelectedZoneId('')
    setSelectedServiceZoneId('')
    setOverview(null)
    setDetailStatus('idle')
    setVisibleRouteLayer('none')
    viewportRef.current = {
      target: 'city',
      pending: true,
    }
  }, [municipality?.key])

  useEffect(() => {
    const map = leafletRef.current
    const hitLayer = layersRef.current.hit
    if (!map || !hitLayer) return undefined

    hitLayer.clearLayers()
    if (!barrios.length) return undefined

    const geoLayer = L.geoJSON(
      { type: 'FeatureCollection', features: barrios },
      {
        interactive: true,
        pane: 'barrio-hit-pane',
        style: () => ({
          color: SELECTED_ZONE_STROKE_COLOR,
          weight: 1,
          opacity: 0.01,
          fillColor: SELECTED_ZONE_FILL_COLOR,
          fillOpacity: 0.01,
        }),
        onEachFeature(feature, layer) {
          layer.on('click', () => {
            const zoneId = feature?.properties?.id || feature?.properties?.slug || feature?.properties?.nombre || ''
            if (!zoneId) return
            setSelectedZoneId((current) => (current === zoneId ? current : zoneId))
            setRoutePanelStage('detail')
            setVisibleRouteLayer('none')
          })
        },
      },
    )

    geoLayer.addTo(hitLayer)
    return () => {
      hitLayer.clearLayers()
    }
  }, [barrios])

  const loadMapData = useCallback(async ({ forceRouteShapes = false } = {}) => {
    try {
      mapFetchCountRef.current += 1
      const shouldRefreshShapes =
        forceRouteShapes ||
        Object.keys(cityRouteShapesRef.current).length === 0 ||
        mapFetchCountRef.current % ROUTE_SHAPE_REFRESH_EVERY === 0
      let nextMap = await fetchCollectionMap({
        includeRouteShapes: shouldRefreshShapes,
        municipalitySlug: municipality?.key || '',
      })
      if (nextMap.routeShapes && Object.keys(nextMap.routeShapes).length) {
        cityRouteShapesRef.current = {
          ...cityRouteShapesRef.current,
          ...nextMap.routeShapes,
        }
      }
      const hasMissingRouteShapes = (nextMap.vehicles || []).some((vehicle) => vehicle.routeId && !cityRouteShapesRef.current[vehicle.routeId])
      if (!shouldRefreshShapes && hasMissingRouteShapes) {
        nextMap = await fetchCollectionMap({
          includeRouteShapes: true,
          municipalitySlug: municipality?.key || '',
        })
        if (nextMap.routeShapes && Object.keys(nextMap.routeShapes).length) {
          cityRouteShapesRef.current = {
            ...cityRouteShapesRef.current,
            ...nextMap.routeShapes,
          }
        }
      }
      const nextMapWithCachedShapes = {
        ...nextMap,
        routeShapes: cityRouteShapesRef.current,
      }
      setMapData(nextMapWithCachedShapes)
      setServiceZones(nextMap.zones || [])
      setMapStatus('ready')
      return nextMapWithCachedShapes
    } catch (_error) {
      setMapStatus('error')
      return null
    }
  }, [municipality?.key])

  useEffect(() => {
    setMapStatus('loading')
    let cancelled = false
    let timeoutId = null

    async function tick() {
      const nextMap = await loadMapData()
      if (!cancelled) {
        timeoutId = window.setTimeout(tick, getMapRefreshDelay())
      }
    }

    tick()
    const handleVisibilityChange = () => {
      if (cancelled || document.visibilityState !== 'visible') return
      if (timeoutId) window.clearTimeout(timeoutId)
      timeoutId = window.setTimeout(tick, 0)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      cancelled = true
      if (timeoutId) window.clearTimeout(timeoutId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [loadMapData])

  const loadOverview = useCallback(async (zoneId, options = {}) => {
    if (!zoneId) {
      setOverview(null)
      setDetailStatus('idle')
      return null
    }

    if (options.preferCache && overviewCacheRef.current.has(zoneId)) {
      const cachedOverview = overviewCacheRef.current.get(zoneId)
      if (!options.silent) {
        setOverview(cachedOverview)
        setDetailStatus('ready')
      }
      return cachedOverview
    }

    try {
      const nextOverview = await fetchCollectionOverview(zoneId, {
        municipalitySlug: municipality?.key || '',
      })
      overviewCacheRef.current.set(zoneId, nextOverview)
      if (!options.silent) {
        setOverview(nextOverview)
        setDetailStatus(nextOverview?.collectionReady === false ? 'unsupported' : 'ready')
      }
      return nextOverview
    } catch (_error) {
      if (!options.silent) {
        setOverview(null)
        setDetailStatus('error')
      }
      return null
    }
  }, [municipality?.key])

  useEffect(() => {
    viewportRef.current = {
      target: selectedBarrioSlug || normalizeLabel(selectedZoneId) || 'city',
      pending: true,
    }
  }, [selectedBarrioSlug, selectedZoneId])

  useEffect(() => {
    setVisibleRouteLayer('none')
  }, [selectedZoneId])

  useEffect(() => {
    if (!selectedZoneId) {
      setSelectedServiceZoneId('')
      return
    }

    const normalizedSelection = normalizeLabel(selectedZoneId)
    const matchedZone = serviceZones.find((zone) =>
      zone.id === selectedBarrioSlug ||
      normalizeLabel(zone.label) === normalizedSelection ||
      normalizeLabel(zone.id) === normalizedSelection,
    )

    setSelectedServiceZoneId(matchedZone?.id || selectedBarrioSlug || '')
  }, [selectedBarrioSlug, selectedZoneId, serviceZones])

  useEffect(() => {
    if (!selectedZoneId) {
      setOverview(null)
      setDetailStatus('idle')
      setVisibleRouteLayer('none')
      return undefined
    }

    if (!selectedServiceZoneId) {
      setOverview(null)
      setDetailStatus('unsupported')
      setVisibleRouteLayer('none')
      return undefined
    }

    let cancelled = false
    let timeoutId = null

    setDetailStatus('loading')

    async function tick(preferCache = false) {
      if (preferCache) {
        setOverview(null)
        const nextOverview = await loadOverview(selectedServiceZoneId, { preferCache: true, silent: true })
        if (cancelled) return
        if (nextOverview) {
          setOverview(nextOverview)
          setDetailStatus(nextOverview.collectionReady === false ? 'unsupported' : 'ready')
        } else {
          setOverview(null)
          setDetailStatus('error')
        }
      } else {
        const nextOverview = await loadOverview(selectedServiceZoneId, { silent: true })
        if (!cancelled && nextOverview) {
          setOverview(nextOverview)
        }
      }
      if (!cancelled) {
        const delay = document.visibilityState === 'hidden' ? HIDDEN_TAB_REFRESH_MS : OVERVIEW_REFRESH_MS
        timeoutId = window.setTimeout(() => tick(false), delay)
      }
    }

    tick(true)
    const handleVisibilityChange = () => {
      if (cancelled || document.visibilityState !== 'visible') return
      if (timeoutId) window.clearTimeout(timeoutId)
      timeoutId = window.setTimeout(() => tick(false), 0)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      cancelled = true
      if (timeoutId) window.clearTimeout(timeoutId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [loadOverview, selectedServiceZoneId, selectedZoneId])

  useEffect(() => {
    const map = leafletRef.current
    const mapNode = mapRef.current
    if (!map || !mapNode) return undefined

    let disposed = false
    const frameIds = new Set()
    const timeoutIds = new Set()

    const resize = () => {
      if (disposed) return
      invalidateLeafletMap(map)
    }

    const scheduleFrame = () => {
      const frameId = window.requestAnimationFrame(() => {
        frameIds.delete(frameId)
        resize()
      })
      frameIds.add(frameId)
    }

    const scheduleTimeout = (delay) => {
      const timeoutId = window.setTimeout(() => {
        timeoutIds.delete(timeoutId)
        resize()
      }, delay)
      timeoutIds.add(timeoutId)
    }

    scheduleFrame()
    scheduleTimeout(180)
    scheduleTimeout(420)
    const onResize = () => {
      scheduleFrame()
      scheduleTimeout(120)
    }
    const observer = new ResizeObserver(() => {
      scheduleFrame()
    })

    observer.observe(mapNode)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)

    return () => {
      disposed = true
      for (const frameId of frameIds) {
        window.cancelAnimationFrame(frameId)
      }
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId)
      }
      observer.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [mapData, overview])

  useEffect(() => {
    function syncFullscreenState() {
      setIsFullscreen(document.fullscreenElement === mapStageRef.current)
    }

    document.addEventListener('fullscreenchange', syncFullscreenState)
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState)
    }
  }, [])

  const getShapeCoords = useCallback(async (routeLayer, fallbackStops) => {
    const embeddedShape = Array.isArray(routeLayer?.shapePoints)
      ? routeLayer.shapePoints
          .map((point) => [Number(point?.[0]), Number(point?.[1])])
          .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon))
      : []
    if (embeddedShape.length >= 2) {
      return embeddedShape
    }

    const shapeId = routeLayer?.shapeId
    if (shapeId && shapeCacheRef.current.has(shapeId)) {
      return shapeCacheRef.current.get(shapeId)
    }

    if (shapeId) {
      try {
        const shapePoints = await fetchGtfsShapes(shapeId)
        const coords = shapePoints.map((point) => [point.shape_pt_lat, point.shape_pt_lon])
        shapeCacheRef.current.set(shapeId, coords)
        return coords
      } catch (_error) {
        // Fallback below.
      }
    }

    return (fallbackStops || []).map((stop) => [stop.lat, stop.lon])
  }, [])

  useEffect(() => {
    const map = leafletRef.current
    if (!map) return undefined

    const layers = layersRef.current
    layers.depots?.clearLayers()

    if (!mapData) return undefined

    function drawLiveLayers() {
      const cityBounds = buildCityBounds(mapData)
      const highlightedVehicleId = overview?.liveVehicle?.vehicleId || null
      const shouldSyncViewport = viewportRef.current.pending
      const nextVehicleIds = new Set()

      for (const vehicle of mapData.vehicles || []) {
        const vehicleId = vehicle.vehicleId
        const markerId = `${vehicle.vehicleId}-${vehicle.routeId}`
        const nextLatLng = [vehicle.currentLat, vehicle.currentLon]
        const routeShape = mapData.routeShapes?.[vehicle.routeId] || null
        const routeDistance = distanceFromVehicleProgress(routeShape, vehicle)
        const routeLatLng = routeDistance !== null
          ? positionAlongRouteShape(routeShape, routeDistance)
          : null
        const markerLatLng = routeLatLng || nextLatLng
        const isHighlighted = vehicleId === highlightedVehicleId
        nextVehicleIds.add(markerId)

        const existing = vehicleMarkersRef.current.get(markerId)
        if (existing) {
          if (existing.isHighlighted !== isHighlighted || existing.routeColor !== vehicle.routeColor) {
            existing.marker.setIcon(truckIcon(routeColor(vehicle.routeColor), isHighlighted))
            existing.isHighlighted = isHighlighted
            existing.routeColor = vehicle.routeColor
          }
          animateVehicleMarker(existing, vehicle, map, routeShape)
          continue
        }

        const marker = L.marker(markerLatLng, {
          icon: truckIcon(routeColor(vehicle.routeColor), isHighlighted),
          interactive: false,
        }).addTo(layers.vehicle)
        vehicleMarkersRef.current.set(markerId, {
          marker,
          routeShape,
          from: markerLatLng,
          to: markerLatLng,
          fromPoint: routeShape ? null : map.latLngToLayerPoint(markerLatLng),
          toPoint: routeShape ? null : map.latLngToLayerPoint(markerLatLng),
          fromDistance: routeDistance,
          toDistance: routeDistance,
          currentDistance: routeDistance,
          rawTargetDistance: routeDistance,
          velocityMetersPerMs: 0,
          startedAt: performance.now(),
          lastUpdateAt: performance.now(),
          duration: 0,
          forceSnap: false,
          isHighlighted,
          routeColor: vehicle.routeColor,
        })
      }

      for (const [vehicleId, record] of vehicleMarkersRef.current.entries()) {
        if (nextVehicleIds.has(vehicleId)) continue
        layers.vehicle?.removeLayer(record.marker)
        vehicleMarkersRef.current.delete(vehicleId)
      }

      for (const depot of mapData.depots || []) {
        L.marker([depot.centerLat, depot.centerLon], {
          icon: depotIcon(),
          interactive: false,
        }).bindTooltip(depot.label, {
          direction: 'top',
          offset: [0, -12],
          opacity: 0.92,
        }).addTo(layers.depots)
      }

      if (!selectedZoneId) {
        if (shouldSyncViewport) {
          if (cityBounds) {
            map.fitBounds(cityBounds, { padding: CITY_PADDING, maxZoom: 12 })
          } else if (Number.isFinite(Number(mapData?.municipality?.centerLat)) && Number.isFinite(Number(mapData?.municipality?.centerLon))) {
            map.setView([Number(mapData.municipality.centerLat), Number(mapData.municipality.centerLon)], 12)
          } else {
            map.setView(ASU_CENTER, 12)
          }
          viewportRef.current.pending = false
        }
      }
    }

    drawLiveLayers()
    if (!vehicleAnimationFrameRef.current) {
      const animate = (now) => {
        let hasActiveAnimation = false
        for (const record of vehicleMarkersRef.current.values()) {
          const elapsed = now - record.startedAt
          const progress = record.duration ? Math.min(1, elapsed / record.duration) : 1
          if (record.routeShape && Number.isFinite(record.fromDistance) && Number.isFinite(record.toDistance)) {
            const distance = record.fromDistance + (record.toDistance - record.fromDistance) * progress
            const routeLatLng = positionAlongRouteDistance(record.routeShape, distance)
            if (routeLatLng) {
              record.currentDistance = distance
              setMarkerPositionSmooth(record.marker, map, routeLatLng)
            }
            if (progress < 1) hasActiveAnimation = true
            continue
          }

          const fromPoint = record.fromPoint || map.latLngToLayerPoint(record.from)
          const toPoint = record.toPoint || map.latLngToLayerPoint(record.to)
          const point = L.point(
            fromPoint.x + (toPoint.x - fromPoint.x) * progress,
            fromPoint.y + (toPoint.y - fromPoint.y) * progress,
          )
          setMarkerPositionSmooth(record.marker, map, map.layerPointToLatLng(point))
          if (progress < 1) hasActiveAnimation = true
        }

        vehicleAnimationFrameRef.current = hasActiveAnimation
          ? window.requestAnimationFrame(animate)
          : null
      }
      vehicleAnimationFrameRef.current = window.requestAnimationFrame(animate)
    }
    window.requestAnimationFrame(() => {
      invalidateLeafletMap(map)
    })
  }, [mapData, overview?.liveVehicle?.vehicleId, selectedZoneId])

  useEffect(() => {
    const map = leafletRef.current
    if (!map) return undefined

    const layers = layersRef.current
    layers.zone?.clearLayers()
    layers.frequent?.clearLayers()
    layers.latest?.clearLayers()

    if (!selectedZoneId) return undefined

    let cancelled = false

    async function drawZoneLayers() {
      let barrioBounds = null
      if (selectedBarrioFeature) {
        const barrioLayer = L.geoJSON(selectedBarrioFeature, {
          style: {
            color: SELECTED_ZONE_STROKE_COLOR,
            weight: 3,
            opacity: 0.9,
            fillColor: SELECTED_ZONE_FILL_COLOR,
            fillOpacity: 0.12,
          },
          interactive: false,
        }).addTo(layers.zone)
        barrioBounds = barrioLayer.getBounds()
      }

      const shouldSyncViewport = viewportRef.current.pending
      if (!overview) {
        if (shouldSyncViewport) {
          if (barrioBounds?.isValid()) {
            map.fitBounds(barrioBounds, { padding: ZONE_PADDING, maxZoom: 15 })
          } else {
            map.setView(ASU_CENTER, 12)
          }
          viewportRef.current.pending = false
        }
        return
      }

      const routeDefinitions = [
        {
          key: 'frequent',
          route: overview.routeLayers?.frequent,
          style: {
            color: ROUTE_STROKE_COLOR,
            weight: 5,
            opacity: 0.85,
          },
        },
        {
          key: 'latest',
          route: overview.routeLayers?.latest,
          style: {
            color: SELECTED_ZONE_STROKE_COLOR,
            weight: 4,
            opacity: 0.92,
          },
        },
      ]

      for (const definition of routeDefinitions) {
        if (visibleRouteLayer !== definition.key || !definition.route) continue
        const coords = await getShapeCoords(definition.route, overview.zone.stopMarkers)
        if (cancelled || coords.length < 2) continue
        const clippedSegments = clipRouteToFeature(coords, selectedBarrioFeature)
        const segmentsToDraw = clippedSegments.length ? clippedSegments : [coords]

        for (const segment of segmentsToDraw) {
          if (segment.length < 2) continue
          L.polyline(segment, {
            ...definition.style,
            interactive: false,
          }).addTo(layers[definition.key])
        }
      }

      if (shouldSyncViewport) {
        if (barrioBounds?.isValid()) {
          map.fitBounds(barrioBounds, { padding: ZONE_PADDING, maxZoom: 15 })
        } else if (overview.zone.centerLat && overview.zone.centerLon) {
          map.setView([overview.zone.centerLat, overview.zone.centerLon], 14)
        } else {
          map.setView(ASU_CENTER, 12)
        }
        viewportRef.current.pending = false
      }
    }

    drawZoneLayers().then(() => {
      window.requestAnimationFrame(() => {
        invalidateLeafletMap(map)
      })
    })

    return () => {
      cancelled = true
    }
  }, [getShapeCoords, overview, selectedBarrioFeature, selectedZoneId, visibleRouteLayer])

  function openRoutePanel() {
    setRoutePanelStage('select')
    setSelectedZoneId('')
    setSelectedServiceZoneId('')
    setOverview(null)
    setDetailStatus('idle')
    setVisibleRouteLayer('none')
  }

  function closeRoutePanel() {
    setRoutePanelStage('idle')
    setSelectedZoneId('')
    setSelectedServiceZoneId('')
    setOverview(null)
    setDetailStatus('idle')
    setVisibleRouteLayer('none')
  }

  function handleBackToSelect() {
    setRoutePanelStage('select')
    setVisibleRouteLayer('none')
  }

  function handleSelectZone(zoneName) {
    setSelectedZoneId(zoneName)
    if (!zoneName) {
      setSelectedServiceZoneId('')
      setOverview(null)
      setDetailStatus('idle')
      setVisibleRouteLayer('none')
      setRoutePanelStage('select')
      return
    }

    setRoutePanelStage('detail')
    setVisibleRouteLayer('none')
  }

  function handleShowSelectedRoute() {
    if (!selectedZoneId) return
    setRoutePanelStage('detail')
    setVisibleRouteLayer((current) => (current === 'none' ? 'frequent' : current))
  }

  async function handleRefreshMap() {
    setRefreshingMap(true)
    try {
      await loadMapData({ forceRouteShapes: true })
      if (selectedServiceZoneId) {
        await loadOverview(selectedServiceZoneId)
      }
    } finally {
      setRefreshingMap(false)
    }
  }

  async function handleToggleFullscreen() {
    const stage = mapStageRef.current
    if (!stage) return

    try {
      if (document.fullscreenElement === stage) {
        await document.exitFullscreen()
      } else {
        await stage.requestFullscreen()
      }
    } catch (_error) {
      // Si el navegador no permite fullscreen, no rompemos la UX.
    }
  }

  function channelLabel(channel) {
    if (channel === 'both' || channel === 'all') return 'Portal y correo'
    return channel === 'email' ? 'Correo' : 'Portal interno'
  }

  async function loadNotifications(zoneId = '') {
    setNotificationStatus((current) => (current === 'idle' ? 'loading' : current))
    try {
      const nextNotifications = await fetchCollectionNotifications(zoneId)
      setNotifications(nextNotifications || [])
      setNotificationStatus('idle')
    } catch (_error) {
      setNotificationStatus('error')
    }
  }

  async function handleToggleNotifications() {
    if (!user) {
      openLoginModal('Iniciá sesión para configurar avisos de recolección.')
      return
    }
    if (!serviceZones.length) {
      setLocationMessage('Esta ciudad todavía no tiene barrios cargados para configurar alertas.')
      return
    }

    const nextOpen = !notificationOpen
    setNotificationOpen(nextOpen)
    if (nextOpen) {
      const defaultZoneId = selectedServiceZoneId || serviceZones[0]?.id || ''
      setNotificationForm((current) => ({
        ...current,
        zoneId: current.zoneId || defaultZoneId,
      }))
      await loadNotifications(defaultZoneId)
    }
  }

  async function handleSubmitNotification(event) {
    event.preventDefault()
    if (!notificationForm.zoneId) return

    setNotificationStatus('saving')
    try {
      await createCollectionNotification({
        zoneId: notificationForm.zoneId,
        eventType: 'collection-window',
        channel: notificationForm.channel,
        leadMinutes: 15,
        preferredDays: [],
        timeWindowStart: '',
        timeWindowEnd: '',
      })
      await loadNotifications(notificationForm.zoneId)
      setNotificationStatus('saved')
    } catch (_error) {
      setNotificationStatus('error')
    }
  }

  async function handleDeleteNotification(notificationId, zoneId) {
    setDeletingNotificationId(notificationId)
    try {
      await deleteCollectionNotification(notificationId)
      await loadNotifications(zoneId || notificationForm.zoneId)
    } catch (_error) {
      setNotificationStatus('error')
    } finally {
      setDeletingNotificationId(null)
    }
  }

  return (
    <div className="trash-screen">
      <div ref={mapStageRef} className={`trash-screen-stage ${isFullscreen ? 'is-fullscreen' : ''}`}>
        <div ref={mapRef} className="trash-screen-map gtfs-map-canvas" aria-label="Mapa de recolección" />

        <TrashMapControls
          isFullscreen={isFullscreen}
          locatingUser={locatingUser}
          notificationOpen={notificationOpen}
          onLocateUser={requestUserLocation}
          onToggleNotifications={handleToggleNotifications}
          onToggleFullscreen={handleToggleFullscreen}
        />

        <div className="trash-screen-status-pill">
          {mapStatus === 'loading'
            ? 'Cargando mapa'
            : mapData?.collectionReady === false
              ? `${mapData?.municipality?.barrioCount || serviceZones.length || 0} barrios listos`
              : `${mapData?.vehicles?.length || 0} camiones activos`}
        </div>

        {locationMessage && (
          <div className="trash-screen-feedback is-error" role="status">
            {locationMessage}
          </div>
        )}

        {notificationEvent && (
          <div className="trash-notification-toast" role="status" aria-live="polite">
            <button
              type="button"
              className="trash-notification-toast-close"
              onClick={() => setNotificationEvent(null)}
              aria-label="Cerrar aviso"
            >
              {'\u00d7'}
            </button>
            <div className="trash-notification-toast-icon" aria-hidden="true">
              <img src="/trash-truck-reference.svg" alt="" draggable="false" />
            </div>
            <div className="trash-notification-toast-copy">
              <span>Recolección en camino</span>
              <strong>{notificationEvent.barrioLabel || 'Tu barrio'}</strong>
              <p>{notificationEvent.message}</p>
            </div>
          </div>
        )}

        {notificationOpen && (
          <section className="trash-notification-popover">
            <button
              type="button"
              className="trash-route-sheet-close trash-notification-close"
              onClick={() => setNotificationOpen(false)}
              aria-label="Cerrar notificaciones"
            >
              {'\u00d7'}
            </button>
            <TrashNotificationSheet
              channelLabel={channelLabel}
              deletingId={deletingNotificationId}
              notificationForm={notificationForm}
              notifications={notifications}
              onDelete={handleDeleteNotification}
              onFormChange={(changes) => {
                setNotificationForm((current) => ({ ...current, ...changes }))
                if (changes.zoneId) void loadNotifications(changes.zoneId)
              }}
              onSubmit={handleSubmitNotification}
              readOnly={!user}
              serviceZones={serviceZones}
              status={notificationStatus}
            />
          </section>
        )}
        {routePanelStage === 'idle' && (
          <div className="trash-floating-cta">
            <button type="button" className="btn-primary trash-cta-button" onClick={openRoutePanel}>
              Elige un barrio
            </button>
          </div>
        )}

        {routePanelStage === 'select' && (
          <section className="trash-route-sheet trash-route-sheet--select">
            <div className="trash-route-sheet-head">
              <div>
                <span className="eyebrow">Recolección</span>
                <h3>Elegí un barrio</h3>
              </div>
              <button type="button" className="trash-route-sheet-close" onClick={closeRoutePanel} aria-label="Cerrar selector">
                {'\u00d7'}
              </button>
            </div>

            <p>Seleccioná la zona para consultar sus recorridos y ver la ruta sobre el mapa.</p>

            <label className="trash-route-field">
              <span>Barrio o zona</span>
              <select value={selectedZoneId} onChange={(event) => handleSelectZone(event.target.value)}>
                <option value="">Seleccionar barrio</option>
                {serviceZones.map((zone, index) => (
                  <option
                    key={`${zone.id || zone.label || 'barrio'}-${index}`}
                    value={zone.id}
                  >
                    {zone.label}
                  </option>
                ))}
              </select>
            </label>

            {mapStatus === 'error' && (
              <p className="trash-route-message is-error">No pudimos cargar el mapa de recolección. Reintentá en unos segundos.</p>
            )}

            {selectedZoneId && detailStatus === 'loading' && (
              <p className="trash-route-message">Cargando recorridos del barrio...</p>
            )}
            {selectedZoneId && detailStatus === 'error' && (
              <p className="trash-route-message is-error">No pudimos cargar los recorridos de esta zona.</p>
            )}
            {selectedZoneId && detailStatus === 'unsupported' && (
              <p className="trash-route-message">Este barrio ya está cargado para la ciudad, pero Recolección todavía no tiene rutas simuladas en este municipio.</p>
            )}
          </section>
        )}

        {routePanelStage === 'detail' && (
          <section className="trash-route-sheet trash-route-sheet--detail">
            <div className="trash-route-sheet-head">
              <div>
                <span className="eyebrow">Barrio</span>
                <h3>{selectedZoneLabel || 'Barrio seleccionado'}</h3>
              </div>
              <button type="button" className="trash-route-sheet-close" onClick={closeRoutePanel} aria-label="Cerrar detalle">
                {'\u00d7'}
              </button>
            </div>

            {detailStatus === 'loading' && (
              <p className="trash-route-message">Cargando recorridos del barrio...</p>
            )}

            {detailStatus === 'error' && (
              <p className="trash-route-message is-error">No pudimos cargar los recorridos de esta zona.</p>
            )}

            {detailStatus === 'unsupported' && (
              <p className="trash-route-message">Este barrio ya está cargado para el mapa de la ciudad, pero todavía no existe simulación de Recolección para mostrar una ruta.</p>
            )}

            {detailStatus === 'ready' && overview && (
              <>
                <div className="trash-route-summary">
                  <div>
                    <span>Próxima pasada</span>
                    <p>
                      {overview.history.nextEstimate
                        ? `${formatShortDate(overview.history.nextEstimate.occurredAt)} · ${formatTime(overview.history.nextEstimate.occurredAt)}`
                        : 'Sin estimación disponible'}
                    </p>
                  </div>
                  <div>
                    <span>Frecuencia</span>
                    <p>{overview.history.stats.averageIntervalDays || '-'} días</p>
                  </div>
                </div>


                {overview.liveVehicle && (
                  <p className="trash-route-message is-live">Hay un camión pasando por la zona ahora.</p>
                )}

                <div className="trash-route-choice">
  <span>Recolección visible</span>
  <div className="trash-route-toggle">
    <button
      type="button"
      className={visibleRouteLayer === 'frequent' ? 'is-active' : ''}
      onClick={() =>
        setVisibleRouteLayer((currentLayer) =>
          currentLayer === 'frequent' ? 'none' : 'frequent'
        )
      }
    >
      Frecuente
    </button>

    <button
      type="button"
      className={visibleRouteLayer === 'latest' ? 'is-active' : ''}
      onClick={() =>
        setVisibleRouteLayer((currentLayer) =>
          currentLayer === 'latest' ? 'none' : 'latest'
        )
      }
    >
      Última pasada
    </button>
  </div>
</div>
              </>
            )}

            <div className="trash-route-sheet-actions">
              <button type="button" className="btn-primary trash-route-sheet-button" onClick={handleBackToSelect}>
                Cambiar barrio
              </button>
              <button type="button" className="btn-secondary trash-route-sheet-button" onClick={closeRoutePanel}>
                Cerrar
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

