import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  createPotholeConfirmation,
  createPotholeReport,
  fetchPotholeReportById,
  fetchPotholesMap,
  getApiErrorMessage,
} from '../../lib/api'
import { useAppContext } from '../../lib/AppContext'
import { clusterReportsIntoIncidents } from '../../lib/adminMunicipalUtils'
import { addGoogleMapTilesLayer } from '../../lib/googleMapTiles'
import { LocationIcon, MapExpandIcon, RiskIcon, StatusIcon } from './MapIcons'

const ASU_CENTER = [-25.2867, -57.61]
const POTHOLE_TYPES = [
  { id: 'bache_aislado', label: 'Un pozo en la calle' },
  { id: 'conjunto_de_baches', label: 'Varios pozos juntos' },
  { id: 'hundimiento_o_rotura_grande', label: 'La calle está hundida o rota' },
]

const SEVERITY_OPTIONS = [
  { id: 'baja', label: 'Bajo', help: 'Peligro bajo.' },
  { id: 'media', label: 'Medio', help: 'Peligro moderado.' },
  { id: 'alta', label: 'Alto', help: 'Peligro alto.' },
]

const PRIORITY_COLORS = {
  alta: '#FF5A33',
  media: '#F2B544',
  baja: '#146152',
}

const STATUS_COLORS = {
  resuelto: '#146152',
  default: '#FF5A33',
}

const PRIORITY_SIZES = {
  alta: 30,
  media: 26,
  baja: 22,
}
const POTHOLE_MAX_FILES = 1
const POTHOLE_MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024
const POTHOLE_ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
])
const POTHOLE_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif'

function resolveMarkerColor(incident, markerView) {
  if (markerView === 'priority') {
    return PRIORITY_COLORS[incident.priorityBand] || PRIORITY_COLORS.media
  }

  if (incident.status === 'resuelto') return STATUS_COLORS.resuelto
  return STATUS_COLORS.default
}

