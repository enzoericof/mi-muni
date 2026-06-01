import { useEffect, useId, useMemo, useRef, useState } from 'react'
import AuthMenu from '../components/layout/AuthMenu'
import Header from '../components/layout/Header'
import MunicipalitySelector from '../components/layout/MunicipalitySelector'
import {
  bootstrapRagMunicipalityGeography,
  bulkUpdateRagInfoPublication,
  cancelRagCrawlJob,
  checkRagSeedUrl,
  clearRagEmbeddings,
  createMunicipalBarrio as createMunicipalBarrioRequest,
  createRagMunicipality,
  createRagCrawlJob,
  createRagSeedUrl,
  deleteRagCrawlJob,
  deleteRagSeedUrl,
  fetchCollectionRuntimeSession,
  fetchMunicipalBarrios,
  fetchRagAdminCatalog,
  fetchRagEmbeddingDetails,
  fetchRagAdminRuntime,
  fetchRagCrawlJobResults,
  fetchRagCrawlJobs,
  fetchRagMunicipalities,
  fetchRagSeedUrls,
  fetchRagSourceHealth,
  importRagMunicipalityBarrios,
  rebuildRagEmbeddings,
  reloadRagAdminIndex,
  updateMunicipalBarrio as updateMunicipalBarrioRequest,
  updateRagInfoPublication,
  updateCollectionRuntimeSession,
  updateRagAdminRuntime,
  updateRagMunicipality,
} from '../lib/api'
import { useAppContext } from '../lib/AppContext'
import { makeNavigate, navigation } from '../lib/navigation'
import { userHasRole } from '../lib/roles'
import { useHashRoute } from '../lib/router'