function potholeMarker(incident, markerView = 'status', selected = false) {
  const color = resolveMarkerColor(incident, markerView)
  const baseSize = PRIORITY_SIZES[incident.priorityBand] || PRIORITY_SIZES.media
  const size = selected ? baseSize + 4 : baseSize
  const badge = incident.confirmationCount
    ? `<span style="
        position:absolute;
        right:-8px;
        bottom:-8px;
        min-width:20px;
        height:20px;
        padding:0 6px;
        border-radius:999px;
        background:#0A1814;
        color:#fff;
        font-size:10px;
        font-weight:700;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        border:2px solid #fff;
      ">${incident.confirmationCount}</span>`
    : ''

  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative;width:${size}px;height:${size}px;">
        <div style="
          width:${size}px;
          height:${size}px;
          border-radius:999px;
          background:${color};
          border:${selected ? '3px solid #0A1814' : '3px solid #ffffff'};
          box-shadow:${selected ? '0 10px 24px rgba(10, 24, 20, 0.3)' : '0 8px 20px rgba(10, 24, 20, 0.16)'};
        "></div>
        ${badge}
      </div>
    `,
    iconSize: [size + 12, size + 12],
    iconAnchor: [size / 2, size / 2],
  })
}

function userLocationMarker() {
  return L.divIcon({
    className: '',
    html: `
      <div style="
        width:16px;
        height:16px;
        border-radius:999px;
        background:#2F80ED;
        border:3px solid #ffffff;
        box-shadow:0 8px 18px rgba(47, 128, 237, 0.3);
      "></div>
    `,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  })
}

function formatDateTime(value) {
  if (!value) return 'Sin dato'
  return new Date(value).toLocaleString('es-PY', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDate(value) {
  if (!value) return 'Sin dato'
  return new Date(value).toLocaleDateString('es-PY', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function formatCoords(point) {
  if (!point) return 'Sin ubicaci\u00f3n'
  return `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`
}

function getPotholeTypeLabel(value) {
  return POTHOLE_TYPES.find((item) => item.id === value)?.label || 'Bache'
}

function getRiskBandLabel(value) {
  if (value === 'alta') return 'alto'
  if (value === 'baja') return 'bajo'
  return 'medio'
}

function validatePotholeFiles(nextFiles = [], previous = []) {
  const files = [...previous]
  const errors = []

  for (const file of nextFiles) {
    if (!POTHOLE_ALLOWED_IMAGE_TYPES.has(String(file?.type || '').toLowerCase())) {
      errors.push('Solo se permiten fotos JPG, PNG, WEBP o HEIC.')
      continue
    }

    if (Number(file?.size || 0) > POTHOLE_MAX_FILE_SIZE_BYTES) {
      errors.push('Cada foto puede pesar hasta 8 MB.')
      continue
    }

    if (files.length >= POTHOLE_MAX_FILES) {
      errors.push('Podés subir solo 1 foto por reporte.')
      continue
    }

    files.push(file)
  }

  return {
    files,
    error: errors[0] || '',
  }
}

function resolveErrorMessage(error, fallback) {
  if (!error) return fallback
  if (error.message === 'Failed to fetch') {
    return 'No se pudo conectar con el servidor. Prob\u00e1 de nuevo.'
  }
  return getApiErrorMessage(error.code || error.message, fallback)
}

function resolveReportSubmitError(error, filesCount) {
  if (error?.code === 'pothole-storage-not-configured' && Number(filesCount || 0) > 0) {
    return 'Las fotos están deshabilitadas temporalmente en este momento. Si querés, podés enviar el reporte sin imagen mientras terminamos la configuración.'
  }

  return resolveErrorMessage(error, 'No se pudo enviar el reporte.')
}

function PotholesMap({
  viewOnly = false,
  showDetailSheet = !viewOnly,
  allowMarkerSelection = true,
  selectedIncidentId: controlledSelectedIncidentId = null,
  onSelectIncident = null,
  incidentsOverride = null,
}) {
  const { user, municipality } = useAppContext()
  const mapCanvasRef = useRef(null)
  const mapStageRef = useRef(null)
  const leafletRef = useRef(null)
  const reportStageRef = useRef('idle')
  const cameraInputRef = useRef(null)
  const galleryInputRef = useRef(null)
  const layersRef = useRef({
    incidents: null,
    userLocation: null,
  })
  const geolocationRequestedRef = useRef(false)
  const geolocationPendingRef = useRef(false)
  const geolocationBlockedRef = useRef(false)
  const userPositionRef = useRef(null)

  const [mapStatus, setMapStatus] = useState('loading')
  const [detailStatus, setDetailStatus] = useState('idle')
  const [submitStatus, setSubmitStatus] = useState('idle')
  const [confirmationStatus, setConfirmationStatus] = useState('idle')
  const [notice, setNotice] = useState({ kind: 'idle', text: '' })
  const [mapData, setMapData] = useState(null)
  const [internalSelectedIncidentId, setInternalSelectedIncidentId] = useState(null)
  const [selectedDetail, setSelectedDetail] = useState(null)
  const [reportStage, setReportStage] = useState('idle')
  const [draftPoint, setDraftPoint] = useState(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [userLocationReady, setUserLocationReady] = useState(false)
  const [markerView, setMarkerView] = useState('status')
  const [legendOverlayMode, setLegendOverlayMode] = useState(null)
  const [formState, setFormState] = useState({
    potholeType: 'bache_aislado',
    reportedSeverity: 'media',
    description: '',
    referenceText: '',
    files: [],
  })

  const incidents = useMemo(() => {
    if (Array.isArray(incidentsOverride)) {
      return incidentsOverride.filter((incident) => incident.status !== 'descartado')
    }

    const backendIncidents = mapData?.incidents || []
    const reports = mapData?.reports || []

    if (!reports.length) {
      return backendIncidents.filter((incident) => incident.status !== 'descartado')
    }

    const confirmationStateByPrimaryReport = new Map(
      backendIncidents.map((incident) => [incident.primaryReportId, Boolean(incident.viewerHasConfirmed)]),
    )

    return clusterReportsIntoIncidents(reports)
      .map((incident) => ({
        ...incident,
        viewerHasConfirmed: confirmationStateByPrimaryReport.get(incident.primaryReportId) || false,
      }))
      .filter((incident) => incident.status !== 'descartado')
  }, [incidentsOverride, mapData?.incidents, mapData?.reports])
  const openIncidentsCount = useMemo(
    () => incidents.filter((incident) => incident.status !== 'resuelto' && incident.status !== 'descartado').length,
    [incidents],
  )
  const selectedIncidentId = controlledSelectedIncidentId ?? internalSelectedIncidentId
  const selectedIncident = incidents.find((incident) => incident.incidentId === selectedIncidentId) || null
  const isPickingLocation = reportStage === 'pick'
  const isCompletingReport = reportStage === 'form'
  const isReporting = reportStage !== 'idle'
  const hasActiveMobileOverlay = isReporting || (showDetailSheet && Boolean(selectedIncident))
  const visibleCountLabel = useMemo(() => {
    if (openIncidentsCount === 1) return '1 bache abierto'
    return `${openIncidentsCount} baches abiertos`
  }, [openIncidentsCount])

  const selectIncident = useCallback(
    (incidentId) => {
      if (controlledSelectedIncidentId === null || controlledSelectedIncidentId === undefined) {
        setInternalSelectedIncidentId(incidentId)
      }
      onSelectIncident?.(incidentId)
    },
    [controlledSelectedIncidentId, onSelectIncident],
  )

  const focusMapLocation = useCallback((lat, lon, zoom = 16) => {
    const map = leafletRef.current
    if (!map) return
    map.flyTo([lat, lon], zoom, { duration: 0.4 })
  }, [])

  const loadMap = useCallback(async () => {
    setMapStatus((current) => (current === 'ready' ? 'refreshing' : 'loading'))
    try {
      const nextMap = await fetchPotholesMap({
        municipalitySlug: municipality?.key || '',
      })
      setMapData(nextMap)
      setMapStatus('ready')
      return nextMap
    } catch (error) {
      setMapStatus('error')
      setNotice({
        kind: 'error',
        text: resolveErrorMessage(error, 'No se pudo cargar el mapa de baches.'),
      })
      return null
    }
  }, [municipality?.key])

  const loadSelectedDetail = useCallback(
    async (primaryReportId, { silent = false } = {}) => {
      if (!primaryReportId) {
        setSelectedDetail(null)
        setDetailStatus('idle')
        return null
      }

      if (!silent) setDetailStatus('loading')
      try {
        const detail = await fetchPotholeReportById(primaryReportId)
        setSelectedDetail(detail)
        setDetailStatus('ready')
        return detail
      } catch (error) {
        setSelectedDetail(null)
        setDetailStatus('error')
        return null
      }
    },
    [],
  )

  const requestUserLocation = useCallback(
    (force = false) => {
      if (!navigator.geolocation || geolocationPendingRef.current) return
      if (geolocationBlockedRef.current) {
        if (force) {
          setNotice({
            kind: 'error',
            text: 'La ubicaci\u00f3n est\u00e1 bloqueada en el navegador. Pod\u00e9s habilitarla desde el icono del sitio.',
          })
        }
        return
      }
      if (!force && geolocationRequestedRef.current) return

      geolocationRequestedRef.current = true
      geolocationPendingRef.current = true

      navigator.geolocation.getCurrentPosition(
        (position) => {
          geolocationPendingRef.current = false
          const nextPoint = {
            lat: Number(position.coords.latitude.toFixed(6)),
            lon: Number(position.coords.longitude.toFixed(6)),
          }
          userPositionRef.current = nextPoint
          setUserLocationReady(true)
          focusMapLocation(nextPoint.lat, nextPoint.lon)
        },
        (error) => {
          geolocationPendingRef.current = false
          setUserLocationReady(false)
          if (error?.code === 1) {
            geolocationBlockedRef.current = true
            if (force) {
              setNotice({
                kind: 'error',
                text: 'La ubicaci\u00f3n est\u00e1 bloqueada en el navegador. Pod\u00e9s habilitarla desde el icono del sitio.',
              })
            }
          }
        },
        {
          enableHighAccuracy: true,
          timeout: 9000,
          maximumAge: 180000,
        },
      )
    },
    [focusMapLocation],
  )

  useEffect(() => {
    if (Array.isArray(incidentsOverride)) {
      setMapStatus('ready')
      return undefined
    }
    void loadMap()
    return undefined
  }, [incidentsOverride, loadMap])

  useEffect(() => {
    reportStageRef.current = reportStage
  }, [reportStage])

  useEffect(() => {
    if (!mapCanvasRef.current || leafletRef.current) return undefined

    let cancelled = false
    let baseLayer = null
    const map = L.map(mapCanvasRef.current, {
      center: ASU_CENTER,
      zoom: 12,
      zoomControl: false,
      attributionControl: true,
    })

    void addGoogleMapTilesLayer(L, map).then((result) => {
      if (cancelled) {
        result.layer?.remove()
        return
      }
      baseLayer = result.layer
    })

    layersRef.current.incidents = L.layerGroup().addTo(map)
    layersRef.current.userLocation = L.layerGroup().addTo(map)
    leafletRef.current = map

    requestUserLocation()

    return () => {
      cancelled = true
      baseLayer?.remove()
      map.remove()
      leafletRef.current = null
    }
  }, [requestUserLocation])

  useEffect(() => {
    function syncFullscreenState() {
      setIsFullscreen(document.fullscreenElement === mapStageRef.current)
    }

    document.addEventListener('fullscreenchange', syncFullscreenState)
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState)
  }, [])

  useEffect(() => {
    const map = leafletRef.current
    if (!map) return undefined

    const timeout = window.setTimeout(() => {
      map.invalidateSize()
    }, 80)

    return () => window.clearTimeout(timeout)
  }, [isFullscreen, mapStatus, viewOnly])

  useEffect(() => {
    const map = leafletRef.current
    const bbox = mapData?.municipality?.bbox
    if (!map || !bbox || selectedIncident || isReporting) return

    const hasBounds =
      Number.isFinite(Number(bbox.minLat)) &&
      Number.isFinite(Number(bbox.maxLat)) &&
      Number.isFinite(Number(bbox.minLon)) &&
      Number.isFinite(Number(bbox.maxLon))

    if (hasBounds) {
      map.fitBounds(
        [
          [Number(bbox.minLat), Number(bbox.minLon)],
          [Number(bbox.maxLat), Number(bbox.maxLon)],
        ],
        { padding: [24, 24], maxZoom: 13 },
      )
      return
    }

    if (Number.isFinite(Number(mapData?.municipality?.centerLat)) && Number.isFinite(Number(mapData?.municipality?.centerLon))) {
      map.flyTo([Number(mapData.municipality.centerLat), Number(mapData.municipality.centerLon)], 13, { duration: 0.4 })
    }
  }, [isReporting, mapData?.municipality?.bbox, mapData?.municipality?.centerLat, mapData?.municipality?.centerLon, mapData?.municipality?.slug, selectedIncident])

  useEffect(() => {
    const incidentsLayer = layersRef.current.incidents
    if (!incidentsLayer) return

    incidentsLayer.clearLayers()
    incidents.forEach((incident) => {
      const marker = L.marker([incident.lat, incident.lon], {
        interactive: allowMarkerSelection,
        icon: potholeMarker(incident, markerView, incident.incidentId === selectedIncidentId),
      })

      if (allowMarkerSelection) {
        marker.on('click', () => {
          if (reportStageRef.current !== 'idle') return
          selectIncident(incident.incidentId)
          setNotice({ kind: 'idle', text: '' })
        })
      }

      marker.bindTooltip('Bache', {
        direction: 'top',
        offset: [0, -10],
        opacity: 0.96,
      })

      marker.addTo(incidentsLayer)
    })
  }, [allowMarkerSelection, incidents, markerView, selectIncident, selectedIncidentId])

  useEffect(() => {
    const locationLayer = layersRef.current.userLocation
    if (!locationLayer) return

    locationLayer.clearLayers()
    if (!userPositionRef.current) return

    const marker = L.marker([userPositionRef.current.lat, userPositionRef.current.lon], {
      icon: userLocationMarker(),
    })

    marker.bindTooltip('Tu ubicación', {
      direction: 'top',
      offset: [0, -10],
      opacity: 0.96,
    })

    marker.addTo(locationLayer)
  }, [userLocationReady])

  useEffect(() => {
    if (!selectedIncident?.primaryReportId || isReporting) {
      if (!selectedIncident) {
        setSelectedDetail(null)
        setDetailStatus('idle')
      }
      return
    }

    void loadSelectedDetail(selectedIncident.primaryReportId)
  }, [isReporting, loadSelectedDetail, selectedIncident])

  useEffect(() => {
    if (!selectedIncident || isReporting) return
    focusMapLocation(selectedIncident.lat, selectedIncident.lon, 16)
  }, [focusMapLocation, isReporting, selectedIncident])

  useEffect(() => {
    if (!notice.text) return undefined
    const timeout = window.setTimeout(() => {
      setNotice((current) => (current.text ? { kind: 'idle', text: '' } : current))
    }, notice.kind === 'error' ? 4200 : 2600)

    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    if (!legendOverlayMode) return undefined
    const timeout = window.setTimeout(() => {
      setLegendOverlayMode(null)
    }, 3000)
    return () => window.clearTimeout(timeout)
  }, [legendOverlayMode])

  const switchMarkerView = useCallback((nextView, { flashLegend = false } = {}) => {
    setMarkerView(nextView)
    if (flashLegend) {
      setLegendOverlayMode(nextView)
    }
  }, [])

  const clearSelection = useCallback(() => {
    if (controlledSelectedIncidentId === null || controlledSelectedIncidentId === undefined) {
      setInternalSelectedIncidentId(null)
    }
    onSelectIncident?.(null)
    setSelectedDetail(null)
    setDetailStatus('idle')
  }, [controlledSelectedIncidentId, onSelectIncident])

  const resetReportForm = useCallback(() => {
    setFormState({
      potholeType: 'bache_aislado',
      reportedSeverity: 'media',
      description: '',
      referenceText: '',
      files: [],
    })
  }, [])

  const startReportMode = useCallback(() => {
    clearSelection()
    resetReportForm()
    setDraftPoint(null)
    setSubmitStatus('idle')
    setConfirmationStatus('idle')
    setNotice({ kind: 'idle', text: '' })
    setReportStage('pick')
    if (userPositionRef.current) {
      focusMapLocation(userPositionRef.current.lat, userPositionRef.current.lon)
    }
  }, [clearSelection, focusMapLocation, resetReportForm])

  function cancelReportMode() {
    setReportStage('idle')
    setDraftPoint(null)
    setSubmitStatus('idle')
    resetReportForm()
  }

  function confirmDraftLocation() {
    const map = leafletRef.current
    if (!map) return
    const center = map.getCenter()
    setDraftPoint({
      lat: Number(center.lat.toFixed(6)),
      lon: Number(center.lng.toFixed(6)),
    })
    setReportStage('form')
    setNotice({ kind: 'idle', text: '' })
  }

  function handleFileAppend(nextFiles = []) {
    setFormState((current) => {
      const result = validatePotholeFiles(nextFiles, current.files)
      if (result.error) {
        setNotice({ kind: 'error', text: result.error })
      }
      return {
        ...current,
        files: result.files,
      }
    })
  }

  async function handleSubmitReport(event) {
    event.preventDefault()

    if (!draftPoint) {
      setSubmitStatus('error')
      setNotice({ kind: 'error', text: 'Primero confirm\u00e1 la ubicaci\u00f3n del bache.' })
      return
    }

    if (!formState.description.trim()) {
      setSubmitStatus('error')
      setNotice({ kind: 'error', text: 'Describ\u00ed el bache antes de enviarlo.' })
      return
    }

    setSubmitStatus('saving')
    setNotice({ kind: 'idle', text: '' })

    try {
      const created = await createPotholeReport({
        municipalitySlug: municipality?.key || '',
        lat: draftPoint.lat,
        lon: draftPoint.lon,
        potholeType: formState.potholeType,
        referenceText: formState.referenceText,
        description: formState.description,
        reportedSeverity: formState.reportedSeverity,
        files: formState.files,
      })

      await loadMap()
      const nextPrimaryReportId = created.incident?.primaryReportId || created.id
      const nextIncidentId = created.incident?.incidentId || `incident-${nextPrimaryReportId}`
      selectIncident(nextIncidentId)
      setSelectedDetail(await loadSelectedDetail(nextPrimaryReportId, { silent: true }))
      setReportStage('idle')
      setDraftPoint(null)
      setSubmitStatus('done')
      resetReportForm()
      setNotice({ kind: 'success', text: 'Reporte enviado correctamente.' })
    } catch (error) {
      setSubmitStatus('error')
      setNotice({
        kind: 'error',
        text: resolveReportSubmitError(error, formState.files.length),
      })
    }
  }

  async function handleConfirmIncident() {
    const targetReportId = selectedIncident?.primaryReportId
    if (!targetReportId) return

    setConfirmationStatus('saving')
    setNotice({ kind: 'idle', text: '' })

    try {
      const updated = await createPotholeConfirmation({
        reportId: targetReportId,
      })

      await loadMap()
      const nextIncidentId = updated.incident?.incidentId || `incident-${updated.id}`
      selectIncident(nextIncidentId)
      setSelectedDetail(updated)
      setConfirmationStatus('done')
      setNotice({ kind: 'success', text: 'Confirmaci\u00f3n registrada.' })
    } catch (error) {
      setConfirmationStatus('error')
      setNotice({
        kind: 'error',
        text: resolveErrorMessage(error, 'No se pudo confirmar este bache.'),
      })
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
      // noop
    }
  }

  const detailIncident = selectedDetail?.incident || null
  const hasConfirmedSelected = Boolean(detailIncident?.viewerHasConfirmed ?? selectedIncident?.viewerHasConfirmed)
  const resolvedAtLabel = formatDate(detailIncident?.updatedAt || selectedDetail?.updatedAt || selectedIncident?.updatedAt)

  return (
    <div className="potholes-screen">
      <div ref={mapStageRef} className={`potholes-screen-stage ${isFullscreen ? 'is-fullscreen' : ''}`}>
        <div ref={mapCanvasRef} className="potholes-screen-map" aria-label="Mapa p\u00fablico de baches" />

        <div className={`potholes-map-topbar ${hasActiveMobileOverlay ? 'is-hidden-mobile' : ''}`}>
          <button
            type="button"
            className={`potholes-map-control potholes-map-control-desktop potholes-map-control-status ${markerView === 'status' ? 'is-active' : ''}`}
            onClick={() => switchMarkerView('status', { flashLegend: true })}
            aria-label="Mostrar estados"
            title="Mostrar estados"
          >
            <StatusIcon className="potholes-map-icon" />
          </button>
          <button
            type="button"
            className={`potholes-map-control potholes-map-control-desktop potholes-map-control-risk ${markerView === 'priority' ? 'is-active' : ''}`}
            onClick={() => switchMarkerView('priority', { flashLegend: true })}
            aria-label="Mostrar riesgos"
            title="Mostrar riesgos"
          >
            <RiskIcon className="potholes-map-icon" />
          </button>
          <button
            type="button"
            className="potholes-map-control potholes-map-control-desktop"
            onClick={() => requestUserLocation(true)}
            aria-label="Ir a mi ubicaci\u00f3n"
            title="Ir a mi ubicación"
          >
            <LocationIcon className="potholes-map-icon" />
          </button>
          <button
            type="button"
            className="potholes-map-control potholes-map-control-desktop"
            onClick={handleToggleFullscreen}
            aria-label={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
            title={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
          >
            <MapExpandIcon active={isFullscreen} className="potholes-map-icon" />
          </button>
        </div>

        <div className="potholes-screen-controls">
        </div>


        <div className="potholes-screen-status-pill">{visibleCountLabel}</div>

        <div className={`potholes-map-legend-card ${legendOverlayMode ? 'is-visible' : ''}`} aria-live="polite">
          {(legendOverlayMode || markerView) === 'status' ? (
            <>
              <span className="potholes-map-legend-item">
                <span className="potholes-map-legend-dot is-open" />
                Abiertos
              </span>
              <span className="potholes-map-legend-item">
                <span className="potholes-map-legend-dot is-fixed" />
                Reparados
              </span>
            </>
          ) : (
            <>
              <span className="potholes-map-legend-item">
                <span className="potholes-map-legend-dot is-high" />
                Alto
              </span>
              <span className="potholes-map-legend-item">
                <span className="potholes-map-legend-dot is-medium" />
                Medio
              </span>
              <span className="potholes-map-legend-item">
                <span className="potholes-map-legend-dot is-low" />
                Bajo
              </span>
            </>
          )}
        </div>

        {!viewOnly && !isReporting && !selectedIncident && (
          <div className="potholes-floating-cta">
            <button type="button" className="btn-primary potholes-cta-button" onClick={startReportMode}>
              Reportar bache
            </button>
          </div>
        )}

        {isPickingLocation && (
          <>
            <div className="potholes-map-picker-pin" aria-hidden="true">
              <span className="potholes-map-picker-head" />
              <span className="potholes-map-picker-tail" />
            </div>
            <div className="potholes-map-toast">{'Mov\u00e9 el mapa hasta dejar el bache en el centro'}</div>
          </>
        )}

        {mapStatus === 'loading' && (
          <div className="potholes-map-loading">
            <div className="gtfs-map-loading-spinner" />
            Cargando mapa
          </div>
        )}

        {notice.text && (
          <div className={`potholes-screen-feedback ${notice.kind === 'error' ? 'is-error' : ''}`}>
            {notice.text}
          </div>
        )}

        {isPickingLocation && (
          <section className="potholes-sheet potholes-sheet--picker">
            <span className="eyebrow">Baches</span>
            <span className="potholes-sheet-kicker">{'Eleg\u00ed el punto'}</span>
            <h3>{'Ubic\u00e1 el bache en el centro'}</h3>
            <p>{'Mov\u00e9 el mapa y confirm\u00e1 cuando el pin quede sobre el bache.'}</p>
            <div className="potholes-sheet-actions">
              <button type="button" className="btn-primary potholes-sheet-button" onClick={confirmDraftLocation}>
                {'Confirmar ubicaci\u00f3n'}
              </button>
              <button type="button" className="btn-secondary potholes-sheet-button" onClick={cancelReportMode}>
                Cancelar
              </button>
            </div>
          </section>
        )}

        {isCompletingReport && (
          <section className="potholes-sheet potholes-sheet--form">
            <div className="potholes-sheet-head">
              <div>
                <span className="eyebrow">Baches</span>
                <span className="potholes-sheet-kicker">Nuevo reporte</span>
                <h3>{'Complet\u00e1 la informaci\u00f3n'}</h3>
              </div>
              <button type="button" className="potholes-sheet-close" onClick={cancelReportMode} aria-label="Cerrar formulario">
                {'\u00d7'}
              </button>
            </div>

            <div className="potholes-location-preview">
              <span className="eyebrow">{'Ubicaci\u00f3n'}</span>
              <strong>{formatCoords(draftPoint)}</strong>
            </div>

            <form className="potholes-report-form" onSubmit={handleSubmitReport}>
              <label className="potholes-public-field">
                <span>Tipo</span>
                <select
                  value={formState.potholeType}
                  onChange={(event) => setFormState((current) => ({ ...current, potholeType: event.target.value }))}
                >
                  {POTHOLE_TYPES.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="potholes-public-field">
                <span>Que tan grave es</span>
                <select
                  value={formState.reportedSeverity}
                  onChange={(event) => setFormState((current) => ({ ...current, reportedSeverity: event.target.value }))}
                >
                  {SEVERITY_OPTIONS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label} - {item.help}
                    </option>
                  ))}
                </select>
              </label>

              <label className="potholes-public-field">
                <span>Referencia</span>
                <input
                  type="text"
                  value={formState.referenceText}
                  onChange={(event) => setFormState((current) => ({ ...current, referenceText: event.target.value }))}
                  placeholder="Esquina o punto de referencia"
                />
              </label>

              <label className="potholes-public-field">
                <span>{'Descripci\u00f3n'}</span>
                <textarea
                  value={formState.description}
                  onChange={(event) => setFormState((current) => ({ ...current, description: event.target.value }))}
                  placeholder={'Contanos qu\u00e9 pasa en la calle'}
                  rows={1}
                />
              </label>

              <div className="potholes-public-field">
                <span>Fotos (opcional)</span>
                <small>1 foto por reporte. JPG, PNG, WEBP o HEIC. Max. 8 MB.</small>
                <div className="potholes-photo-actions">
                  <button type="button" className="btn-secondary potholes-photo-button" onClick={() => cameraInputRef.current?.click()}>
                    Sacar foto
                  </button>
                  <button type="button" className="btn-secondary potholes-photo-button" onClick={() => galleryInputRef.current?.click()}>
                    Subir foto
                  </button>
                </div>
                <input
                  ref={cameraInputRef}
                  type="file"
                  accept={POTHOLE_IMAGE_ACCEPT}
                  capture="environment"
                  hidden
                  onChange={(event) => {
                    handleFileAppend(Array.from(event.target.files || []))
                    event.target.value = ''
                  }}
                />
                <input
                  ref={galleryInputRef}
                  type="file"
                  accept={POTHOLE_IMAGE_ACCEPT}
                  hidden
                  onChange={(event) => {
                    handleFileAppend(Array.from(event.target.files || []))
                    event.target.value = ''
                  }}
                />
                {formState.files.length > 0 && (
                  <div className="potholes-photo-list">
                    {formState.files.map((file, index) => (
                      <div key={`${file.name}-${index}`} className="potholes-photo-chip">
                        <span>{file.name}</span>
                        <button
                          type="button"
                          aria-label="Quitar foto"
                          onClick={() =>
                            setFormState((current) => ({
                              ...current,
                              files: current.files.filter((_, currentIndex) => currentIndex !== index),
                            }))
                          }
                        >
                          {'\u00d7'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="potholes-sheet-actions">
                <button type="submit" className="btn-primary potholes-sheet-button" disabled={submitStatus === 'saving'}>
                  {submitStatus === 'saving' ? 'Enviando...' : 'Enviar reporte'}
                </button>
                <button type="button" className="btn-secondary potholes-sheet-button" onClick={() => setReportStage('pick')}>
                  {'Ajustar ubicaci\u00f3n'}
                </button>
              </div>
            </form>
          </section>
        )}

        {showDetailSheet && !isReporting && selectedIncident && (
          <section className="potholes-sheet potholes-sheet--detail">
            <div className="potholes-sheet-head">
              <div>
                <span className="eyebrow">{selectedIncident.barrioLabel || 'Bache'}</span>
                <h3>{getPotholeTypeLabel(detailIncident?.potholeType || selectedIncident.potholeType)}</h3>
              </div>
              <button type="button" className="potholes-sheet-close" onClick={clearSelection} aria-label="Cerrar detalle">
                {'\u00d7'}
              </button>
            </div>

            <div className="potholes-sheet-meta">
              <span className={`potholes-state-pill is-risk-${selectedIncident.priorityBand || 'media'}`}>
                {`Riesgo ${getRiskBandLabel(selectedIncident.priorityBand || 'media')}`}
              </span>
              <span className={`potholes-state-pill is-${selectedIncident.status || 'nuevo'}`}>
                {selectedIncident.status === 'resuelto'
                  ? 'Reparado'
                  : selectedIncident.status === 'descartado'
                    ? 'Descartado'
                    : 'Abierto'}
              </span>
            </div>

            <p className="potholes-sheet-copy">
              {selectedIncident.description || selectedDetail?.description || 'Todav\u00eda no hay una descripci\u00f3n cargada.'}
            </p>

            <div className="potholes-detail-stats">
              <div>
                <strong>{detailIncident?.reportCount || selectedIncident.reportCount || 1}</strong>
                <span>Reportes</span>
              </div>
              <div>
                <strong>{detailIncident?.confirmationCount || selectedIncident.confirmationCount || 0}</strong>
                <span>Confirmaciones</span>
              </div>
            </div>

            <div className="potholes-detail-meta">
              <span>{selectedIncident.referenceText || 'Sin referencia cargada'}</span>
              <span>{formatDateTime(selectedDetail?.createdAt || selectedIncident.createdAt)}</span>
            </div>

            <div className="potholes-sheet-actions">
              {!viewOnly && selectedIncident.status === 'resuelto' ? (
              <div className="potholes-resolved-date potholes-sheet-button">
                Reparado el {resolvedAtLabel}
              </div>
              ) : !viewOnly && (
              <button
                type="button"
                className={`btn-primary potholes-sheet-button ${hasConfirmedSelected ? 'is-locked' : ''}`}
                disabled={confirmationStatus === 'saving'}
                aria-disabled={hasConfirmedSelected}
                onClick={hasConfirmedSelected ? undefined : handleConfirmIncident}
              >
                {confirmationStatus === 'saving'
                  ? 'Confirmando...'
                  : hasConfirmedSelected
                    ? 'Ya lo confirmé'
                    : 'Confirmar bache'}
              </button>
              )}
              <button type="button" className="btn-secondary potholes-sheet-button" onClick={clearSelection}>
                Cerrar
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

export default PotholesMap