function formatDateTime(value) {
  if (!value) return 'Sin registro'
  return new Date(value).toLocaleString('es-PY', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatStatus(value) {
  const labels = {
    queued: 'En cola',
    running: 'Ejecutando',
    completed: 'Completado',
    failed: 'Error',
    cancelled: 'Cancelado',
    active: 'Activa',
    paused: 'Pausada',
    changed: 'Cambiada',
    unchanged: 'Sin cambios',
    stale: 'Vieja',
    error: 'Con error',
    never_checked: 'Sin chequeo',
    unknown: 'Sin dato',
  }
  return labels[value] || value || 'Sin estado'
}

function healthTone(value) {
  if (['changed', 'stale', 'error', 'failed', 'cancelled'].includes(value)) return 'is-off'
  if (['unchanged', 'completed', 'active'].includes(value)) return 'is-on'
  return ''
}

function canExecuteSeedCrawl(seed, healthValue) {
  return seed?.status === 'active' && ['changed', 'unchanged'].includes(healthValue)
}

function domainToSeedUrl(domain) {
  const normalized = String(domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  return normalized ? `https://${normalized}/` : ''
}

const DEFAULT_SEED_FORM_LIMITS = Object.freeze({
  maxDepth: 2,
  maxPages: 80,
  maxPdfs: 30,
  maxImages: 50,
  staleAfterDays: 30,
})

const MUNICIPALITY_SELECTOR_PREVIEW_LIMIT = 4

function createSeedForm(url = '') {
  return {
    url,
    ...DEFAULT_SEED_FORM_LIMITS,
  }
}

function createMunicipalityForm() {
  return {
    name: '',
    slug: '',
    department: '',
    ineCode: '',
    primaryDomain: '',
  }
}

function createGeoImportForm() {
  return {
    file: null,
    sourceName: '',
    sourceUrl: '',
  }
}

function limitMunicipalityPreview(list, selectedId, maxItems = MUNICIPALITY_SELECTOR_PREVIEW_LIMIT) {
  if (!Array.isArray(list) || list.length <= maxItems) return list
  const selected = list.find((item) => String(item.id) === String(selectedId))
  const preview = []

  if (selected) {
    preview.push(selected)
  }

  for (const item of list) {
    if (preview.length >= maxItems) break
    if (selected && String(item.id) === String(selected.id)) continue
    preview.push(item)
  }

  return preview
}

function formatCoordinateInput(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return ''
  return numeric.toFixed(6)
}

function createBarrioForm(barrio = null, municipality = null) {
  return {
    barrioLabel: barrio?.barrioLabel || '',
    barrioCode: barrio?.barrioCode || '',
    centerLat: formatCoordinateInput(barrio?.centerLat ?? municipality?.centerLat),
    centerLon: formatCoordinateInput(barrio?.centerLon ?? municipality?.centerLon),
  }
}

function createRagRuntimeDraft(runtime = null) {
  return {
    assistantUseEmbeddings: runtime?.assistantUseEmbeddings !== false,
    assistantChunkLimit: Number(runtime?.assistantChunkLimit || 10),
    assistantMinRelevanceScore: Number(runtime?.assistantMinRelevanceScore || 5),
    assistantStrictMunicipalityScope: runtime?.assistantStrictMunicipalityScope !== false,
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`
}

function formatCoordinate(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 'Sin dato'
  return numeric.toFixed(6)
}

function shortText(value, maxLength = 180) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`
}

function formatDuration(startedAt, finishedAt) {
  if (!startedAt) return 'Sin inicio'
  const start = new Date(startedAt).getTime()
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 'Sin duracion'
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function formatJobStats(job) {
  const stats = job?.stats || {}
  return `${stats.pages || 0} pag. - ${stats.pdfs || 0} PDF - ${stats.images || 0} img. - ${stats.errors || 0} err.`
}

function formatSourceType(value) {
  const labels = {
    html: 'HTML',
    pdf: 'PDF',
    image: 'Imagen',
    manual: 'Manual',
  }
  return labels[value] || value || 'Fuente'
}

function formatEmbeddingCoverage(item) {
  if (item?.hasVectorEmbedding && item?.hasJsonEmbedding) return 'Vector + JSON'
  if (item?.hasVectorEmbedding) return 'Solo vector'
  if (item?.hasJsonEmbedding) return 'Solo JSON'
  return 'Sin embedding'
}

function resolveActionError(error, fallbackMessage) {
  const normalizedMessage = String(error?.message || '').trim()
  return normalizedMessage || fallbackMessage
}

function describeJobActivity(job) {
  const stats = job?.stats || {}
  if (job?.status === 'queued') {
    return 'Esperando turno en la cola.'
  }
  if (job?.status === 'running') {
    if (stats.message) return stats.message
    if (stats.currentUrl) return `Procesando ${stats.currentUrl}`
    return 'Ejecutando spider.'
  }
  if (job?.status === 'failed') {
    return job.errorMessage || 'El spider termino con error.'
  }
  if (job?.status === 'cancelled') {
    return job.errorMessage || 'Job cancelado.'
  }
  if (job?.status === 'completed') {
    return 'Job finalizado.'
  }
  return 'Sin actividad registrada.'
}

function buildDeveloperJobParams(jobId, municipalityId = '') {
  const params = { job: String(jobId) }
  if (municipalityId) params.municipality_id = String(municipalityId)
  return params
}

function getSourceHref(item, type) {
  if (type === 'pages') return item.url || item.canonicalUrl || ''
  if (type === 'assets') return item.url || item.pageUrl || ''
  return item.sourceUrl || ''
}

function getSpiderDisplayState({ spiderConfigured, spiderOnline, spiderOperationsEnabled, spiderHealthStatus }) {
  if (!spiderConfigured) return { label: 'Sin configurar', tone: 'is-off' }
  if (spiderHealthStatus === 'not-configured') return { label: 'URL faltante', tone: 'is-off' }
  if (spiderHealthStatus === 'not-checked') return { label: 'Sin verificar', tone: 'is-off' }
  if (String(spiderHealthStatus || '').startsWith('http-')) return { label: 'Error HTTP', tone: 'is-error' }
  if (!spiderOnline) return { label: 'Offline', tone: 'is-off' }
  if (!spiderOperationsEnabled) return { label: 'Apagado', tone: 'is-off' }
  return { label: 'Listo', tone: 'is-on' }
}

function InfoHint({ title, children, align = 'end' }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const tooltipId = useId()

  useEffect(() => {
    if (!open) return undefined

    const handlePointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false)
      }
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div
      className={`developer-info-hint is-${align}`}
      ref={rootRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="developer-info-button"
        aria-label={title}
        aria-expanded={open}
        aria-describedby={open ? tooltipId : undefined}
        onClick={() => setOpen((current) => !current)}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          if (!rootRef.current?.contains(event.relatedTarget)) {
            setOpen(false)
          }
        }}
      >
        i
      </button>
      {open ? (
        <div className="developer-info-popover" id={tooltipId} role="tooltip">
          <strong>{title}</strong>
          <div className="developer-info-popover-body">{children}</div>
        </div>
      ) : null}
    </div>
  )
}

function DeveloperGate() {
  const { user, openLoginModal } = useAppContext()
  return (
    <section className="admin-ops-login-card panel-login-gate developer-login-card">
      <div className="admin-ops-login-copy">
        <span className="admin-muni-kicker">Desarrollador</span>
        <h2>Panel Desarrollador</h2>
        <p>
          {user
            ? 'Tu usuario no tiene permisos de desarrollador para controlar el asistente, el spider ni la simulación.'
            : 'Iniciá sesión como desarrollador para operar el spider, las seeds y la configuración del asistente.'}
        </p>
      </div>
      {!user && (
        <div className="admin-ops-login-actions">
          <button
            type="button"
            className="admin-muni-primary-button"
            onClick={() => openLoginModal('Usá el acceso rápido de Desarrollador.')}
          >
            Iniciar Sesión
          </button>
        </div>
      )}
    </section>
  )
}

function DeveloperPage() {
  const { user, sessionId: appSessionId, municipality: activeMunicipality } = useAppContext()
  const { navigate, params } = useHashRoute()
  const handleNavigate = makeNavigate(navigate)
  const adminSession = appSessionId ? `app:${appSessionId}` : ''
  const canUsePanel = userHasRole(user, 'desarrollador')
  const routeMunicipalityId = String(params.municipality_id || '').trim()
  const currentView = String(params.view || '').trim()
  const detailJobId = String(params.job || '').trim()
  const isJobDetailView = Boolean(detailJobId)
  const isCitiesView = currentView === 'cities'
  const isEmbeddingsView = currentView === 'embeddings'
  const isOverviewView = !isJobDetailView && !isEmbeddingsView && !isCitiesView

  const [collectionRuntime, setCollectionRuntime] = useState(null)
  const [ragRuntime, setRagRuntime] = useState(null)
  const [municipalities, setMunicipalities] = useState([])
  const [seedUrls, setSeedUrls] = useState([])
  const [sourceHealth, setSourceHealth] = useState([])
  const [jobs, setJobs] = useState([])
  const [jobResults, setJobResults] = useState({
    jobId: '',
    type: 'pages',
    page: 1,
    pageSize: 12,
    status: 'idle',
    data: null,
    error: '',
  })
  const [ragCatalog, setRagCatalog] = useState([])
  const [municipalBarrios, setMunicipalBarrios] = useState([])
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogVisibility, setCatalogVisibility] = useState('all')
  const [embeddingDetails, setEmbeddingDetails] = useState({ summary: null, result: null, chunks: [] })
  const [embeddingQuery, setEmbeddingQuery] = useState('')
  const [embeddingStateFilter, setEmbeddingStateFilter] = useState('all')
  const [embeddingPage, setEmbeddingPage] = useState(1)
  const [selectedMunicipalityId, setSelectedMunicipalityId] = useState('')
  const [municipalitySearch, setMunicipalitySearch] = useState('')
  const [municipalitySeedFilter, setMunicipalitySeedFilter] = useState('all')
  const [municipalityCreateForm, setMunicipalityCreateForm] = useState(() => createMunicipalityForm())
  const [domainForm, setDomainForm] = useState({ primaryDomain: '' })
  const [seedForm, setSeedForm] = useState(() => createSeedForm(''))
  const [geoImportForm, setGeoImportForm] = useState(() => createGeoImportForm())
  const [geoImportInputKey, setGeoImportInputKey] = useState(0)
  const [barrioQuery, setBarrioQuery] = useState('')
  const [barrioForm, setBarrioForm] = useState(() => createBarrioForm())
  const [editingBarrioId, setEditingBarrioId] = useState('')
  const [status, setStatus] = useState('idle')
  const [message, setMessage] = useState('')
  const [isErrorToastDismissed, setIsErrorToastDismissed] = useState(false)
  const [notifToast, setNotifToast] = useState(null)
  const [notifToastDismissed, setNotifToastDismissed] = useState(false)
  const [ragRuntimeDraft, setRagRuntimeDraft] = useState(() => createRagRuntimeDraft())
  const [ragRuntimeDraftDirty, setRagRuntimeDraftDirty] = useState(false)

  const simulationEnabled = collectionRuntime?.simulationEnabled === true
  const publicIndexEnabled = ragRuntime?.publicIndexEnabled === true
  const openAIRuntimeDisabled = ragRuntime?.openAIEnabled === false
  const spiderConfigured = ragRuntime?.spiderEnabled === true
  const spiderOnline = ragRuntime?.spiderHealth?.ok === true
  const spiderOperationsEnabled = ragRuntime?.spiderOperationsEnabled === true
  const spiderHealthStatus = String(ragRuntime?.spiderHealth?.status || '').trim()
  const spiderReadyForJobs = spiderConfigured && spiderOnline && spiderOperationsEnabled
  const isBusy = ['loading', 'saving'].includes(status)
  const runtimeChunkLimitMax = useMemo(() => {
    const count = Number(ragRuntime?.counts?.chunks)
    if (!Number.isFinite(count) || count < 1) return null
    return Math.trunc(count)
  }, [ragRuntime?.counts?.chunks])
  const runtimeChunkLimitStatus = useMemo(() => {
    if (!ragRuntime) return 'Esperando el conteo real de chunks del backend para habilitar este campo.'
    if (runtimeChunkLimitMax === null) return 'Sin conteo utilizable de chunks en backend todavía. No se puede cambiar este valor.'
    return `Máximo actual según backend: ${runtimeChunkLimitMax} chunks.`
  }, [ragRuntime, runtimeChunkLimitMax])
  const spiderActivity = ragRuntime?.spiderHealth?.payload?.activeJobDetails || []
  const showErrorToast = status === 'error' && Boolean(message) && !isErrorToastDismissed
  const showNotifToast = Boolean(notifToast) && !notifToastDismissed
  const spiderDisplayState = getSpiderDisplayState({
    spiderConfigured,
    spiderOnline,
    spiderOperationsEnabled,
    spiderHealthStatus,
  })

  const currentMunicipality = useMemo(
    () => municipalities.find((municipality) => String(municipality.id) === String(selectedMunicipalityId)) || municipalities[0] || null,
    [municipalities, selectedMunicipalityId],
  )
  const topbarMunicipality = useMemo(
    () => municipalities.find((municipality) => municipality.slug === activeMunicipality?.key) || null,
    [activeMunicipality?.key, municipalities],
  )
  const selectedJob = useMemo(
    () => jobs.find((job) => String(job.id) === String(jobResults.jobId || detailJobId)) || jobResults.data?.job || null,
    [detailJobId, jobs, jobResults.data, jobResults.jobId],
  )

  const sourceHealthById = useMemo(
    () => new Map(sourceHealth.map((source) => [String(source.id), source])),
    [sourceHealth],
  )

  const municipalityStats = useMemo(() => {
    const withSeeds = municipalities.filter((municipality) => Number(municipality.seedCount || 0) > 0).length
    const withGeo = municipalities.filter((municipality) => Number(municipality.barrioCount || 0) > 0).length
    return {
      total: municipalities.length,
      withSeeds,
      withGeo,
      withoutSeeds: municipalities.length - withSeeds,
    }
  }, [municipalities])

  const currentMunicipalityCoverage = useMemo(() => {
    if (!currentMunicipality) return null
    return {
      barrioCount: Number(currentMunicipality.barrioCount || 0),
      seedCount: Number(currentMunicipality.seedCount || 0),
      itemCount: Number(currentMunicipality.itemCount || 0),
      visibleItemCount: Number(currentMunicipality.visibleItemCount || 0),
      chunkCount: Number(currentMunicipality.chunkCount || 0),
      embeddedChunkCount: Number(currentMunicipality.embeddedChunkCount || 0),
      spiderItemCount: Number(currentMunicipality.spiderItemCount || 0),
      spiderVisibleItemCount: Number(currentMunicipality.spiderVisibleItemCount || 0),
      spiderChunkCount: Number(currentMunicipality.spiderChunkCount || 0),
      spiderEmbeddedChunkCount: Number(currentMunicipality.spiderEmbeddedChunkCount || 0),
    }
  }, [currentMunicipality])
  const effectiveMunicipalityBarrioCount = municipalBarrios.length || Number(currentMunicipalityCoverage?.barrioCount || 0)

  const visibleMunicipalBarrios = useMemo(() => {
    const query = barrioQuery.trim().toLowerCase()
    if (!query) return municipalBarrios
    return municipalBarrios.filter((barrio) =>
      `${barrio.barrioLabel} ${barrio.barrioSlug} ${barrio.barrioCode} ${barrio.sourceName}`.toLowerCase().includes(query),
    )
  }, [barrioQuery, municipalBarrios])

  const barriosWithGeometryCount = useMemo(
    () => municipalBarrios.filter((barrio) => barrio.hasGeometry).length,
    [municipalBarrios],
  )

  const visibleMunicipalities = useMemo(() => {
    const query = municipalitySearch.trim().toLowerCase()
    const filteredMunicipalities = municipalities
      .filter((municipality) => {
        const seedCount = Number(municipality.seedCount || 0)
        if (municipalitySeedFilter === 'with-seeds' && seedCount === 0) return false
        if (municipalitySeedFilter === 'without-seeds' && seedCount > 0) return false
        if (!query) return true
        return `${municipality.name} ${municipality.department}`.toLowerCase().includes(query)
      })
    if (query) return filteredMunicipalities.slice(0, 120)
    return limitMunicipalityPreview(filteredMunicipalities, selectedMunicipalityId)
  }, [municipalities, municipalitySearch, municipalitySeedFilter, selectedMunicipalityId])

  useEffect(() => {
    if (!currentMunicipality) return
    const nextDomain = currentMunicipality.primaryDomain || ''
    setDomainForm({ primaryDomain: nextDomain })
    setSeedForm(createSeedForm(domainToSeedUrl(nextDomain)))
  }, [currentMunicipality?.id])

  useEffect(() => {
    if (!currentMunicipality || editingBarrioId) return
    setBarrioForm(createBarrioForm(null, currentMunicipality))
  }, [currentMunicipality?.centerLat, currentMunicipality?.centerLon, currentMunicipality?.id, editingBarrioId])

  useEffect(() => {
    if (status === 'error' && message) {
      setIsErrorToastDismissed(false)
    }
  }, [status, message])

  useEffect(() => {
    if (status === 'ready' && message) {
      const type = message === 'Panel Desarrollador actualizado.' ? 'info' : 'success'
      setNotifToast({ type, message })
      setNotifToastDismissed(false)
    }
  }, [status, message])

  useEffect(() => {
    if (!notifToast || notifToastDismissed) return undefined
    const timer = window.setTimeout(() => setNotifToastDismissed(true), 3500)
    return () => window.clearTimeout(timer)
  }, [notifToast, notifToastDismissed])

  useEffect(() => {
    if (!canUsePanel || !adminSession) return undefined
    let cancelled = false

    async function loadState() {
      setStatus('loading')
      try {
        const [nextCollectionRuntime, nextRagRuntime, nextMunicipalities] = await Promise.all([
          fetchCollectionRuntimeSession(adminSession),
          fetchRagAdminRuntime(adminSession),
          fetchRagMunicipalities(adminSession),
        ])
        if (cancelled) return
        setCollectionRuntime(nextCollectionRuntime)
        setRagRuntime(nextRagRuntime)
        setRagRuntimeDraft(createRagRuntimeDraft(nextRagRuntime))
        setRagRuntimeDraftDirty(false)
        setMunicipalities(nextMunicipalities)
        const asuncion = nextMunicipalities.find((municipality) => municipality.slug === 'asuncion')
        const activeTopbarMunicipality = nextMunicipalities.find((municipality) => municipality.slug === activeMunicipality?.key)
        const nextMunicipalityId = routeMunicipalityId || selectedMunicipalityId || activeTopbarMunicipality?.id || asuncion?.id || nextMunicipalities[0]?.id || ''
        setSelectedMunicipalityId(nextMunicipalityId ? String(nextMunicipalityId) : '')
        if (nextMunicipalityId) {
          const [nextSeeds, nextJobs, nextSourceHealth] = await Promise.all([
            fetchRagSeedUrls(adminSession, { municipalityId: nextMunicipalityId }),
            fetchRagCrawlJobs(adminSession, { municipalityId: nextMunicipalityId }),
            fetchRagSourceHealth(adminSession, { municipalityId: nextMunicipalityId }),
          ])
          if (cancelled) return
          setSeedUrls(nextSeeds)
          setJobs(nextJobs)
          setSourceHealth(nextSourceHealth)
          const nextCatalog = await fetchRagAdminCatalog(adminSession, {
            municipalityId: nextMunicipalityId,
            visibility: catalogVisibility,
            query: catalogQuery,
            limit: 18,
          })
          if (cancelled) return
          setRagCatalog(nextCatalog)
        }
        if (detailJobId) {
          const data = await fetchRagCrawlJobResults(adminSession, detailJobId, { type: 'pages', page: 1, pageSize: 12 })
          if (cancelled) return
          setJobResults({
            jobId: String(detailJobId),
            type: data.result.type,
            page: data.result.page,
            pageSize: data.result.pageSize,
            status: 'ready',
            data,
            error: '',
          })
        } else {
          setJobResults({ jobId: '', type: 'pages', page: 1, pageSize: 12, status: 'idle', data: null, error: '' })
        }
        setStatus('ready')
        setMessage('Panel Desarrollador actualizado.')
      } catch (_error) {
        if (cancelled) return
        setStatus('error')
        setMessage('No se pudo cargar el panel de desarrollador.')
      }
    }

    void loadState()
    return () => {
      cancelled = true
    }
  }, [activeMunicipality?.key, adminSession, canUsePanel, detailJobId, routeMunicipalityId])

  async function refreshRagState(municipalityId = selectedMunicipalityId) {
    if (!adminSession) return
    const [nextRuntime, nextMunicipalities, nextSeeds, nextJobs, nextSourceHealth, nextCatalog] = await Promise.all([
      fetchRagAdminRuntime(adminSession),
      fetchRagMunicipalities(adminSession),
      municipalityId ? fetchRagSeedUrls(adminSession, { municipalityId }) : Promise.resolve([]),
      municipalityId ? fetchRagCrawlJobs(adminSession, { municipalityId }) : Promise.resolve([]),
      municipalityId ? fetchRagSourceHealth(adminSession, { municipalityId }) : Promise.resolve([]),
      municipalityId ? fetchRagAdminCatalog(adminSession, { municipalityId, visibility: catalogVisibility, query: catalogQuery, limit: 18 }) : Promise.resolve([]),
    ])
    setRagRuntime(nextRuntime)
    if (!ragRuntimeDraftDirty) {
      setRagRuntimeDraft(createRagRuntimeDraft(nextRuntime))
    }
    setMunicipalities(nextMunicipalities)
    setSeedUrls(nextSeeds)
    setJobs(nextJobs)
    setSourceHealth(nextSourceHealth)
    setRagCatalog(nextCatalog)
  }

  async function refreshEmbeddingDetails(municipalityId = currentMunicipality?.id || selectedMunicipalityId) {
    if (!adminSession || !municipalityId) {
      setEmbeddingDetails({ summary: null, result: null, chunks: [] })
      return
    }
    const nextDetails = await fetchRagEmbeddingDetails(adminSession, {
      municipalityId,
      query: embeddingQuery,
      state: embeddingStateFilter,
      page: embeddingPage,
      pageSize: 20,
    })
    setEmbeddingDetails(nextDetails)
  }

  async function refreshMunicipalBarrios(municipalityId = currentMunicipality?.id || selectedMunicipalityId) {
    if (!adminSession || !municipalityId) {
      setMunicipalBarrios([])
      return
    }
    const nextBarrios = await fetchMunicipalBarrios(adminSession, municipalityId)
    setMunicipalBarrios(nextBarrios)
    return nextBarrios
  }

  useEffect(() => {
    if (!canUsePanel || !adminSession || !currentMunicipality?.id) return undefined
    let cancelled = false

    async function loadCatalog() {
      try {
        const nextCatalog = await fetchRagAdminCatalog(adminSession, {
          municipalityId: currentMunicipality.id,
          visibility: catalogVisibility,
          query: catalogQuery,
          limit: 18,
        })
        if (!cancelled) {
          setRagCatalog(nextCatalog)
        }
      } catch {
        if (!cancelled) {
          setRagCatalog([])
        }
      }
    }

    void loadCatalog()
    return () => {
      cancelled = true
    }
  }, [adminSession, canUsePanel, catalogQuery, catalogVisibility, currentMunicipality?.id])

  useEffect(() => {
    if (!canUsePanel || !adminSession || !currentMunicipality?.id || !isEmbeddingsView) return undefined
    let cancelled = false

    async function loadEmbeddingState() {
      try {
        const nextDetails = await fetchRagEmbeddingDetails(adminSession, {
          municipalityId: currentMunicipality.id,
          query: embeddingQuery,
          state: embeddingStateFilter,
          page: embeddingPage,
          pageSize: 20,
        })
        if (!cancelled) {
          setEmbeddingDetails(nextDetails)
        }
      } catch {
        if (!cancelled) {
          setEmbeddingDetails({ summary: null, result: null, chunks: [] })
        }
      }
    }

    void loadEmbeddingState()
    return () => {
      cancelled = true
    }
  }, [adminSession, canUsePanel, currentMunicipality?.id, embeddingPage, embeddingQuery, embeddingStateFilter, isEmbeddingsView])

  useEffect(() => {
    if (!canUsePanel || !adminSession || !currentMunicipality?.id || !isCitiesView) return undefined
    let cancelled = false

    async function loadMunicipalBarriosState() {
      try {
        const nextBarrios = await fetchMunicipalBarrios(adminSession, currentMunicipality.id)
        if (!cancelled) {
          setMunicipalBarrios(nextBarrios)
          if (Number(currentMunicipalityCoverage?.barrioCount || 0) !== Number(nextBarrios.length || 0)) {
            void refreshRagState(currentMunicipality.id)
          }
        }
      } catch (error) {
        if (!cancelled) {
          setMunicipalBarrios([])
          setStatus('error')
          setMessage(resolveActionError(error, 'No se pudieron cargar los barrios de esta municipalidad.'))
        }
      }
    }

    void loadMunicipalBarriosState()
    return () => {
      cancelled = true
    }
  }, [adminSession, canUsePanel, currentMunicipality?.id, currentMunicipalityCoverage?.barrioCount, isCitiesView])

  useEffect(() => {
    if (!canUsePanel || !adminSession || !currentMunicipality) return undefined
    const intervalId = window.setInterval(() => {
      void refreshRagState(currentMunicipality.id)
      if (isEmbeddingsView) {
        void refreshEmbeddingDetails(currentMunicipality.id)
      }
      if (jobResults.jobId) {
        void loadJobResults(
          jobResults.jobId,
          { type: jobResults.type, page: jobResults.page, pageSize: jobResults.pageSize },
          { silent: true },
        )
      }
    }, 5000)
    return () => window.clearInterval(intervalId)
  }, [adminSession, canUsePanel, currentMunicipality?.id, embeddingPage, embeddingQuery, embeddingStateFilter, isEmbeddingsView, jobResults.jobId, jobResults.page, jobResults.pageSize, jobResults.type, ragRuntimeDraftDirty])

  useEffect(() => {
    setEmbeddingPage(1)
  }, [embeddingQuery, embeddingStateFilter, currentMunicipality?.id])

  async function loadJobResults(jobId, overrides = {}, options = {}) {
    if (!adminSession || !jobId) return
    const { silent = false } = options
    const nextType = overrides.type || jobResults.type || 'pages'
    const nextPage = overrides.page || jobResults.page || 1
    const nextPageSize = overrides.pageSize || jobResults.pageSize || 12
    if (!silent) {
      setJobResults((current) => ({
        ...current,
        jobId: String(jobId),
        type: nextType,
        page: nextPage,
        pageSize: nextPageSize,
        status: 'loading',
        error: '',
      }))
    }
    try {
      const data = await fetchRagCrawlJobResults(adminSession, jobId, {
        type: nextType,
        page: nextPage,
        pageSize: nextPageSize,
      })
      setJobResults({
        jobId: String(jobId),
        type: data.result.type,
        page: data.result.page,
        pageSize: data.result.pageSize,
        status: 'ready',
        data,
        error: '',
      })
    } catch (_error) {
      setJobResults((current) => ({
        ...current,
        status: 'error',
        error: 'No se pudieron cargar los resultados del job.',
      }))
    }
  }

  async function handleSelectMunicipality(municipalityId) {
    navigate('/desarrollador', {
      params: {
        municipality_id: municipalityId,
        ...(isCitiesView ? { view: 'cities' } : {}),
        ...(isEmbeddingsView ? { view: 'embeddings' } : {}),
      },
    })
    setSelectedMunicipalityId(String(municipalityId))
    setJobResults({ jobId: '', type: 'pages', page: 1, pageSize: 12, status: 'idle', data: null, error: '' })
    setStatus('loading')
    try {
      await refreshRagState(municipalityId)
      if (isEmbeddingsView) {
        await refreshEmbeddingDetails(municipalityId)
      }
      if (isCitiesView) {
        await refreshMunicipalBarrios(municipalityId)
      }
      setEditingBarrioId('')
      setStatus('ready')
    } catch (_error) {
      setStatus('error')
      setMessage('No se pudo cargar esa municipalidad.')
    }
  }

  function handleViewJobResults(job) {
    navigate('/desarrollador', {
      params: buildDeveloperJobParams(job.id, currentMunicipality?.id || job.municipalityId),
    })
    void loadJobResults(job.id, { type: 'pages', page: 1, pageSize: 12 })
  }

  function handleBackToDeveloperPanel() {
    navigate('/desarrollador', {
      params: currentMunicipality?.id ? { municipality_id: currentMunicipality.id } : undefined,
    })
  }

  function handleOpenEmbeddingsView() {
    navigate('/desarrollador', {
      params: {
        ...(currentMunicipality?.id ? { municipality_id: currentMunicipality.id } : {}),
        view: 'embeddings',
      },
    })
  }

  function handleBackFromEmbeddingsView() {
    navigate('/desarrollador', {
      params: currentMunicipality?.id ? { municipality_id: currentMunicipality.id } : undefined,
    })
  }

  function handleOpenCitiesView() {
    navigate('/desarrollador', {
      params: {
        ...((currentMunicipality?.id || topbarMunicipality?.id) ? { municipality_id: currentMunicipality?.id || topbarMunicipality?.id } : {}),
        view: 'cities',
      },
    })
  }

  function handleBackFromCitiesView() {
    navigate('/desarrollador', {
      params: currentMunicipality?.id ? { municipality_id: currentMunicipality.id } : undefined,
    })
  }

  function handleChangeEmbeddingPage(direction) {
    const currentPage = embeddingDetails.result?.page || embeddingPage || 1
    const totalPages = embeddingDetails.result?.totalPages || 1
    const nextPage = direction === 'next'
      ? Math.min(totalPages, currentPage + 1)
      : Math.max(1, currentPage - 1)
    if (nextPage === currentPage) return
    setEmbeddingPage(nextPage)
  }

  function handleChangeJobResultType(type) {
    if (!jobResults.jobId) return
    void loadJobResults(jobResults.jobId, { type, page: 1 })
  }

  function handleChangeJobResultPage(direction) {
    const currentPage = jobResults.data?.result?.page || jobResults.page || 1
    const totalPages = jobResults.data?.result?.totalPages || 1
    const nextPage = direction === 'next'
      ? Math.min(totalPages, currentPage + 1)
      : Math.max(1, currentPage - 1)
    if (nextPage === currentPage || !jobResults.jobId) return
    void loadJobResults(jobResults.jobId, { page: nextPage })
  }

  async function handleToggleCollection() {
    setStatus('saving')
    setMessage('')
    try {
      const nextRuntime = await updateCollectionRuntimeSession({
        adminSession,
        simulationEnabled: !simulationEnabled,
        updatedBy: user.email || 'desarrollador',
      })
      setCollectionRuntime(nextRuntime)
      setStatus('ready')
      setMessage(nextRuntime.simulationEnabled ? 'Simulacion encendida.' : 'Simulacion apagada.')
    } catch (_error) {
      setStatus('error')
      setMessage('No se pudo guardar el cambio de simulación.')
    }
  }

  function handleOpenRecolectorPanel() {
    navigate('/recolector')
  }

  async function handleToggleSpider() {
    if (!spiderOperationsEnabled) {
      const confirmed = window.confirm(
        'Prender el spider habilita las ejecuciones manuales del crawler de fuentes. Mientras esté prendido, el panel consulta más seguido el estado interno y la página puede sentirse un poco más lenta.\n\nEl spider prendido no corre solo: simplemente queda listo para que los jobs manuales puedan navegar seeds, descargar archivos y registrar páginas, assets e ítems indexados.\n\n¿Querés prenderlo ahora?',
      )
      if (!confirmed) return
    }
    setStatus('saving')
    setMessage('')
    try {
      const nextRuntime = await updateRagAdminRuntime({
        adminSession,
        spiderOperationsEnabled: !spiderOperationsEnabled,
      })
      setRagRuntime(nextRuntime)
      await refreshRagState(currentMunicipality?.id || selectedMunicipalityId)
      setStatus('ready')
      setMessage(nextRuntime.spiderOperationsEnabled ? 'Spider prendido para ejecuciones manuales.' : 'Spider apagado.')
    } catch (_error) {
      setStatus('error')
      setMessage('No se pudo cambiar el estado operativo del spider.')
    }
  }

  async function handleTogglePublicIndex() {
    setStatus('saving')
    setMessage('')
    try {
      const nextRuntime = await updateRagAdminRuntime({
        adminSession,
        publicIndexEnabled: !publicIndexEnabled,
      })
      setRagRuntime(nextRuntime)
      setStatus('ready')
      setMessage(nextRuntime.publicIndexEnabled ? 'Índice de Munita habilitado.' : 'Índice de Munita deshabilitado.')
    } catch (_error) {
      setStatus('error')
      setMessage('No se pudo cambiar la configuración del asistente.')
    }
  }

  async function handleSaveAssistantRuntime(event) {
    event.preventDefault()
    setStatus('saving')
    setMessage('')
    try {
      const runtimeUpdatePayload = {
        adminSession,
        assistantUseEmbeddings: ragRuntimeDraft.assistantUseEmbeddings,
        assistantMinRelevanceScore: Number(ragRuntimeDraft.assistantMinRelevanceScore || 5),
        assistantStrictMunicipalityScope: ragRuntimeDraft.assistantStrictMunicipalityScope,
      }
      if (runtimeChunkLimitMax !== null) {
        runtimeUpdatePayload.assistantChunkLimit = Number(ragRuntimeDraft.assistantChunkLimit || 10)
      }
      const nextRuntime = await updateRagAdminRuntime(runtimeUpdatePayload)
      setRagRuntime(nextRuntime)
      setRagRuntimeDraft(createRagRuntimeDraft(nextRuntime))
      setRagRuntimeDraftDirty(false)
      setStatus('ready')
      setMessage('Configuración del asistente guardada.')
    } catch (error) {
      setStatus('error')
      setMessage(resolveActionError(error, 'No se pudo guardar la configuración del asistente.'))
    }
  }

  async function handleSaveDomain(event) {
    event.preventDefault()
    if (!currentMunicipality) return
    setStatus('saving')
    setMessage('')
    try {
      const municipality = await updateRagMunicipality(adminSession, currentMunicipality.id, {
        slug: currentMunicipality.slug,
        name: currentMunicipality.name,
        department: currentMunicipality.department,
        ineCode: currentMunicipality.ineCode,
        primaryDomain: domainForm.primaryDomain,
        active: currentMunicipality.active,
      })
      const nextUrl = domainToSeedUrl(municipality.primaryDomain)
      setSeedForm(createSeedForm(nextUrl))
      await refreshRagState(municipality.id)
      setStatus('ready')
      setMessage('Dominio municipal guardado.')
    } catch (_error) {
      setStatus('error')
      setMessage('No se pudo guardar el dominio municipal.')
    }
  }

  async function handleCreateSeed(event) {
    event.preventDefault()
    if (!currentMunicipality) return
    setStatus('saving')
    setMessage('')
    try {
      await createRagSeedUrl(adminSession, {
        ...seedForm,
        municipalityId: currentMunicipality.id,
      })
      await refreshRagState(currentMunicipality.id)
      setSeedForm(createSeedForm(domainToSeedUrl(currentMunicipality.primaryDomain || domainForm.primaryDomain)))
      setStatus('ready')
      setMessage('URL semilla guardada para la municipalidad seleccionada.')
    } catch (_error) {
      setStatus('error')
      setMessage('No se pudo guardar la URL semilla.')
    }
  }

  async function handleStartCrawl(seedId) {
    if (!currentMunicipality) return
    if (!spiderReadyForJobs) {
      setStatus('error')
      setMessage('Prende el spider y verifica que este online antes de ejecutar.')
      return
    }
    setStatus('saving')
    setMessage('')
    try {
      const job = await createRagCrawlJob(adminSession, {
        municipalityId: currentMunicipality.id,
        seedUrlIds: [seedId],
      })
      await refreshRagState(currentMunicipality.id)
      setStatus(job.status === 'failed' ? 'error' : 'ready')
      setMessage(job.errorCode ? `Job creado con estado ${job.errorCode}.` : 'Crawl manual enviado a ejecución para esa seed.')
    } catch (_error) {
      setStatus('error')
      setMessage('No se pudo agregar la seed a la cola.')
    }
  }

  async function handleCheckSeed(seedId) {
    if (!currentMunicipality) return
    setStatus('saving')
    setMessage('')
    try {
      const seedUrl = await checkRagSeedUrl(adminSession, seedId)
      await refreshRagState(currentMunicipality.id)
      setStatus(seedUrl.changeStatus === 'error' ? 'error' : 'ready')
      setMessage(`Revisión rápida de la fuente: ${formatStatus(seedUrl.changeStatus)}.`)
    } catch (_error) {
      setStatus('error')
      setMessage('No se pudo revisar la fuente.')
    }
  }

  async function handleCancelJob(jobId) {
    if (!currentMunicipality) return
    setStatus('saving')
    setMessage('')
    try {
      await cancelRagCrawlJob(adminSession, jobId)
      await refreshRagState(currentMunicipality.id)
      setStatus('ready')
      setMessage('Job cancelado.')
    } catch (_error) {
      setStatus('error')
      setMessage('No se pudo cancelar el job.')
    }
  }

  async function handleDeleteSeed(seed) {
    if (!currentMunicipality) return
    const confirmed = window.confirm(
      `Vas a borrar la seed ${seed.url}.\n\nTambién se limpiarán sus páginas, assets e ítems indexados asociados cuando correspondan.\n\n¿Querés borrarla de verdad?`,
    )
    if (!confirmed) return

    setStatus('saving')
    setMessage('')
    try {
      await deleteRagSeedUrl(adminSession, seed.id)
      await refreshRagState(currentMunicipality.id)
      setStatus('ready')
      setMessage('Seed borrada con su limpieza asociada.')
    } catch (error) {
      setStatus('error')
      setMessage(error.message || 'No se pudo borrar la seed.')
    }
  }

  async function handleDeleteJob(job) {
    const confirmed = window.confirm(
      `Vas a borrar el job #${job.id}.\n\nSe eliminarán también sus páginas, assets, ítems indexados y archivos asociados del spider.\n\n¿Querés borrarlo de verdad?`,
    )
    if (!confirmed) return

    setStatus('saving')
    setMessage('')
    try {
      await deleteRagCrawlJob(adminSession, job.id)
      await refreshRagState(currentMunicipality?.id || selectedMunicipalityId)
      if (String(detailJobId) === String(job.id) || String(jobResults.jobId) === String(job.id)) {
        setJobResults({ jobId: '', type: 'pages', page: 1, pageSize: 12, status: 'idle', data: null, error: '' })
        navigate('/desarrollador', {
          params: currentMunicipality?.id ? { municipality_id: currentMunicipality.id } : undefined,
        })
      }
      setStatus('ready')
      setMessage('Job borrado con sus archivos asociados.')
    } catch (error) {
      setStatus('error')
      setMessage(error.message || 'No se pudo borrar el job.')
    }
  }

  async function handleReloadIndex() {
    setStatus('saving')
    setMessage('')
    try {
      const result = await reloadRagAdminIndex(adminSession)
      await refreshRagState(currentMunicipality?.id || selectedMunicipalityId)
      if (currentMunicipality?.id) {
        await refreshEmbeddingDetails(currentMunicipality.id)
      }
      setStatus('ready')
      setMessage(`Reconstrucción manual lista: ${result.rebuild?.chunks || 0} chunks conectados quedaron recargados en Munita.`)
    } catch (_error) {
      setStatus('error')
      setMessage('No se pudo reconstruir manualmente el índice conectado de Munita.')
    }
  }

  async function handleBootstrapMunicipality() {
    if (!currentMunicipality) return

    setStatus('saving')
    setMessage('')
    try {
      const result = await bootstrapRagMunicipalityGeography(adminSession, currentMunicipality.id)
      await refreshRagState(currentMunicipality.id)
      await refreshMunicipalBarrios(currentMunicipality.id)
      setStatus('ready')
      setMessage(
        `${result.municipalityName || currentMunicipality.name}: ${result.barrioCount || 0} barrios oficiales cargados para Baches y geolocalización.`,
      )
    } catch (error) {
      setStatus('error')
      setMessage(resolveActionError(error, 'No se pudieron cargar los barrios oficiales de esta municipalidad.'))
    }
  }

  async function handleImportMunicipalityFile(event) {
    event.preventDefault()
    if (!currentMunicipality) return
    if (!geoImportForm.file) {
      setStatus('error')
      setMessage('Seleccioná un archivo GeoJSON, JSON o CSV antes de importar.')
      return
    }

    setStatus('saving')
    setMessage('')
    try {
      const result = await importRagMunicipalityBarrios(adminSession, currentMunicipality.id, geoImportForm)
      await refreshRagState(currentMunicipality.id)
      await refreshMunicipalBarrios(currentMunicipality.id)
      setGeoImportForm(createGeoImportForm())
      setGeoImportInputKey((current) => current + 1)
      setStatus('ready')
      setMessage(
        `${result.municipalityName || currentMunicipality.name}: ${result.barrioCount || 0} barrios importados (${result.geometryCount || 0} con polígono para click directo).`,
      )
    } catch (error) {
      setStatus('error')
      setMessage(resolveActionError(error, 'No se pudo importar el archivo de barrios para esta municipalidad.'))
    }
  }

  async function handleCreateMunicipality(event) {
    event.preventDefault()
    setStatus('saving')
    setMessage('')
    try {
      const municipality = await createRagMunicipality(adminSession, municipalityCreateForm)
      setMunicipalityCreateForm(createMunicipalityForm())
      await refreshRagState(municipality.id)
      await handleSelectMunicipality(municipality.id)
      setStatus('ready')
      setMessage(`${municipality.name} quedó agregada al catálogo municipal del panel.`)
    } catch (error) {
      setStatus('error')
      setMessage(resolveActionError(error, 'No se pudo agregar la municipalidad al catálogo.'))
    }
  }

  async function handleToggleMunicipalityVisibility() {
    if (!currentMunicipality) return
    setStatus('saving')
    setMessage('')
    try {
      const municipality = await updateRagMunicipality(adminSession, currentMunicipality.id, {
        slug: currentMunicipality.slug,
        name: currentMunicipality.name,
        department: currentMunicipality.department,
        ineCode: currentMunicipality.ineCode,
        primaryDomain: currentMunicipality.primaryDomain,
        active: !currentMunicipality.active,
      })
      await refreshRagState(municipality.id)
      if (isCitiesView) {
        await refreshMunicipalBarrios(municipality.id)
      }
      setStatus('ready')
      setMessage(
        municipality.active
          ? 'Municipalidad marcada como visible para el selector superior cuando tenga barrios o seeds.'
          : 'Municipalidad ocultada del selector superior.',
      )
    } catch (error) {
      setStatus('error')
      setMessage(resolveActionError(error, 'No se pudo cambiar la visibilidad de esta municipalidad en el selector.'))
    }
  }

  function handleStartCreateBarrio() {
    if (!currentMunicipality) return
    setEditingBarrioId('new')
    setBarrioForm(createBarrioForm(null, currentMunicipality))
  }

  function handleStartEditBarrio(barrio) {
    setEditingBarrioId(String(barrio.id))
    setBarrioForm(createBarrioForm(barrio))
  }

  function handleCancelBarrioEdition() {
    setEditingBarrioId('')
    setBarrioForm(createBarrioForm(null, currentMunicipality))
  }

  async function handleSubmitBarrioForm(event) {
    event.preventDefault()
    if (!currentMunicipality) return

    setStatus('saving')
    setMessage('')
    try {
      const payload = {
        barrioLabel: barrioForm.barrioLabel,
        barrioCode: barrioForm.barrioCode,
        centerLat: Number(barrioForm.centerLat),
        centerLon: Number(barrioForm.centerLon),
      }

      if (editingBarrioId && editingBarrioId !== 'new') {
        await updateMunicipalBarrioRequest(adminSession, currentMunicipality.id, editingBarrioId, payload)
      } else {
        await createMunicipalBarrioRequest(adminSession, currentMunicipality.id, payload)
      }

      await refreshRagState(currentMunicipality.id)
      await refreshMunicipalBarrios(currentMunicipality.id)
      setEditingBarrioId('')
      setBarrioForm(createBarrioForm(null, currentMunicipality))
      setStatus('ready')
      setMessage(
        editingBarrioId && editingBarrioId !== 'new'
          ? 'Barrio actualizado manualmente. Revisá siempre que el centro siga representando bien a la ciudad.'
          : 'Barrio agregado manualmente. Este camino queda disponible, pero la importación oficial sigue siendo la recomendada.',
      )
    } catch (error) {
      setStatus('error')
      setMessage(resolveActionError(error, 'No se pudo guardar el barrio manual.'))
    }
  }

  async function handleRebuildEmbeddings() {
    if (openAIRuntimeDisabled) {
      setStatus('error')
      setMessage('OpenAI está deshabilitado en el runtime del servidor. Activá OPENAI_ENABLED y verificá OPENAI_API_KEY para regenerar embeddings.')
      return
    }
    setStatus('saving')
    setMessage('')
    try {
      const result = await rebuildRagEmbeddings(adminSession, { onlyMissing: false })
      await refreshRagState(currentMunicipality?.id || selectedMunicipalityId)
      if (currentMunicipality?.id) {
        await refreshEmbeddingDetails(currentMunicipality.id)
      }
      setStatus(result.ok ? 'ready' : 'error')
      setMessage(result.ok
        ? `Embeddings reindexados: ${result.rebuild?.updated || 0} chunks.`
        : 'OpenAI está deshabilitado; queda activa la búsqueda textual.')
    } catch (_error) {
      setStatus('error')
      setMessage('No se pudieron reindexar los embeddings.')
    }
  }

  async function handleClearEmbeddings() {
    if (!currentMunicipality) return
    const confirmed = window.confirm(
      `Vas a borrar los embeddings conectados de ${currentMunicipality.name}.\n\nMunita seguirá funcionando con búsqueda lexical, pero la capa semántica quedará vacía hasta regenerarlos.\n\n¿Querés continuar?`,
    )
    if (!confirmed) return

    setStatus('saving')
    setMessage('')
    try {
      const result = await clearRagEmbeddings(adminSession, {
        municipalityId: currentMunicipality.id,
        connectedOnly: true,
      })
      await refreshRagState(currentMunicipality.id)
      await refreshEmbeddingDetails(currentMunicipality.id)
      setStatus('ready')
      setMessage(`Embeddings borrados: ${result.result?.cleared || 0} chunks conectados en ${currentMunicipality.name}.`)
    } catch (error) {
      setStatus('error')
      setMessage(resolveActionError(error, 'No se pudieron borrar los embeddings conectados.'))
    }
  }

  async function handleSetCatalogVisibility(item, visible) {
    setStatus('saving')
    setMessage('')
    try {
      await updateRagInfoPublication({
        adminSession,
        itemId: item.id,
        visible,
      })
      await reloadRagAdminIndex(adminSession)
      await refreshRagState(currentMunicipality?.id || selectedMunicipalityId)
      if (currentMunicipality?.id) {
        await refreshEmbeddingDetails(currentMunicipality.id)
      }
      setStatus('ready')
      setMessage(
        visible
          ? `Fuente conectada a Munita. El índice se reconstruyó automáticamente: ${shortText(item.title, 80)}.`
          : `Fuente desconectada de Munita. El índice se reconstruyó automáticamente: ${shortText(item.title, 80)}.`,
      )
    } catch (error) {
      setStatus('error')
      setMessage(resolveActionError(error, 'No se pudo actualizar la conexion de esta fuente con Munita.'))
    }
  }

  async function handleBulkCatalogVisibility(visible) {
    if (!currentMunicipality) return
    setStatus('saving')
    setMessage('')
    try {
      const result = await bulkUpdateRagInfoPublication({
        adminSession,
        municipalityId: currentMunicipality.id,
        visible,
      })
      await reloadRagAdminIndex(adminSession)
      await refreshRagState(currentMunicipality.id)
      await refreshEmbeddingDetails(currentMunicipality.id)
      setStatus('ready')
      setMessage(
        visible
          ? `Munita quedó conectada a ${result.updated || 0} fuentes indexadas de ${currentMunicipality.name}. El índice se reconstruyó automáticamente.`
          : `Munita quedó desconectada de ${result.updated || 0} fuentes indexadas de ${currentMunicipality.name}. El índice se reconstruyó automáticamente.`,
      )
    } catch (error) {
      setStatus('error')
      setMessage(resolveActionError(error, 'No se pudo actualizar la conexion masiva de Munita.'))
    }
  }

  function renderJobResultItem(item) {
    if (jobResults.type === 'pages') {
      return (
        <article className="developer-result-row" key={`page-${item.id}`}>
          <div className="developer-result-main">
            <strong>{item.title}</strong>
            <span>{item.url}</span>
            <small>HTTP {item.statusCode || 's/d'} · profundidad {item.depth} · {formatDateTime(item.fetchedAt)}</small>
          </div>
          <dl>
            <div>
              <dt>Hash</dt>
              <dd>{item.contentHash ? item.contentHash.slice(0, 12) : 's/d'}</dd>
            </div>
            <div>
              <dt>Texto</dt>
              <dd>{item.textPath || 'Sin path'}</dd>
            </div>
            <div>
              <dt>Raw</dt>
              <dd>{item.rawPath || 'Sin path'}</dd>
            </div>
          </dl>
        </article>
      )
    }

    if (jobResults.type === 'assets') {
      return (
        <article className="developer-result-row" key={`asset-${item.id}`}>
          <div className="developer-result-main">
            <strong>{item.assetType?.toUpperCase() || 'Asset'} · {formatBytes(item.sizeBytes)}</strong>
            <span>{item.url}</span>
            <small>{item.textStatus || 'sin texto'} · {item.contentType || 'sin content-type'} · {formatDateTime(item.createdAt)}</small>
            {item.extractedTextPreview && <p>{shortText(item.extractedTextPreview, 220)}</p>}
          </div>
          <dl>
            <div>
              <dt>Archivo</dt>
              <dd>{item.filePath || 'Sin path'}</dd>
            </div>
            <div>
              <dt>Pagina</dt>
              <dd>{item.pageUrl || 'Sin página'}</dd>
            </div>
          </dl>
        </article>
      )
    }

    return (
      <article className="developer-result-row" key={`item-${item.id}`}>
        <div className="developer-result-main">
          <strong>{item.title}</strong>
          <span>{item.sourceUrl || 'Sin URL'}</span>
          <small>{item.sourceType || 'fuente'} · v{item.version || 1} · {formatDateTime(item.indexedAt)}</small>
          <p>{shortText(item.textPreview || item.summary || item.text, 260)}</p>
        </div>
        <dl>
          <div>
            <dt>Hash</dt>
            <dd>{item.contentHash ? item.contentHash.slice(0, 12) : 's/d'}</dd>
          </div>
          <div>
            <dt>Visible</dt>
            <dd>{item.visible ? 'Si' : 'No'}</dd>
          </div>
        </dl>
      </article>
    )
  }

  function renderJobResultRowsTable() {
    const items = jobResults.data?.result?.items || []
    if (jobResults.type === 'pages') {
      return items.map((item) => (
        <tr key={`page-table-${item.id}`}>
          <td>{formatDateTime(item.fetchedAt)}</td>
          <td>
            <strong>{item.title}</strong>
            {getSourceHref(item, 'pages') ? (
              <a href={getSourceHref(item, 'pages')} target="_blank" rel="noreferrer">
                {getSourceHref(item, 'pages')}
              </a>
            ) : (
              <span>Sin URL</span>
            )}
          </td>
          <td>HTTP {item.statusCode || 's/d'} - profundidad {item.depth}</td>
          <td>{item.contentHash ? item.contentHash.slice(0, 12) : 's/d'}</td>
          <td>
            <span>{item.textPath || 'Sin txt'}</span>
            <span>{item.rawPath || 'Sin raw'}</span>
          </td>
        </tr>
      ))
    }

    if (jobResults.type === 'assets') {
      return items.map((item) => (
        <tr key={`asset-table-${item.id}`}>
          <td>{formatDateTime(item.createdAt)}</td>
          <td>
            <strong>{item.assetType?.toUpperCase() || 'Asset'}</strong>
            {getSourceHref(item, 'assets') ? (
              <a href={getSourceHref(item, 'assets')} target="_blank" rel="noreferrer">
                {getSourceHref(item, 'assets')}
              </a>
            ) : (
              <span>Sin URL</span>
            )}
          </td>
          <td>{formatBytes(item.sizeBytes)} - {item.contentType || 'Sin content-type'}</td>
          <td>{item.textStatus || 'Sin texto'}</td>
          <td>
            <span>{item.pageUrl || 'Sin página'}</span>
            <span>{item.filePath || 'Sin archivo'}</span>
            {item.extractedTextPreview ? <span>{shortText(item.extractedTextPreview, 120)}</span> : null}
          </td>
        </tr>
      ))
    }

    return items.map((item) => (
      <tr key={`item-table-${item.id}`}>
        <td>{formatDateTime(item.indexedAt)}</td>
        <td>
          <strong>{item.title}</strong>
          {getSourceHref(item, 'items') ? (
            <a href={getSourceHref(item, 'items')} target="_blank" rel="noreferrer">
              {getSourceHref(item, 'items')}
            </a>
          ) : (
            <span>Sin URL</span>
          )}
        </td>
        <td>{item.sourceType || 'fuente'} - v{item.version || 1}</td>
        <td>{item.contentHash ? item.contentHash.slice(0, 12) : 's/d'}</td>
        <td>
          <span>{item.visible ? 'Visible' : 'Oculto'}</span>
          <span>{shortText(item.textPreview || item.summary || item.text, 160)}</span>
        </td>
      </tr>
    ))
  }

  const resultTabs = [
    { id: 'pages', label: 'Páginas', count: jobResults.data?.summary?.pages || 0 },
    { id: 'assets', label: 'Assets', count: jobResults.data?.summary?.assets || 0 },
    { id: 'items', label: 'Items', count: jobResults.data?.summary?.items || 0 },
  ]

  const citySetupChecklist = useMemo(() => {
    const barrioCount = effectiveMunicipalityBarrioCount
    const seedCount = Number(currentMunicipalityCoverage?.seedCount || 0)
    const hasSelection = Boolean(currentMunicipality)
    const hasOfficialCode = Boolean(String(currentMunicipality?.ineCode || '').trim())
    const hasBarrios = barrioCount > 0
    const hasGeoSource = Boolean(String(currentMunicipality?.geoSourceName || '').trim())
    const hasDomain = Boolean(String(currentMunicipality?.primaryDomain || '').trim())
    const selectorEnabled = currentMunicipality?.active === true
    const visibleInTopbar = selectorEnabled && (hasBarrios || seedCount > 0)

    return {
      barrioCount,
      seedCount,
      hasSelection,
      hasOfficialCode,
      hasBarrios,
      hasGeoSource,
      hasDomain,
      selectorEnabled,
      visibleInTopbar,
    }
  }, [currentMunicipality, currentMunicipalityCoverage?.seedCount, effectiveMunicipalityBarrioCount])


  return (
    <div className="municipal-app admin-muni-theme-light admin-internal-theme developer-theme">
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

      <main className={`page-shell page-shell-admin-muni page-shell-admin-internal ${!canUsePanel ? 'page-shell-panel-login' : ''}`.trim()}>
        <div className={`admin-muni-shell admin-ops-shell developer-shell ${isJobDetailView ? 'is-job-detail' : ''}`}>
          {showErrorToast ? (
            <aside className="developer-error-toast" role="alert" aria-live="assertive">
              <div>
                <strong>Error</strong>
                <p>{message}</p>
              </div>
              <button
                type="button"
                className="developer-error-toast-close"
                aria-label="Cerrar error"
                onClick={() => setIsErrorToastDismissed(true)}
              >
                &times;
              </button>
            </aside>
          ) : null}

          {showNotifToast ? (
            <aside className={`developer-notif-toast is-${notifToast.type}`} role="status" aria-live="polite">
              <p>{notifToast.message}</p>
              <button
                type="button"
                className="developer-notif-toast-close"
                aria-label="Cerrar"
                onClick={() => setNotifToastDismissed(true)}
              >
                &times;
              </button>
            </aside>
          ) : null}

          {!canUsePanel ? (
            <DeveloperGate />
          ) : (
            <>
              <section className="ops-panel-title" aria-label="Título del panel de desarrollador">
                <h1>Panel Desarrollador</h1>
              </section>

              <section className="developer-command">
                <div className="developer-command-title">
                  <span className="admin-muni-eyebrow">Desarrollador</span>
                  <div className="developer-heading-row">
                    <h1>{isJobDetailView ? `Job #${detailJobId}` : isEmbeddingsView ? 'Detalle de embeddings de Munita' : isCitiesView ? 'Ciudades y barrios' : 'Operaciones del asistente y spider'}</h1>
                    <InfoHint title="Estados del spider y configuración">
                      <p>
                        El panel resume tres señales: si la integración está habilitada en backend, si la URL interna del
                        spider responde y si las ejecuciones manuales estan prendidas desde este panel.
                      </p>
                      <ul className="developer-info-list">
                        <li><strong>Sin configurar:</strong> la integración del spider está apagada o no se definió en backend.</li>
                        <li><strong>URL faltante:</strong> el spider está habilitado, pero la URL interna del servicio está vacía.</li>
                        <li><strong>Offline:</strong> hay URL interna, pero el servicio no responde al health check.</li>
                        <li><strong>Error HTTP:</strong> el servicio respondió, pero devolvió un estado HTTP no válido.</li>
                        <li><strong>Apagado:</strong> el servicio está sano, pero las ejecuciones manuales están desactivadas.</li>
                        <li><strong>Listo:</strong> integración habilitada, servicio online y ejecuciones manuales activas.</li>
                      </ul>
                      <p>
                        El spider prendido no corre solo. Solo queda disponible para que vos lances crawls manuales desde
                        seeds ya revisadas.
                      </p>
                    </InfoHint>
                  </div>
                  <p>
                    {isJobDetailView
                      ? 'Vista detallada del crawl manual: fuentes, páginas, assets e ítems indexados.'
                      : isEmbeddingsView
                        ? 'Audita chunks conectados, mira su cobertura semántica y limpia embeddings desde una vista separada.'
                        : isCitiesView
                          ? 'Gestiona el catálogo municipal, la carga oficial de barrios y la importación manual de geografía.'
                        : 'Configura municipalidades, arma seeds y ejecuta crawls manuales del spider.'}
                  </p>
                </div>
                <div className="developer-command-actions">
                  {isJobDetailView ? (
                    <button
                      type="button"
                      className="admin-muni-ghost-button"
                      onClick={handleBackToDeveloperPanel}
                    >
                      Volver al panel
                    </button>
                  ) : isEmbeddingsView ? (
                    <button
                      type="button"
                      className="admin-muni-ghost-button"
                      onClick={handleBackFromEmbeddingsView}
                    >
                      Volver al panel
                    </button>
                  ) : isCitiesView ? (
                    <button
                      type="button"
                      className="admin-muni-ghost-button"
                      onClick={handleBackFromCitiesView}
                    >
                      Volver al panel
                    </button>
                  ) : null}
                </div>
              </section>

              {isOverviewView ? (
                <section className="developer-status-strip">
                  <div className="developer-status-strip-head">
                    <div>
                      <span className="admin-muni-eyebrow">Resumen técnico</span>
                      <h2>Estado general del panel</h2>
                    </div>
                    <InfoHint title="Qué resume esta franja">
                      <p>
                        Esta franja junta el estado rápido de municipalidades cargadas, simulación de recolección, publicación
                        del índice de Munita y disponibilidad de embeddings y chunks del spider.
                      </p>
                      <p>
                        Sirve para detectar rápido si falta cobertura municipal, si Munita puede consultar contenido conectado y
                        si la capa semántica está disponible o quedó solo en modo lexical.
                      </p>
                    </InfoHint>
                  </div>
                  <article className="developer-status-card">
                    <span>Municipalidades</span>
                    <strong>{municipalityStats.total}</strong>
                    <small>{municipalityStats.withSeeds} con seed / {municipalityStats.withGeo} con barrios listos</small>
                  </article>
                  <article className="developer-status-card">
                    <span>Recolección</span>
                    <strong>{simulationEnabled ? 'Encendida' : 'Apagada'}</strong>
                    <small>Para la demo podes abrir el panel del recolector o seguir usando el script existente: npm run simulate:recolector.</small>
                    <button type="button" className="admin-muni-ghost-button is-compact developer-panel-button" disabled={isBusy} onClick={handleToggleCollection}>
                      {simulationEnabled ? 'Apagar' : 'Prender'}
                    </button>
                    <button type="button" className="admin-muni-ghost-button is-compact developer-panel-button" onClick={handleOpenRecolectorPanel}>
                      Probar panel recolector
                    </button>
                  </article>
                  <article className="developer-status-card">
                    <span>Índice de Munita</span>
                    <strong>{publicIndexEnabled ? 'Habilitado' : 'Oculto'}</strong>
                    <small>Define si las fuentes publicadas del spider entran al índice consultable por Munita.</small>
                    <button type="button" className="admin-muni-ghost-button is-compact developer-panel-button" disabled={isBusy} onClick={handleTogglePublicIndex}>
                      {publicIndexEnabled ? 'Deshabilitar índice' : 'Habilitar índice'}
                    </button>
                  </article>
                  <article className="developer-status-card developer-status-card-spider">
                    <span>Chunks spider</span>
                    <strong>{ragRuntime?.counts?.spiderChunks || 0}</strong>
                    <small>Fragmentos conectados que hoy están listos para Munita. Reconstruí manualmente si querés refrescar el índice completo.</small>
                    <button type="button" className="admin-muni-ghost-button is-compact developer-panel-button" disabled={isBusy} onClick={handleReloadIndex}>
                      Reconstruir conectados
                    </button>
                  </article>
                  <article className="developer-status-card">
                    <span>Spider manual</span>
                    <strong>{spiderDisplayState.label}</strong>
                    <small>
                      {spiderConfigured
                        ? 'El prendido/apagado ahora vive junto al flujo de seeds y ejecución para que no quede separado del paso operativo.'
                        : 'La integración del spider todavía no está configurada en backend.'}
                    </small>
                  </article>
                  <article className="developer-status-card">
                    <span>Alta de ciudades</span>
                    <strong>{(currentMunicipality?.name || topbarMunicipality?.name || 'Municipalidad')} · {(currentMunicipalityCoverage?.barrioCount ?? topbarMunicipality?.barrioCount ?? 0)} barrios</strong>
                    <small>
                      {(currentMunicipality || topbarMunicipality)
                        ? `Abrí la vista guiada para analizar cualquier ciudad del catálogo, aunque no sea la misma del selector superior.`
                        : 'Entrá a la vista guiada para elegir la ciudad y dejar su geografía lista.'}
                    </small>
                    <button
                      type="button"
                      className="admin-muni-ghost-button is-compact developer-panel-button"
                      disabled={!(currentMunicipality || topbarMunicipality)}
                      onClick={handleOpenCitiesView}
                    >
                      Abrir pasos
                    </button>
                  </article>
                  <article className="developer-status-card developer-status-card-embeddings">
                    <span>Embeddings</span>
                    <strong>{ragRuntime?.counts?.vectorEmbeddings || 0} vector / {ragRuntime?.counts?.jsonEmbeddings || 0} JSON</strong>
                    <small>
                      {openAIRuntimeDisabled
                        ? 'OpenAI está apagado por configuración. Queda solo el fallback JSON y no se pueden recalcular embeddings.'
                        : 'Son las representaciones semánticas del índice. JSON actúa de respaldo; vector usa pgvector + OpenAI.'}
                    </small>
                    <div className="developer-status-card-actions">
                      <button
                        type="button"
                        className="admin-muni-ghost-button is-compact developer-panel-button"
                        disabled={isBusy || openAIRuntimeDisabled}
                        onClick={handleRebuildEmbeddings}
                      >
                        Regenerar embeddings
                      </button>
                      <button
                        type="button"
                        className="admin-muni-ghost-button is-danger is-compact developer-panel-button"
                        disabled={isBusy || !currentMunicipality}
                        onClick={handleClearEmbeddings}
                      >
                        Borrar conectados
                      </button>
                    </div>
                  </article>
                </section>
              ) : null}
              {isCitiesView ? (
                <section className="developer-results-board developer-munita-board">
                  <div className="developer-results-head">
                    <div>
                      <span className="admin-muni-eyebrow">Ciudades y barrios</span>
                      <div className="developer-heading-row">
                        <h2>Gestión de geografía municipal</h2>
                        <InfoHint title="Cómo leer esta vista">
                          <p>
                            Acá vive todo lo que prepara la geografía municipal sin tocar Munita ni el spider:
                            alta manual de ciudad, bootstrap oficial de barrios e importación desde archivo.
                          </p>
                          <p>
                            El contador de barrios sale de <code>municipal_barrios</code> para la municipalidad seleccionada.
                            Cada barrio queda ligado a una sola ciudad.
                          </p>
                        </InfoHint>
                      </div>
                      <p>La vista arranca tomando la ciudad del selector superior, pero desde acá podés cambiar el análisis a cualquier otra municipalidad del catálogo sin salir de esta pantalla.</p>
                    </div>
                    <div className="developer-row-actions">
                      <button
                        type="button"
                        className="admin-muni-ghost-button is-compact"
                        onClick={handleBackFromCitiesView}
                      >
                        Volver al panel
                      </button>
                    </div>
                  </div>

                  <div className="developer-results-metrics developer-results-metrics-cities">
                    <span>Ciudad activa <strong>{currentMunicipality?.name || 'Sin selección'}</strong></span>
                    <span>Barrios <strong>{citySetupChecklist.barrioCount}</strong></span>
                    <span>Visible en selector <strong>{citySetupChecklist.visibleInTopbar ? 'Sí' : citySetupChecklist.selectorEnabled ? 'Falta carga' : 'Oculta'}</strong></span>
                    <span>Fuente geo <strong>{currentMunicipality?.geoSourceName || 'Sin importar'}</strong></span>
                  </div>

                  <div className="developer-city-setup-shell">
                    <section className="developer-city-steps">
                      <article className="developer-city-step-card">
                        <div className="developer-city-step-head">
                          <span className="developer-city-step-index">Paso 1</span>
                          <div>
                            <h3>Elegí o registrá la ciudad</h3>
                            <p>Tocá una ciudad en la lista. Si no existe, completá el formulario y después tocá <strong>Agregar municipalidad</strong>.</p>
                          </div>
                        </div>

                        <div className="developer-city-step-helper">
                          El código INE conviene cargarlo desde el inicio porque después habilita el botón <strong>Cargar barrios oficiales</strong>.
                        </div>

                        <div className="developer-city-action-grid">
                          <section className="developer-cities-card">
                            <div className="developer-cities-card-head">
                              <div>
                                <strong>Catálogo de municipalidades</strong>
                                <p>Base INE/Datos.gov.py lista para elegir rápido la ciudad activa del análisis. Sin búsqueda se muestran hasta 4.</p>
                              </div>
                              <div className="developer-cities-selected">
                                <span>Ciudad activa</span>
                                <strong>{currentMunicipality?.name || 'Sin selección'}</strong>
                                <small>{currentMunicipality?.department || 'Sin departamento'} · {citySetupChecklist.barrioCount} barrios</small>
                              </div>
                            </div>

                            <div className="developer-filter-row developer-filter-row-cities">
                              <input
                                value={municipalitySearch}
                                placeholder="Buscar municipalidad o departamento"
                                onChange={(event) => setMunicipalitySearch(event.target.value)}
                              />
                              <select value={municipalitySeedFilter} onChange={(event) => setMunicipalitySeedFilter(event.target.value)}>
                                <option value="all">Todas</option>
                                <option value="with-seeds">Con seed</option>
                                <option value="without-seeds">Sin seed</option>
                              </select>
                            </div>

                            <div className="developer-municipality-list">
                              {visibleMunicipalities.map((municipality) => (
                                <button
                                  type="button"
                                  key={`city-view-${municipality.id}`}
                                  className={String(municipality.id) === String(currentMunicipality?.id) ? 'is-selected' : ''}
                                  onClick={() => handleSelectMunicipality(municipality.id)}
                                >
                                  <strong>{municipality.name}</strong>
                                  <span>{municipality.department || 'Sin departamento'} · {municipality.seedCount || 0} seeds · {municipality.barrioCount || 0} barrios</span>
                                </button>
                              ))}
                            </div>
                          </section>

                          <form className="developer-domain-form developer-domain-form-compact developer-cities-card" onSubmit={handleCreateMunicipality}>
                            <div>
                              <strong>Registrar municipalidad manual</strong>
                              <span>Usalo solo si la ciudad todavía no existe en el catálogo base.</span>
                            </div>
                            <label>
                              <span>Nombre</span>
                              <input
                                value={municipalityCreateForm.name}
                                placeholder="Ciudad nueva"
                                onChange={(event) => setMunicipalityCreateForm((current) => ({ ...current, name: event.target.value }))}
                              />
                            </label>
                            <label>
                              <span>Slug</span>
                              <input
                                value={municipalityCreateForm.slug}
                                placeholder="ciudad-nueva"
                                onChange={(event) => setMunicipalityCreateForm((current) => ({ ...current, slug: event.target.value }))}
                              />
                            </label>
                            <label>
                              <span>Departamento</span>
                              <input
                                value={municipalityCreateForm.department}
                                placeholder="Central"
                                onChange={(event) => setMunicipalityCreateForm((current) => ({ ...current, department: event.target.value }))}
                              />
                            </label>
                            <label>
                              <span>INE</span>
                              <input
                                value={municipalityCreateForm.ineCode}
                                placeholder="1107"
                                onChange={(event) => setMunicipalityCreateForm((current) => ({ ...current, ineCode: event.target.value }))}
                              />
                            </label>
                            <label>
                              <span>Dominio</span>
                              <input
                                value={municipalityCreateForm.primaryDomain}
                                placeholder="www.municipalidad.gov.py"
                                onChange={(event) => setMunicipalityCreateForm((current) => ({ ...current, primaryDomain: event.target.value }))}
                              />
                            </label>
                            <button type="submit" className="admin-muni-ghost-button developer-city-wide-button" disabled={isBusy}>
                              Agregar municipalidad
                            </button>
                          </form>
                        </div>
                      </article>

                      <article className="developer-city-step-card">
                        <div className="developer-city-step-head">
                          <span className="developer-city-step-index">Paso 2</span>
                          <div>
                            <h3>Cargá los barrios</h3>
                            <p>Primero probá <strong>Cargar barrios oficiales</strong>. Si no sirve esa fuente, quedate en este mismo bloque y usá <strong>Importar archivo</strong>.</p>
                          </div>
                        </div>

                        <div className="developer-city-step-helper">
                          La carga oficial reemplaza `municipal_barrios` de la ciudad elegida. El archivo es ideal cuando ya tenés GeoJSON, JSON o CSV propio.
                        </div>

                        <div className="developer-city-action-grid">
                          <section className="developer-cities-card developer-city-official-card">
                            <div className="developer-cities-card-head">
                              <div>
                                <strong>Barrios oficiales</strong>
                                <p>Camino recomendado para dejar lista la geografía de Baches y el centrado municipal de Recolección.</p>
                              </div>
                              <div className="developer-cities-selected">
                                <span>INE actual</span>
                                <strong>{currentMunicipality?.ineCode || 'Sin código'}</strong>
                                <small>{citySetupChecklist.hasOfficialCode ? 'Disponible para bootstrap oficial' : 'Completalo para habilitar la fuente oficial'}</small>
                              </div>
                            </div>

                            <div className="developer-city-cta-block">
                              <button
                                type="button"
                                className="admin-muni-primary-button developer-city-wide-button"
                                disabled={isBusy || !currentMunicipality}
                                onClick={handleBootstrapMunicipality}
                              >
                                Cargar barrios oficiales
                              </button>
                              <span>Reemplaza barrios de la ciudad seleccionada y actualiza centro, bbox y metadatos geográficos.</span>
                            </div>
                          </section>

                          {currentMunicipality ? (
                            <form className="developer-domain-form developer-domain-form-compact developer-cities-card" onSubmit={handleImportMunicipalityFile}>
                              <div>
                                <strong>Importar barrios por archivo</strong>
                                <span>
                                  `GeoJSON` habilita click directo sobre polígonos. `CSV` sirve para centros, bbox y
                                  geometrías embebidas en `geometry_geojson`.
                                </span>
                              </div>
                              <label>
                                <span>Archivo</span>
                                <input
                                  key={geoImportInputKey}
                                  type="file"
                                  accept=".geojson,.json,.csv,application/geo+json,application/json,text/csv"
                                  onChange={(event) => setGeoImportForm((current) => ({ ...current, file: event.target.files?.[0] || null }))}
                                />
                              </label>
                              <label>
                                <span>Fuente visible</span>
                                <input
                                  value={geoImportForm.sourceName}
                                  placeholder="Catastro municipal / archivo propio"
                                  onChange={(event) => setGeoImportForm((current) => ({ ...current, sourceName: event.target.value }))}
                                />
                              </label>
                              <label>
                                <span>URL fuente</span>
                                <input
                                  value={geoImportForm.sourceUrl}
                                  placeholder="https://..."
                                  onChange={(event) => setGeoImportForm((current) => ({ ...current, sourceUrl: event.target.value }))}
                                />
                              </label>
                              <div className="developer-cities-card-note">
                                <strong>Úsalo cuando la fuente oficial no alcance</strong>
                                <span>Si existe cartografía oficial, seguí prefiriendo la carga oficial para evitar inconsistencias.</span>
                              </div>
                              <button type="submit" className="admin-muni-primary-button developer-city-wide-button" disabled={isBusy}>
                                Importar archivo
                              </button>
                            </form>
                          ) : (
                            <section className="developer-cities-card developer-cities-card-empty">
                              <strong>Importar barrios por archivo</strong>
                              <p>Seleccioná una municipalidad para habilitar la importación manual de GeoJSON, JSON o CSV.</p>
                            </section>
                          )}
                        </div>
                      </article>
                    </section>

                    <aside className="developer-city-focus-card">
                      <div className="developer-city-focus-head">
                        <span className="admin-muni-eyebrow">Resumen visible</span>
                        <h3>{currentMunicipality?.name || 'Elegí una ciudad para empezar'}</h3>
                        <p>Panel lateral más grande para ver el estado actual y decidir si esta ciudad también debe aparecer en el selector superior.</p>
                      </div>

                      <div className="developer-city-focus-grid">
                        <article className="developer-city-focus-stat">
                          <span>Barrios</span>
                          <strong>{citySetupChecklist.barrioCount}</strong>
                          <small>{citySetupChecklist.hasBarrios ? 'La geografía ya está cargada.' : 'Todavía no hay barrios en base.'}</small>
                        </article>
                        <article className="developer-city-focus-stat">
                          <span>Seeds del asistente</span>
                          <strong>{citySetupChecklist.seedCount}</strong>
                          <small>{citySetupChecklist.seedCount > 0 ? 'La ciudad ya puede entrar al flujo técnico de Munita.' : 'Después seguí con dominio y seeds desde el panel principal.'}</small>
                        </article>
                        <article className="developer-city-focus-stat">
                          <span>Dominio</span>
                          <strong>{citySetupChecklist.hasDomain ? 'Cargado' : 'Pendiente'}</strong>
                          <small>{currentMunicipality?.primaryDomain || 'Todavía no hay dominio oficial guardado.'}</small>
                        </article>
                        <article className="developer-city-focus-stat">
                          <span>Selector superior</span>
                          <strong>{citySetupChecklist.visibleInTopbar ? 'Visible' : citySetupChecklist.selectorEnabled ? 'Falta carga' : 'Oculta'}</strong>
                          <small>
                            {citySetupChecklist.visibleInTopbar
                              ? 'Ya debería aparecer en el selector superior.'
                              : citySetupChecklist.selectorEnabled
                                ? 'Está marcada visible, pero todavía necesita barrios cargados o al menos una seed.'
                                : 'No aparecerá arriba hasta volver a marcarla como visible.'}
                          </small>
                        </article>
                      </div>

                      <section className="developer-city-next-panel">
                        <strong>Visible en selector superior</strong>
                        <p>
                          Esto controla si la municipalidad puede aparecer arriba a la derecha. Además de quedar visible,
                          necesita barrios cargados o una seed para mostrarse de verdad.
                        </p>
                        <div className="developer-city-quick-actions">
                          <button
                            type="button"
                            className="admin-muni-primary-button developer-city-wide-button"
                            disabled={isBusy || !currentMunicipality}
                            onClick={handleToggleMunicipalityVisibility}
                          >
                            {currentMunicipality?.active ? 'Ocultar del selector' : 'Mostrar en selector'}
                          </button>
                        </div>
                      </section>

                      <section className="developer-city-checklist">
                        <div className={`developer-city-check-item ${citySetupChecklist.hasSelection ? 'is-ready' : ''}`.trim()}>
                          <span className="developer-city-check-bullet">{citySetupChecklist.hasSelection ? '✓' : '1'}</span>
                          <div>
                            <strong>Municipalidad seleccionada</strong>
                            <small>{citySetupChecklist.hasSelection ? 'Ya podés trabajar sobre una ciudad concreta.' : 'Elegí una ciudad del catálogo o creala manualmente.'}</small>
                          </div>
                        </div>
                        <div className={`developer-city-check-item ${citySetupChecklist.hasOfficialCode ? 'is-ready' : ''}`.trim()}>
                          <span className="developer-city-check-bullet">{citySetupChecklist.hasOfficialCode ? '✓' : '2'}</span>
                          <div>
                            <strong>Código INE listo</strong>
                            <small>{citySetupChecklist.hasOfficialCode ? 'Podés usar la carga oficial de barrios.' : 'Si no existe, seguí con importación por archivo.'}</small>
                          </div>
                        </div>
                        <div className={`developer-city-check-item ${citySetupChecklist.hasBarrios ? 'is-ready' : ''}`.trim()}>
                          <span className="developer-city-check-bullet">{citySetupChecklist.hasBarrios ? '✓' : '3'}</span>
                          <div>
                            <strong>Geografía cargada</strong>
                            <small>{citySetupChecklist.hasBarrios ? 'La ciudad ya quedó lista para Baches y el centrado por ciudad.' : 'Usá Cargar barrios oficiales o Importar archivo en el paso 2.'}</small>
                          </div>
                        </div>
                      </section>

                      <section className="developer-city-next-panel">
                        <strong>Después seguí sin pasos desde el panel principal</strong>
                        <p>Guardá dominio, agregá seeds, revisá la fuente, ejecutá el crawl y recién ahí regenerá índice o embeddings para Munita.</p>
                      </section>

                      <div className="developer-city-quick-actions">
                        <button
                          type="button"
                          className="admin-muni-ghost-button"
                          disabled={isBusy || !currentMunicipality}
                          onClick={handleStartCreateBarrio}
                        >
                          Agregar barrio manual
                        </button>
                      </div>
                    </aside>
                  </div>

                  <section className="developer-barrios-board">
                    <div className="developer-barrios-head">
                      <div>
                        <span className="admin-muni-eyebrow">municipal_barrios</span>
                        <h3>Barrios en base de datos</h3>
                            <p>
                              Debajo queda la tabla operativa de la ciudad seleccionada arriba a la derecha. Acá también se
                              puede agregar un barrio manual o corregir coordenadas, aunque sigue siendo un camino no recomendado.
                            </p>
                          </div>
                      <div className="developer-barrios-head-actions">
                        <button
                          type="button"
                          className="admin-muni-ghost-button is-compact"
                          disabled={isBusy || !currentMunicipality}
                          onClick={handleStartCreateBarrio}
                        >
                          Agregar barrio manual
                        </button>
                      </div>
                    </div>

                    <div className="developer-results-metrics developer-results-metrics-barrios">
                      <span>Total <strong>{municipalBarrios.length}</strong></span>
                      <span>Con polígono <strong>{barriosWithGeometryCount}</strong></span>
                      <span>Solo centro <strong>{Math.max(0, municipalBarrios.length - barriosWithGeometryCount)}</strong></span>
                    </div>

                    <div className="developer-filter-row developer-filter-row-barrios">
                      <input
                        value={barrioQuery}
                        placeholder="Buscar barrio, slug, código o fuente"
                        onChange={(event) => setBarrioQuery(event.target.value)}
                      />
                    </div>

                    {editingBarrioId ? (
                      <form className="developer-domain-form developer-domain-form-compact developer-barrio-editor" onSubmit={handleSubmitBarrioForm}>
                        <div>
                          <strong>{editingBarrioId === 'new' ? 'Agregar barrio manual' : 'Editar barrio seleccionado'}</strong>
                          <span>No recomendado: usá esta edición solo para corregir o completar datos puntuales de `municipal_barrios`.</span>
                        </div>
                        <label>
                          <span>Barrio</span>
                          <input
                            value={barrioForm.barrioLabel}
                            placeholder="Nuevo barrio"
                            onChange={(event) => setBarrioForm((current) => ({ ...current, barrioLabel: event.target.value }))}
                          />
                        </label>
                        <label>
                          <span>Código</span>
                          <input
                            value={barrioForm.barrioCode}
                            placeholder="Opcional"
                            onChange={(event) => setBarrioForm((current) => ({ ...current, barrioCode: event.target.value }))}
                          />
                        </label>
                        <label>
                          <span>Latitud</span>
                          <input
                            value={barrioForm.centerLat}
                            placeholder="-25.300120"
                            onChange={(event) => setBarrioForm((current) => ({ ...current, centerLat: event.target.value }))}
                          />
                        </label>
                        <label>
                          <span>Longitud</span>
                          <input
                            value={barrioForm.centerLon}
                            placeholder="-57.635540"
                            onChange={(event) => setBarrioForm((current) => ({ ...current, centerLon: event.target.value }))}
                          />
                        </label>
                        <div className="developer-row-actions">
                          <button type="submit" className="admin-muni-primary-button" disabled={isBusy || !currentMunicipality}>
                            {editingBarrioId === 'new' ? 'Guardar barrio' : 'Guardar cambios'}
                          </button>
                          <button type="button" className="admin-muni-ghost-button is-compact" onClick={handleCancelBarrioEdition}>
                            Cancelar
                          </button>
                        </div>
                      </form>
                    ) : null}

                    <div className="developer-barrios-table-wrap">
                      <table className="developer-barrios-table">
                        <thead>
                          <tr>
                            <th>ID</th>
                            <th>Slug</th>
                            <th>Barrio</th>
                            <th>Código</th>
                            <th>Latitud</th>
                            <th>Longitud</th>
                            <th>Geo</th>
                            <th>Fuente</th>
                            <th>Actualizado</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {visibleMunicipalBarrios.length ? visibleMunicipalBarrios.map((barrio) => (
                            <tr
                              key={`municipal-barrio-${barrio.id}`}
                              className={String(editingBarrioId) === String(barrio.id) ? 'is-editing' : ''}
                            >
                              <td>{barrio.id}</td>
                              <td>{barrio.barrioSlug}</td>
                              <td>{barrio.barrioLabel}</td>
                              <td>{barrio.barrioCode || '—'}</td>
                              <td>{formatCoordinate(barrio.centerLat)}</td>
                              <td>{formatCoordinate(barrio.centerLon)}</td>
                              <td>{barrio.hasGeometry ? 'Polígono' : 'Centro'}</td>
                              <td>{shortText(barrio.sourceName || 'Manual', 44)}</td>
                              <td>{formatDateTime(barrio.updatedAt || barrio.importedAt)}</td>
                              <td>
                                <button
                                  type="button"
                                  className="admin-muni-ghost-button is-compact"
                                  disabled={isBusy}
                                  onClick={() => handleStartEditBarrio(barrio)}
                                >
                                  Editar
                                </button>
                              </td>
                            </tr>
                          )) : (
                            <tr>
                              <td colSpan="10" className="developer-barrios-empty">
                                {currentMunicipality
                                  ? 'No hay barrios cargados para esta municipalidad o el filtro no devolvió resultados.'
                                  : 'Seleccioná una municipalidad para listar sus barrios.'}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </section>
              ) : isEmbeddingsView ? (
                <section className="developer-results-board developer-munita-board">
                  <div className="developer-results-head">
                    <div>
                      <span className="admin-muni-eyebrow">Embeddings</span>
                      <div className="developer-heading-row">
                        <h2>Detalle de chunks conectados</h2>
                        <InfoHint title="Qué muestra este detalle">
                          <p>
                            Esta vista lista los chunks spider que hoy están cargados en <code>rag_chunks</code> y por eso
                            Munita ya puede consultar.
                          </p>
                          <ul className="developer-info-list">
                            <li><strong>Vector + JSON:</strong> el chunk tiene ambas representaciones semánticas.</li>
                            <li><strong>Solo JSON:</strong> hay embedding serializado, pero no vector pgvector.</li>
                            <li><strong>Sin embedding:</strong> Munita lo puede usar igual, pero solo por búsqueda lexical.</li>
                          </ul>
                        </InfoHint>
                      </div>
                      <p>Vista separada para auditar qué chunks conectados tienen embedding y limpiar la capa semántica cuando haga falta.</p>
                    </div>
                    <div className="developer-row-actions">
                      <button
                        type="button"
                        className="admin-muni-ghost-button is-compact"
                        onClick={handleBackFromEmbeddingsView}
                      >
                        Volver al panel
                      </button>
                      <button
                        type="button"
                        className="admin-muni-ghost-button is-danger is-compact"
                        disabled={isBusy || !currentMunicipality}
                        onClick={handleClearEmbeddings}
                      >
                        Borrar embeddings conectados
                      </button>
                      <button
                        type="button"
                        className="admin-muni-primary-button"
                        disabled={isBusy || openAIRuntimeDisabled}
                        onClick={handleRebuildEmbeddings}
                      >
                        Regenerar embeddings
                      </button>
                    </div>
                  </div>

                  {embeddingDetails.summary ? (
                    <div className="developer-results-metrics">
                      <span>{currentMunicipality?.name || 'Municipalidad'} · fuentes {embeddingDetails.summary.totalSources}</span>
                      <span>Chunks conectados {embeddingDetails.summary.totalChunks}</span>
                      <span>Con embedding {embeddingDetails.summary.embeddedChunks}</span>
                      <span>Sin embedding {embeddingDetails.summary.missingChunks}</span>
                      <span>Vector {embeddingDetails.summary.vectorChunks}</span>
                      <span>JSON {embeddingDetails.summary.jsonChunks}</span>
                    </div>
                  ) : null}

                  <div className="developer-filter-row">
                    <input
                      value={embeddingQuery}
                      placeholder="Buscar chunk, fuente o URL conectada"
                      onChange={(event) => setEmbeddingQuery(event.target.value)}
                    />
                    <select value={embeddingStateFilter} onChange={(event) => setEmbeddingStateFilter(event.target.value)}>
                      <option value="all">Todos</option>
                      <option value="embedded">Con embedding</option>
                      <option value="missing">Sin embedding</option>
                    </select>
                  </div>

                  <div className="developer-results-table-wrap">
                    <table className="developer-results-table">
                      <thead>
                        <tr>
                          <th>Chunk</th>
                          <th>Fuente</th>
                          <th>Categoria / tipo</th>
                          <th>Embedding</th>
                          <th>Preview</th>
                        </tr>
                      </thead>
                      <tbody>
                        {embeddingDetails.chunks.length ? embeddingDetails.chunks.map((item) => (
                          <tr key={`embedding-${item.id}`}>
                            <td>
                              <strong>{item.chunkTitle}</strong>
                              <span>{item.id}</span>
                              <span>{formatDateTime(item.indexedAt)}</span>
                            </td>
                            <td>
                              <strong>{item.sourceTitle}</strong>
                              <span>{item.sourceUrl || 'Sin URL'}</span>
                              <span>{formatSourceType(item.sourceType)}</span>
                            </td>
                            <td>
                              <strong>{item.categoria || 'institucional'}</strong>
                              <span>{item.tipo || 'informacion'}</span>
                            </td>
                            <td>
                              <strong>{formatEmbeddingCoverage(item)}</strong>
                              <span>{item.embeddingModel || 'Sin modelo'}</span>
                            </td>
                            <td>
                              <strong>{item.textPreview || 'Sin preview.'}</strong>
                            </td>
                          </tr>
                        )) : (
                          <tr>
                            <td colSpan="5">
                              <p className="admin-runtime-message">No hay chunks conectados para este filtro.</p>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="developer-results-pagination">
                    <small>
                      Pagina {embeddingDetails.result?.page || 1} de {embeddingDetails.result?.totalPages || 1}
                      {' '}· {embeddingDetails.result?.totalItems || 0} chunks conectados
                    </small>
                    <div className="developer-row-actions">
                      <button
                        type="button"
                        className="admin-muni-ghost-button is-compact"
                        disabled={(embeddingDetails.result?.page || 1) <= 1}
                        onClick={() => handleChangeEmbeddingPage('prev')}
                      >
                        Anterior
                      </button>
                      <button
                        type="button"
                        className="admin-muni-ghost-button is-compact"
                        disabled={(embeddingDetails.result?.page || 1) >= (embeddingDetails.result?.totalPages || 1)}
                        onClick={() => handleChangeEmbeddingPage('next')}
                      >
                        Siguiente
                      </button>
                    </div>
                  </div>
                </section>
              ) : (
              <>
              <section className="developer-workflow">
                <article className="developer-step developer-step-runtime">
                  <div className="developer-step-head">
                    <span>R</span>
                    <div>
                      <div className="developer-heading-row">
                        <h2>Runtime de Munita</h2>
                        <InfoHint title="Que controla este runtime">
                          <p>
                            Estos ajustes viven en <code>rag_runtime_settings</code> y Munita los relee en cada consulta del asistente.
                          </p>
                          <ul className="developer-info-list">
                            <li><strong>Embeddings:</strong> decide si Munita suma scoring semántico o usa solo búsqueda lexical.</li>
                            <li><strong>Chunks:</strong> limita cuantos fragmentos conectados entran en cada respuesta.</li>
                            <li><strong>Umbral:</strong> filtra resultados poco relevantes antes de responder.</li>
                            <li><strong>Scope:</strong> define si la municipalidad del header es estricta o puede caer a fallback.</li>
                          </ul>
                          <p>
                            El runtime es global. La municipalidad efectiva la manda el selector del header en
                            <code> /munita</code>; ahora mismo la app tiene activa <strong>{activeMunicipality?.label || 'Asunci\u00f3n'}</strong>.
                          </p>
                          <p>
                            Para que una fuente llegue a Munita necesitás chunk conectado e indexado, índice público habilitado
                            y, si el scope estricto está activo, coincidencia con la municipalidad elegida.
                          </p>
                        </InfoHint>
                      </div>
                      <p>Ajusta cómo el asistente recupera fragmentos, usa embeddings y respeta el alcance por municipalidad.</p>
                    </div>
                  </div>

                  <form className="developer-seed-form developer-runtime-form" onSubmit={handleSaveAssistantRuntime}>
                    <div className="developer-runtime-fields">
                      <label>
                        <span>Embeddings</span>
                        <select
                          value={ragRuntimeDraft.assistantUseEmbeddings ? 'on' : 'off'}
                          onChange={(event) => {
                            setRagRuntimeDraftDirty(true)
                            setRagRuntimeDraft((current) => ({
                              ...current,
                              assistantUseEmbeddings: event.target.value === 'on',
                            }))
                          }}
                        >
                          <option value="on">Activados</option>
                          <option value="off">Solo lexical</option>
                        </select>
                      </label>
                      <label>
                        <span>Chunks</span>
                        <input
                          type="number"
                          min="1"
                          max={runtimeChunkLimitMax || undefined}
                          disabled={runtimeChunkLimitMax === null}
                          value={ragRuntimeDraft.assistantChunkLimit}
                          onChange={(event) => {
                            setRagRuntimeDraftDirty(true)
                            setRagRuntimeDraft((current) => ({
                              ...current,
                              assistantChunkLimit: Number(event.target.value),
                            }))
                          }}
                        />
                        <small className={`developer-runtime-helper${runtimeChunkLimitMax === null ? ' is-disabled' : ''}`}>
                          {runtimeChunkLimitStatus}
                        </small>
                      </label>
                      <label>
                        <span>Umbral</span>
                        <input
                          type="number"
                          min="0"
                          max="50"
                          step="0.5"
                          value={ragRuntimeDraft.assistantMinRelevanceScore}
                          onChange={(event) => {
                            setRagRuntimeDraftDirty(true)
                            setRagRuntimeDraft((current) => ({
                              ...current,
                              assistantMinRelevanceScore: Number(event.target.value),
                            }))
                          }}
                        />
                      </label>
                      <label>
                        <span>Scope</span>
                        <select
                          value={ragRuntimeDraft.assistantStrictMunicipalityScope ? 'strict' : 'fallback'}
                          onChange={(event) => {
                            setRagRuntimeDraftDirty(true)
                            setRagRuntimeDraft((current) => ({
                              ...current,
                              assistantStrictMunicipalityScope: event.target.value === 'strict',
                            }))
                          }}
                        >
                          <option value="strict">Estricto por muni</option>
                          <option value="fallback">Permitir fallback</option>
                        </select>
                      </label>
                    </div>
                    <div className="developer-runtime-submit">
                      <button type="submit" className="admin-muni-primary-button developer-panel-button" disabled={isBusy || !ragRuntimeDraftDirty}>
                        Guardar runtime
                      </button>
                    </div>
                  </form>

                  <div className="developer-runtime-note" hidden>
                    <p>
                      Esta configuración se guarda en <code>rag_runtime_settings</code> y Munita la vuelve a leer en cada consulta del asistente.
                    </p>
                    <p>
                      El runtime es global. La municipalidad efectiva la manda el selector del header en <code>/munita</code>:
                      ahora mismo la app tiene activa <strong>{activeMunicipality?.label || 'Asunci\u00f3n'}</strong>. La cobertura
                      mostrada abajo corresponde a <strong>{currentMunicipality?.name || 'la municipalidad seleccionada'}</strong>.
                    </p>
                  </div>

                  <div className="developer-results-metrics">
                    <span>Embeddings {ragRuntime?.assistantUseEmbeddings === false ? 'off' : 'on'}</span>
                    <span>Chunks {ragRuntime?.assistantChunkLimit || 10}</span>
                    <span>Umbral {ragRuntime?.assistantMinRelevanceScore || 5}</span>
                    <span>{ragRuntime?.assistantStrictMunicipalityScope === false ? 'Fallback global' : 'Scope estricto'}</span>
                  </div>

                  {currentMunicipalityCoverage ? (
                    <div className="developer-results-metrics">
                      <span>{currentMunicipality?.name || 'Municipalidad'}: {currentMunicipalityCoverage.seedCount} seeds</span>
                      <span>{currentMunicipalityCoverage.spiderItemCount} items spider</span>
                      <span>{currentMunicipalityCoverage.spiderVisibleItemCount} conectados</span>
                      <span>{currentMunicipalityCoverage.spiderChunkCount} chunks de Munita</span>
                      <span>{currentMunicipalityCoverage.spiderEmbeddedChunkCount} chunks con embedding</span>
                    </div>
                  ) : null}
                </article>
              </section>

              <section className="developer-results-board developer-munita-board">
                <div className="developer-results-head">
                  <div>
                    <span className="admin-muni-eyebrow">Munita</span>
                    <div className="developer-heading-row">
                      <h2>Fuentes conectadas al índice consultable</h2>
                      <InfoHint title="Cómo leer la conexión de Munita">
                        <p>
                          Este bloque resume qué fuentes del spider ya quedaron conectadas a Munita para la municipalidad seleccionada.
                        </p>
                        <p>
                          Conectar o desconectar fuentes ya refresca el índice automáticamente. El botón manual sirve para
                          relanzar la reconstrucción sin cambiar visibilidad y después saltar al detalle paginado con más espacio.
                        </p>
                      </InfoHint>
                    </div>
                    <p>Primero conectá o desconectá fuentes. Si necesitás relanzar el armado completo sin tocar esa visibilidad, usá la reconstrucción manual del índice.</p>
                  </div>
                </div>
                <div className="developer-munita-toolbar">
                  <div className="developer-munita-actions">
                    <button
                      type="button"
                      className="admin-muni-ghost-button is-compact developer-panel-button"
                      disabled={isBusy || !currentMunicipality}
                      onClick={() => handleBulkCatalogVisibility(true)}
                    >
                      Conectar todo a Munita
                    </button>
                    <button
                      type="button"
                      className="admin-muni-ghost-button is-compact developer-panel-button"
                      disabled={isBusy || !currentMunicipality}
                      onClick={() => handleBulkCatalogVisibility(false)}
                    >
                      Desconectar todo de Munita
                    </button>
                    <button type="button" className="admin-muni-primary-button developer-panel-button" disabled={isBusy} onClick={handleReloadIndex}>
                      Reconstruir índice manualmente
                    </button>
                  </div>
                  <div className="developer-munita-metrics">
                    <span>Items spider <strong>{ragRuntime?.counts?.spiderIndexItems || 0}</strong></span>
                    <span>Publicados <strong>{ragRuntime?.counts?.spiderVisibleItems || 0}</strong></span>
                    <span>Chunks spider <strong>{ragRuntime?.counts?.spiderChunks || 0}</strong></span>
                    <span>Embeddings spider <strong>{ragRuntime?.counts?.spiderEmbeddedChunks || 0}</strong></span>
                    {currentMunicipalityCoverage ? (
                      <>
                        <span>{currentMunicipality?.name || 'Municipalidad'} · Items spider <strong>{currentMunicipalityCoverage.spiderItemCount}</strong></span>
                        <span>Conectados <strong>{currentMunicipalityCoverage.spiderVisibleItemCount}</strong></span>
                        <span>Chunks de Munita <strong>{currentMunicipalityCoverage.spiderChunkCount}</strong></span>
                        <span>Embeddings <strong>{currentMunicipalityCoverage.spiderEmbeddedChunkCount}</strong></span>
                      </>
                    ) : null}
                  </div>
                  <div className="developer-munita-detail">
                    <button
                      type="button"
                      className="admin-muni-ghost-button is-compact developer-panel-button"
                      disabled={isBusy || !currentMunicipality}
                      onClick={handleOpenEmbeddingsView}
                    >
                      Ver detalle
                    </button>
                  </div>
                </div>
                <p className="developer-munita-helper">
                  Conectar o desconectar una fuente ya vuelve a reconstruir el índice. Usá la reconstrucción manual solo si querés relanzar ese proceso sin cambiar la visibilidad actual.
                </p>
              </section>
              </>
              )}
              {isOverviewView && (
              <section className="developer-spider-suite">
                <div className="developer-spider-suite-head">
                  <div>
                    <span className="admin-muni-eyebrow">Spider</span>
                    <div className="developer-heading-row">
                      <h2>Operacion manual del spider</h2>
                      <InfoHint title="Que agrupa este bloque">
                        <p>
                          Aca queda junto todo lo que pertenece al crawler manual: observabilidad, municipalidad activa,
                          URLs semilla y cola de ejecucion.
                        </p>
                        <p>
                          La idea es que se lea como un solo flujo operativo: elegís municipio, revisás seeds, corrés jobs y
                          ves la actividad viva del servicio sin saltar entre bloques lejanos.
                        </p>
                      </InfoHint>
                    </div>
                    <p>Todo lo que sigue pertenece al circuito tecnico del spider manual y su seguimiento en tiempo real.</p>
                  </div>
                  <div className="developer-spider-suite-status">
                    <div className={`admin-ops-live-chip ${spiderOnline ? 'is-on' : 'is-off'}`}>
                      <span>Jobs activos</span>
                      <strong>{spiderActivity.length}</strong>
                    </div>
                    <article className="developer-spider-launch-card developer-spider-launch-card-inline">
                      <span className={`admin-runtime-badge ${spiderDisplayState.tone}`}>{spiderDisplayState.label}</span>
                      <strong>Primero tocá {spiderOperationsEnabled ? 'Apagar spider' : 'Prender spider'}</strong>
                      <p>El spider prendido no corre solo. Solo deja habilitada la operación manual para las seeds que ya revisaste.</p>
                      <button
                        type="button"
                        className={`admin-muni-primary-button developer-city-wide-button ${spiderOperationsEnabled ? 'is-active' : ''}`.trim()}
                        disabled={isBusy || !spiderConfigured}
                        onClick={handleToggleSpider}
                      >
                        {spiderOperationsEnabled ? 'Apagar spider' : 'Prender spider'}
                      </button>
                    </article>
                  </div>
                </div>

                <section className="developer-observability-board">
                  <div className="developer-observability-head">
                    <div>
                      <span className="admin-muni-eyebrow">Observabilidad</span>
                      <div className="developer-heading-row">
                        <h2>Actividad actual del spider</h2>
                        <InfoHint title="Qué muestra observabilidad">
                          <p>
                            Este bloque sale del endpoint interno de salud del spider. Solo muestra jobs que el servicio reporta
                            como activos en este momento.
                          </p>
                          <p>
                            Si no ves tarjetas acá, puede significar que no hay crawls corriendo o que el servicio no está
                            respondiendo. El chip superior te ayuda a distinguirlo.
                          </p>
                        </InfoHint>
                      </div>
                      <p>Estado en vivo del servicio interno y de los jobs que siguen corriendo.</p>
                    </div>
                  </div>

                  <div className="developer-observability-grid">
                    {spiderActivity.length ? spiderActivity.map((job) => (
                      <article className="developer-observability-card" key={`live-job-${job.jobId}`}>
                        <div className="developer-row-title">
                          <strong>Job #{job.jobId}</strong>
                          <span className={`admin-runtime-badge ${healthTone(job.phase === 'failed' ? 'failed' : 'running')}`}>
                            {job.phase || 'running'}
                          </span>
                        </div>
                        <p>{job.message || 'Sin mensaje del spider.'}</p>
                        <small>{job.municipalityName || 'Municipalidad'} - seed {job.currentSeedIndex || 0}/{job.totalSeeds || 0}</small>
                        <small>{job.currentUrl || job.currentAssetUrl || 'Sin URL actual'}</small>
                        <dl className="developer-observability-stats">
                          <div><dt>Pag.</dt><dd>{job.stats?.pages || 0}</dd></div>
                          <div><dt>PDF</dt><dd>{job.stats?.pdfs || 0}</dd></div>
                          <div><dt>Img.</dt><dd>{job.stats?.images || 0}</dd></div>
                          <div><dt>Err.</dt><dd>{job.stats?.errors || 0}</dd></div>
                          <div><dt>Cola</dt><dd>{job.queueSize || 0}</dd></div>
                          <div><dt>Vistas</dt><dd>{job.visitedCount || 0}</dd></div>
                        </dl>
                        <small>Ultima actividad {formatDateTime(job.lastEventAt)} - duracion {formatDuration(job.startedAt, null)}</small>
                      </article>
                    )) : (
                      <p className="admin-runtime-message">Sin jobs activos en el servicio del spider.</p>
                    )}
                  </div>
                </section>

              <section className="developer-workflow developer-workflow-spider">
                <article className="developer-step developer-step-municipalities">
                  <div className="developer-step-head">
                    <span>1</span>
                    <div>
                      <div className="developer-heading-row">
                        <h2>Municipalidad y dominio</h2>
                        <InfoHint title="Como usar municipalidad y dominio">
                          <p>
                            Primero elegí la municipalidad sobre la que vas a trabajar. El dominio oficial se usa para sugerir
                            seeds iniciales y dejar documentada la fuente institucional esperada.
                          </p>
                          <p>
                            La lista sale de la base INE/Datos.gov.py y la cantidad de seeds te da una lectura rápida de
                            cobertura técnica por municipio.
                          </p>
                        </InfoHint>
                      </div>
                      <p>Base INE/Datos.gov.py: seleccioná una municipalidad y completá su dominio oficial.</p>
                    </div>
                  </div>

                  <div className="developer-filter-row">
                    <input
                      value={municipalitySearch}
                      placeholder="Buscar municipalidad o departamento"
                      onChange={(event) => setMunicipalitySearch(event.target.value)}
                    />
                    <select value={municipalitySeedFilter} onChange={(event) => setMunicipalitySeedFilter(event.target.value)}>
                      <option value="all">Todas</option>
                      <option value="with-seeds">Con seed</option>
                      <option value="without-seeds">Sin seed</option>
                    </select>
                  </div>

                  <div className="developer-municipality-list">
                    {visibleMunicipalities.map((municipality) => (
                      <button
                        type="button"
                        key={municipality.id}
                        className={String(municipality.id) === String(currentMunicipality?.id) ? 'is-selected' : ''}
                        onClick={() => handleSelectMunicipality(municipality.id)}
                      >
                        <strong>{municipality.name}</strong>
                        <span>{municipality.department || 'Sin departamento'} · {municipality.seedCount || 0} seeds · {municipality.barrioCount || 0} barrios</span>
                      </button>
                    ))}
                  </div>

                  {currentMunicipality && (
                    <form className="developer-domain-form" onSubmit={handleSaveDomain}>
                      <div>
                        <strong>{currentMunicipality.name}</strong>
                        <span>{currentMunicipality.department || 'Paraguay'} · INE {currentMunicipality.ineCode || 's/d'}</span>
                      </div>
                      <label>
                        <span>Dominio oficial</span>
                        <input
                          value={domainForm.primaryDomain}
                          placeholder="www.municipalidad.gov.py"
                          onChange={(event) => setDomainForm({ primaryDomain: event.target.value })}
                        />
                      </label>
                      <button type="submit" className="admin-muni-primary-button" disabled={isBusy}>
                        Guardar dominio
                      </button>
                      <button type="button" className="admin-muni-ghost-button" disabled={!currentMunicipality} onClick={handleOpenCitiesView}>
                        Gestionar barrios
                      </button>
                    </form>
                  )}
                </article>

                <article className="developer-step developer-step-seeds">
                  <div className="developer-step-head">
                    <span>2</span>
                    <div>
                      <div className="developer-heading-row">
                        <h2>URLs semilla</h2>
                        <InfoHint title="Cómo funcionan las seeds y sus estados">
                          <p>
                            Cada seed define desde dónde arranca un crawl manual y hasta dónde puede explorar según
                            profundidad, páginas, PDFs, imágenes y vencimiento.
                          </p>
                          <ul className="developer-info-list">
                            <li><strong>Sin chequeo:</strong> la fuente todavía no fue revisada.</li>
                            <li><strong>Sin cambios:</strong> la revisión rápida no encontró diferencias relevantes.</li>
                            <li><strong>Cambiada:</strong> la fuente cambió y vale la pena correr un crawl manual.</li>
                            <li><strong>Vieja:</strong> el último chequeo quedó vencido y conviene revisarla de nuevo.</li>
                            <li><strong>Con error:</strong> hubo un problema al revisar la fuente.</li>
                          </ul>
                          <p>
                            El crawl manual solo se habilita cuando la seed está activa y su chequeo queda en
                            <strong> Cambiada</strong> o <strong>Sin cambios</strong>.
                          </p>
                        </InfoHint>
                      </div>
                      <p>Cargá una o más seeds para la municipalidad elegida y dejá listos sus límites antes de lanzar cualquier crawl.</p>
                    </div>
                  </div>

                  <p className="developer-step-note">
                    <strong>&#10003;</strong> revisa cambios primero. Cuando la seed quede en <strong>Cambiada</strong> o <strong>Sin cambios</strong>, recién se habilita la
                    flecha para lanzar el crawl manual. <strong>&times;</strong> borra la seed con confirmación.
                  </p>

                  <form className="developer-seed-form" onSubmit={handleCreateSeed}>
                    <label className="is-wide">
                      <span>URL semilla</span>
                      <input
                        value={seedForm.url}
                        placeholder={domainToSeedUrl(domainForm.primaryDomain) || 'https://...'}
                        onChange={(event) => setSeedForm((current) => ({ ...current, url: event.target.value }))}
                      />
                    </label>
                    <label>
                      <span>Profundidad</span>
                      <input type="number" min="0" max="8" value={seedForm.maxDepth} onChange={(event) => setSeedForm((current) => ({ ...current, maxDepth: Number(event.target.value) }))} />
                    </label>
                    <label>
                      <span>Páginas</span>
                      <input type="number" min="1" max="2000" value={seedForm.maxPages} onChange={(event) => setSeedForm((current) => ({ ...current, maxPages: Number(event.target.value) }))} />
                    </label>
                    <label>
                      <span>PDF</span>
                      <input type="number" min="0" max="1000" value={seedForm.maxPdfs} onChange={(event) => setSeedForm((current) => ({ ...current, maxPdfs: Number(event.target.value) }))} />
                    </label>
                    <label>
                      <span>Imágenes</span>
                      <input type="number" min="0" max="2000" value={seedForm.maxImages} onChange={(event) => setSeedForm((current) => ({ ...current, maxImages: Number(event.target.value) }))} />
                    </label>
                    <label>
                      <span>Días</span>
                      <input type="number" min="1" max="365" value={seedForm.staleAfterDays} onChange={(event) => setSeedForm((current) => ({ ...current, staleAfterDays: Number(event.target.value) }))} />
                    </label>
                    <button type="submit" className="admin-muni-primary-button" disabled={isBusy || !currentMunicipality}>
                      Agregar seed
                    </button>
                  </form>

                  <div className="developer-seed-list">
                    {seedUrls.length ? seedUrls.map((seed) => {
                      const health = sourceHealthById.get(String(seed.id)) || seed
                      const healthValue = health.health || seed.changeStatus || 'unknown'
                      const crawlEnabled = canExecuteSeedCrawl(seed, healthValue)
                      return (
                        <div className="developer-seed-row" key={seed.id}>
                          <div>
                            <div className="developer-row-title">
                              <strong>{seed.allowedHostname}</strong>
                              <span className={`admin-runtime-badge ${healthTone(healthValue)}`}>
                                {formatStatus(healthValue)}
                              </span>
                            </div>
                            <span>{seed.url}</span>
                            <small>prof. {seed.maxDepth} · {seed.maxPages} pag. · {seed.maxPdfs} PDF · vence {seed.staleAfterDays || 30} días</small>
                            <small>chequeo {formatDateTime(seed.lastCheckedAt)}{seed.checkError ? ` · ${seed.checkError}` : ''}</small>
                          </div>
                          <div className="developer-row-actions">
                            <button
                              type="button"
                              className="developer-icon-button is-danger"
                              title="Borrar esta seed"
                              aria-label="Borrar esta seed"
                              disabled={isBusy}
                              onClick={() => handleDeleteSeed(seed)}
                            >
                              &times;
                            </button>
                            <button
                              type="button"
                              className="developer-icon-button"
                              title="Revisar cambios de esta fuente"
                              aria-label="Revisar cambios de esta fuente"
                              disabled={isBusy}
                              onClick={() => handleCheckSeed(seed.id)}
                            >
                              &#10003;
                            </button>
                            <button
                              type="button"
                              className="developer-icon-button"
                              title={crawlEnabled
                                ? spiderReadyForJobs
                                  ? 'Ejecutar crawl manual para esta seed'
                                  : 'La seed ya está lista. Si el spider está apagado, al hacer click te lo voy a avisar.'
                                : 'Primero revisá cambios y dejá la fuente en Cambiada o Sin cambios'}
                              aria-label="Ejecutar crawl manual para esta seed"
                              disabled={isBusy || !crawlEnabled}
                              onClick={() => handleStartCrawl(seed.id)}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e3e3e3"><path d="m560-240-56-58 142-142H160v-80h486L504-662l56-58 240 240-240 240Z"/></svg>
                            </button>
                            
                          </div>
                        </div>
                      )
                    }) : (
                      <p className="admin-runtime-message">Esta municipalidad todavía no tiene seeds.</p>
                    )}
                  </div>
                </article>

                <article className="developer-step developer-step-queue">
                  <div className="developer-step-head">
                    <span>3</span>
                    <div>
                      <div className="developer-heading-row">
                        <h2>Jobs y cola de ejecución</h2>
                        <InfoHint title="Qué significan los estados de la cola">
                          <ul className="developer-info-list">
                            <li><strong>En cola:</strong> el job ya fue creado y espera turno.</li>
                            <li><strong>Ejecutando:</strong> el spider está recorriendo fuentes o descargando assets.</li>
                            <li><strong>Completado:</strong> el crawl terminó y ya podés abrir el detalle.</li>
                            <li><strong>Error:</strong> el job cortó por una falla técnica o de configuración.</li>
                            <li><strong>Cancelado:</strong> alguien lo detuvo manualmente.</li>
                          </ul>
                          <p>
                            Desde acá ves el historial por municipalidad y elegís qué job abrir para revisar páginas, assets
                            e items generados.
                          </p>
                        </InfoHint>
                      </div>
                      <p>Primero prendé el spider. Después lanzá el crawl desde una seed lista y seguí el job desde esta misma cola.</p>
                    </div>
                    <button type="button" className="admin-muni-ghost-button is-compact" disabled={isBusy} onClick={() => refreshRagState(currentMunicipality?.id)}>
                      Actualizar
                    </button>
                  </div>

                  <div className="developer-spider-launchpad">
                    <article className="developer-spider-launch-card developer-spider-launch-card-guide">
                      <strong>Secuencia corta para lanzar y seguir jobs</strong>
                      <p>
                        1. En la seed tocá <strong>✓</strong> para revisar cambios.
                        2. Si queda <strong>Cambiada</strong> o <strong>Sin cambios</strong>, tocá la <strong>flecha</strong> para crear el job.
                        3. Seguí abajo ese job para abrir páginas, assets e ítems.
                      </p>
                      <div className="developer-results-metrics">
                        <span>Jobs activos <strong>{spiderActivity.length}</strong></span>
                        <span>Municipalidad <strong>{currentMunicipality?.name || 'Sin selección'}</strong></span>
                        <span>Seeds visibles <strong>{seedUrls.length}</strong></span>
                      </div>
                    </article>
                  </div>

                  <div className="developer-job-list">
                    {jobs.length ? jobs.map((job) => (
                      <div
                        className={`developer-job-row ${String(job.id) === String(detailJobId || jobResults.jobId) ? 'is-selected' : ''}`}
                        key={job.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => handleViewJobResults(job)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            handleViewJobResults(job)
                          }
                        }}
                      >
                        <span className={`admin-runtime-badge ${healthTone(job.status)}`}>{formatStatus(job.status)}</span>
                        <strong>Job #{job.id}</strong>
                        <small>{describeJobActivity(job)}</small>
                        <small className="developer-job-url">{job.stats?.currentUrl || job.stats?.currentAssetUrl || 'Sin URL activa.'}</small>
                        <small>Duracion {formatDuration(job.startedAt || job.createdAt, job.finishedAt)} - actualizacion {formatDateTime(job.stats?.lastEventAt || job.updatedAt)}</small>
                        <span>{job.errorCode || formatJobStats(job)}</span>
                        <small>{formatDateTime(job.startedAt || job.createdAt)}</small>
                        <div className="developer-row-actions">
                          <button
                            type="button"
                            className="admin-muni-ghost-button is-compact"
                            disabled={isBusy}
                            onClick={(event) => {
                              event.stopPropagation()
                              handleViewJobResults(job)
                            }}
                          >
                            Ver detalle
                          </button>
                          {['queued', 'running'].includes(job.status) ? (
                            <button
                              type="button"
                              className="admin-muni-ghost-button is-danger is-compact"
                              disabled={isBusy}
                              onClick={(event) => {
                                event.stopPropagation()
                                void handleCancelJob(job.id)
                              }}
                            >
                              Cancelar
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="admin-muni-ghost-button is-danger is-compact"
                              disabled={isBusy}
                              onClick={(event) => {
                                event.stopPropagation()
                                void handleDeleteJob(job)
                              }}
                            >
                              Borrar job
                            </button>
                          )}
                        </div>
                      </div>
                    )) : (
                      <p className="admin-runtime-message">Sin jobs para esta municipalidad.</p>
                    )}
                  </div>
                </article>
              </section>
              </section>
              )}

              {isJobDetailView && (
              <section className="developer-results-board">
                <div className="developer-results-head">
                  <div>
                    <div className="developer-heading-row">
                      <span className="admin-muni-eyebrow">Detalle del job</span>
                      <InfoHint title="Como leer este detalle">
                        <p>
                          El detalle separa el resultado del crawl en paginas, assets e items indexados para que puedas auditar
                          que encontro el spider antes de pasar a curation o reindexacion.
                        </p>
                        <p>
                          La tabla muestra fecha, fuente, profundidad o tipo técnico, hash o estado y archivo o resumen
                          disponible para cada registro.
                        </p>
                      </InfoHint>
                    </div>
                    <h2>{selectedJob ? `Job #${selectedJob.id}` : 'Seleccioná un job'}</h2>
                    <p>
                      {selectedJob
                        ? `${formatStatus(selectedJob.status)} - ${describeJobActivity(selectedJob)}`
                        : 'Hacé clic en un job para ver la tabla de páginas, assets e ítems generados por el spider.'}
                    </p>
                  </div>
                  {selectedJob ? (
                    <div className="developer-results-summary">
                      <span className={`admin-runtime-badge ${healthTone(selectedJob.status)}`}>{formatStatus(selectedJob.status)}</span>
                      <small>{formatJobStats(selectedJob)}</small>
                      {!['queued', 'running'].includes(selectedJob.status) ? (
                        <button
                          type="button"
                          className="admin-muni-ghost-button is-danger is-compact"
                          disabled={isBusy}
                          onClick={() => handleDeleteJob(selectedJob)}
                        >
                          Borrar job
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {jobResults.jobId ? (
                  <>
                    <div className="developer-result-tabs">
                      {resultTabs.map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          className={jobResults.type === tab.id ? 'is-active' : ''}
                          disabled={jobResults.status === 'loading'}
                          onClick={() => handleChangeJobResultType(tab.id)}
                        >
                          {tab.label} <strong>{tab.count}</strong>
                        </button>
                      ))}
                    </div>

                    {jobResults.status === 'error' ? (
                      <p className="admin-runtime-message is-error">{jobResults.error}</p>
                    ) : jobResults.status === 'loading' && !jobResults.data ? (
                      <p className="admin-runtime-message">Cargando resultados del job...</p>
                    ) : (
                      <>
                        <div className="developer-results-metrics">
                          <span>Páginas {jobResults.data?.summary?.pages || 0}</span>
                          <span>Assets {jobResults.data?.summary?.assets || 0}</span>
                          <span>PDF {jobResults.data?.summary?.pdfs || 0}</span>
                          <span>Imágenes {jobResults.data?.summary?.images || 0}</span>
                          <span>Items {jobResults.data?.summary?.items || 0}</span>
                        </div>
                        <div className="developer-results-table-wrap">
                          <table className="developer-results-table">
                            <thead>
                              <tr>
                                <th>Fecha</th>
                                <th>{jobResults.type === 'items' ? 'Contenido' : 'Fuente'}</th>
                                <th>{jobResults.type === 'pages' ? 'HTTP / depth' : jobResults.type === 'assets' ? 'Peso / tipo' : 'Tipo / versión'}</th>
                                <th>Hash / estado</th>
                                <th>Archivos / resumen</th>
                              </tr>
                            </thead>
                            <tbody>
                              {renderJobResultRowsTable()}
                            </tbody>
                          </table>
                        </div>
                        <div className="developer-results-pagination">
                          <small>
                            Página {jobResults.data?.result?.page || 1} de {jobResults.data?.result?.totalPages || 1}
                          </small>
                          <div className="developer-row-actions">
                            <button type="button" className="admin-muni-ghost-button is-compact" disabled={(jobResults.data?.result?.page || 1) <= 1} onClick={() => handleChangeJobResultPage('prev')}>
                              Anterior
                            </button>
                            <button type="button" className="admin-muni-ghost-button is-compact" disabled={(jobResults.data?.result?.page || 1) >= (jobResults.data?.result?.totalPages || 1)} onClick={() => handleChangeJobResultPage('next')}>
                              Siguiente
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <p className="admin-runtime-message">Todavía no seleccionaste un job.</p>
                )}
              </section>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}

export default DeveloperPage




