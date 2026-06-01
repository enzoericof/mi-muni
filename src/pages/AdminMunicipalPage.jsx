import { useEffect, useMemo, useRef, useState } from 'react'
import AdminMunicipalAnalytics from '../components/adminMunicipal/AdminMunicipalAnalytics'
import AdminMunicipalIncidentDetail from '../components/adminMunicipal/AdminMunicipalIncidentDetail'
import AdminMunicipalLoginGate from '../components/adminMunicipal/AdminMunicipalLoginGate'
import AdminMunicipalQueue from '../components/adminMunicipal/AdminMunicipalQueue'
import AuthMenu from '../components/layout/AuthMenu'
import Header from '../components/layout/Header'
import MunicipalitySelector from '../components/layout/MunicipalitySelector'
import PotholesMap from '../components/map/PotholesMap'
import {
  fetchPotholeAdminDashboard,
  fetchPotholeAdminReports,
  fetchPotholeReportById,
  updatePotholeAdminReport,
} from '../lib/api'
import { useAppContext } from '../lib/AppContext'
import {
  POTHOLE_TYPE_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  buildBarrioRanking,
  buildDistribution,
  buildIncidentBarrioRanking,
  buildIncidentSummary,
  buildSummary,
  clusterReportsIntoIncidents,
  formatDateTime,
} from '../lib/adminMunicipalUtils'
import { makeNavigate, navigation } from '../lib/navigation'
import { getUserRoles, userHasRole } from '../lib/roles'
import { useHashRoute } from '../lib/router'

const SEVERITY_RISK = { alta: 58, media: 36, baja: 18 }
const TYPE_RISK = {
  bache_aislado: 10,
  conjunto_de_baches: 18,
  hundimiento_o_rotura_grande: 28,
}

const PRIORITY_ORDER = { alta: 3, media: 2, baja: 1 }
const LEVEL_ORDER = { alto: 3, medio: 2, bajo: 1 }

const ADMIN_MODULES = [
  { id: 'general', label: 'General' },
  { id: 'munita', label: 'Munita' },
  { id: 'basura', label: 'Basura' },
  { id: 'baches', label: 'Baches' },
]

const BACHES_VIEWS = [
  { id: 'general', label: 'General' },
  { id: 'cola', label: 'Análisis Individual' },
  { id: 'detalle', label: 'Análisis Zonal', disabled: true },
]

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function toImpactLevel(score) {
  if (score >= 70) return 'alto'
  if (score >= 40) return 'medio'
  return 'bajo'
}

function toRiskLevel(score) {
  if (score >= 70) return 'alto'
  if (score >= 40) return 'medio'
  return 'bajo'
}

function matchesIncidentStatusFilter(incident, filterValue) {
  if (!filterValue) return true
  if (filterValue === 'abierto') return !['resuelto', 'descartado'].includes(incident.status)
  if (filterValue === 'resuelto') return incident.status === 'resuelto'
  return incident.status === filterValue
}

function buildIncidentDrafts(incidents) {
  return Object.fromEntries(
    incidents.map((incident) => [
      incident.incidentId,
      {
        status: incident.status,
        priorityBand: incident.priorityBand,
      },
    ]),
  )
}

function sortIncidents(incidents, sortBy = 'priority') {
  return [...incidents].sort((left, right) => {
    const leftClosed = ['resuelto', 'descartado'].includes(left.status) ? 1 : 0
    const rightClosed = ['resuelto', 'descartado'].includes(right.status) ? 1 : 0
    if (leftClosed !== rightClosed) return leftClosed - rightClosed

    if (sortBy === 'impact') {
      const impactDiff = (LEVEL_ORDER[right.impactLevel] || 0) - (LEVEL_ORDER[left.impactLevel] || 0)
      if (impactDiff !== 0) return impactDiff
      const impactScoreDiff = Number(right.impactScore || 0) - Number(left.impactScore || 0)
      if (impactScoreDiff !== 0) return impactScoreDiff
    } else if (sortBy === 'risk') {
      const riskDiff = (LEVEL_ORDER[right.riskLevel] || 0) - (LEVEL_ORDER[left.riskLevel] || 0)
      if (riskDiff !== 0) return riskDiff
      const riskScoreDiff = Number(right.riskScore || 0) - Number(left.riskScore || 0)
      if (riskScoreDiff !== 0) return riskScoreDiff
    } else {
      const priorityDiff = (PRIORITY_ORDER[right.priorityBand] || 0) - (PRIORITY_ORDER[left.priorityBand] || 0)
      if (priorityDiff !== 0) return priorityDiff
      const priorityScoreDiff = Number(right.priorityScore || 0) - Number(left.priorityScore || 0)
      if (priorityScoreDiff !== 0) return priorityScoreDiff
    }

    const fallbackPriorityDiff = (PRIORITY_ORDER[right.priorityBand] || 0) - (PRIORITY_ORDER[left.priorityBand] || 0)
    if (fallbackPriorityDiff !== 0) return fallbackPriorityDiff

    const fallbackImpactDiff = (LEVEL_ORDER[right.impactLevel] || 0) - (LEVEL_ORDER[left.impactLevel] || 0)
    if (fallbackImpactDiff !== 0) return fallbackImpactDiff

    const fallbackRiskDiff = (LEVEL_ORDER[right.riskLevel] || 0) - (LEVEL_ORDER[left.riskLevel] || 0)
    if (fallbackRiskDiff !== 0) return fallbackRiskDiff

    const confirmationDiff = Number(right.confirmationCount || 0) - Number(left.confirmationCount || 0)
    if (confirmationDiff !== 0) return confirmationDiff

    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  })
}

function enrichIncidents(reports = []) {
  return clusterReportsIntoIncidents(reports).map((incident) => {
    const incidentReports = reports.filter((report) => incident.relatedReportIds.includes(report.id))
    const impactScore = clamp((incident.reportCount * 14) + (incident.confirmationCount * 18), 0, 100)
    const riskScore = clamp(
      (SEVERITY_RISK[incident.reportedSeverity] || SEVERITY_RISK.media) + (TYPE_RISK[incident.potholeType] || TYPE_RISK.bache_aislado),
      0,
      100,
    )

    return {
      ...incident,
      riskScore,
      riskLevel: toRiskLevel(riskScore),
      impactScore,
      impactLevel: toImpactLevel(impactScore),
      relatedReports: incidentReports,
    }
  })
}

function buildTrendSeries(reports = []) {
  const now = new Date()
  const months = []

  for (let offset = 5; offset >= 0; offset -= 1) {
    const cursor = new Date(now.getFullYear(), now.getMonth() - offset, 1)
    months.push({
      key: `${cursor.getFullYear()}-${cursor.getMonth()}`,
      label: cursor.toLocaleDateString('es-PY', { month: 'short' }),
      total: 0,
    })
  }

  const monthMap = new Map(months.map((month) => [month.key, month]))
  for (const report of reports) {
    const date = new Date(report.createdAt)
    const key = `${date.getFullYear()}-${date.getMonth()}`
    const bucket = monthMap.get(key)
    if (bucket) bucket.total += 1
  }

  return months
}

function computeAverageResolutionHours(reports = []) {
  const resolvedReports = reports.filter((report) => report.status === 'resuelto' && report.latestStatusAt)
  if (!resolvedReports.length) return null

  const hours = resolvedReports.reduce((sum, report) => {
    const createdAt = new Date(report.createdAt).getTime()
    const resolvedAt = new Date(report.latestStatusAt).getTime()
    if (!Number.isFinite(createdAt) || !Number.isFinite(resolvedAt) || resolvedAt <= createdAt) return sum
    return sum + ((resolvedAt - createdAt) / (1000 * 60 * 60))
  }, 0)

  return Math.round(hours / resolvedReports.length)
}

function getInitials(name) {
  if (!name) return '?'
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('')
}

function AdminMunicipalAccountMenu({ onGoToPublic, onLogout, user }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const handleClick = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div className="auth-menu" ref={containerRef}>
      <button
        type="button"
        className="auth-menu-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="auth-avatar" aria-hidden="true">{getInitials(user?.name)}</span>
        <span className="auth-name">Hola, {user?.name?.split(' ')[0] || 'Admin'}</span>
        <span className="auth-caret" aria-hidden="true">{'\u25be'}</span>
      </button>

      {open ? (
        <div className="auth-menu-popover" role="menu">
          <div className="auth-menu-header">
            <strong>{user?.name || 'Administración Municipal'}</strong>
            <small>{user?.email || ''}</small>
            {getUserRoles(user).length ? <small>Roles: {getUserRoles(user).join(', ')}</small> : null}
          </div>

          <button
            type="button"
            className="auth-menu-item"
            onClick={() => {
              onGoToPublic()
              setOpen(false)
            }}
            role="menuitem"
          >
            Ver vista pública
          </button>

          <button
            type="button"
            className="auth-menu-item"
            onClick={async () => {
              await onLogout()
              setOpen(false)
            }}
            role="menuitem"
          >
            Cerrar sesión
          </button>
        </div>
      ) : null}
    </div>
  )
}

function FocusCard({ incidents, selectedIncidentId, onSelectIncident }) {
  const topCritical = incidents.slice(0, 5)

  return (
    <section className="admin-muni-side-card admin-muni-focus-card">
      <div className="admin-muni-card-head compact">
        <div>
          <span className="admin-muni-kicker">Vista 2</span>
          <h3>Top criticos</h3>
        </div>
      </div>

      <div className="admin-muni-status-bars">
        {topCritical.length ? (
          topCritical.map((incident) => (
            <button
              key={incident.incidentId}
              type="button"
              className={`admin-muni-focus-entry ${selectedIncidentId === incident.incidentId ? 'is-selected' : ''}`}
              onClick={() => onSelectIncident(incident.incidentId)}
            >
              <div className="admin-muni-status-bar">
                <div>
                  <strong>{incident.barrioLabel}</strong>
                  <span>{incident.priorityScore}</span>
                </div>
                <div className="admin-muni-status-track">
                  <span style={{ width: `${incident.priorityScore}%` }} />
                </div>
              </div>
              <div className="admin-muni-focus-meta">
                <span>{POTHOLE_TYPE_LABELS[incident.potholeType] || 'Bache'}</span>
                <span>{incident.confirmationCount} confirmaciones</span>
              </div>
            </button>
          ))
        ) : (
          <div className="admin-muni-empty-block">No hay incidencias críticas para priorizar.</div>
        )}
      </div>
    </section>
  )
}

function MapFoot({ incidents }) {
  const resolved = incidents.filter((incident) => incident.status === 'resuelto').length
  const pending = incidents.filter((incident) => incident.status !== 'resuelto' && incident.status !== 'descartado').length

  return (
    <div className="admin-muni-map-foot">
      <div className="admin-muni-map-footer">
        <div className="admin-muni-map-legend">
          <div className="admin-muni-map-legend-item">
            <span className="admin-muni-status-dot is-pending" />
            Pendientes: {pending}
          </div>
          <div className="admin-muni-map-legend-item">
            <span className="admin-muni-status-dot is-resolved" />
            Resueltos: {resolved}
          </div>
        </div>
        <span className="admin-muni-inline-message">El mapa operativo usa lectura por prioridad y abre detalle sin exponer la UX publica.</span>
      </div>
    </div>
  )
}

function InsightsCard({ averageResolutionHours, incidents, ranking, reports, trendSeries }) {
  const peakMonth = [...trendSeries].sort((left, right) => right.total - left.total)[0]
  const criticalZone = ranking[0]
  const openIncidents = incidents.filter((incident) => !['resuelto', 'descartado'].includes(incident.status))
  const oldestOpenIncident = [...openIncidents].sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  )[0]
  const barMax = Math.max(...trendSeries.map((item) => item.total), 1)

  return (
    <section className="admin-muni-side-card admin-muni-insights-card">
      <div className="admin-muni-card-head compact">
        <div>
          <span className="admin-muni-kicker">Vista 8</span>
          <h3>Insights</h3>
        </div>
      </div>

      <div className="admin-muni-insights-grid">
        <article className="admin-muni-detail-block">
          <strong>Zona crítica</strong>
          <span>{criticalZone ? `${criticalZone.label} (${criticalZone.count} reportes)` : 'Sin datos suficientes.'}</span>
        </article>
        <article className="admin-muni-detail-block">
          <strong>Tendencia</strong>
          <span>{peakMonth ? `${peakMonth.label}: ${peakMonth.total} reportes` : 'Sin actividad reciente.'}</span>
        </article>
        <article className="admin-muni-detail-block">
          <strong>Resolución promedio</strong>
          <span>{averageResolutionHours !== null ? `${averageResolutionHours} h` : 'Todavía no hay resueltos.'}</span>
        </article>
        <article className="admin-muni-detail-block">
          <strong>Incidencia más antigua</strong>
          <span>{oldestOpenIncident ? formatDateTime(oldestOpenIncident.createdAt) : 'No hay baches abiertos.'}</span>
        </article>
      </div>

      <div className="admin-muni-trend-mini">
        {trendSeries.map((item) => (
          <div key={item.key} className="admin-muni-trend-mini-bar">
            <span style={{ height: `${Math.max(12, Math.round((item.total / barMax) * 100))}%` }} />
            <small>{item.label}</small>
          </div>
        ))}
      </div>

      <p className="admin-muni-inline-message">
        {reports.length
          ? 'Esta lectura mezcla volumen, riesgo y resolución para ayudarte a decidir por dónde arrancar.'
          : 'Cuando entren reportes, acá vas a ver zonas críticas, tendencia temporal y tiempo promedio de resolución.'}
      </p>
    </section>
  )
}

function AdvancedActionsCard({ incident, onDiscard, savingId }) {
  const isSaving = incident && savingId === incident.incidentId

  return (
    <section className="admin-muni-side-card admin-muni-advanced-card">
      <div className="admin-muni-card-head compact">
        <div>
          <span className="admin-muni-kicker">Vista 7</span>
          <h3>Acciones avanzadas</h3>
        </div>
      </div>

      {!incident ? (
        <div className="admin-muni-empty-block">Seleccioná una incidencia para ver acciones operativas.</div>
      ) : (
        <>
          <div className="admin-muni-advanced-actions">
            <button type="button" className="admin-shell-header-button is-danger" disabled={isSaving} onClick={onDiscard}>
              {isSaving ? 'Guardando...' : 'Marcar como falso'}
            </button>
            <button type="button" className="admin-shell-header-button" disabled>
              Merge manual
            </button>
            <button type="button" className="admin-shell-header-button" disabled>
              Split
            </button>
            <button type="button" className="admin-shell-header-button" disabled>
              Asignar (futuro)
            </button>
          </div>

          <p className="admin-muni-inline-message">
            La operativa visible ya deja preparada la capa de acciones avanzadas. Hoy queda activa la opción de descarte.
          </p>
        </>
      )}
    </section>
  )
}

function BachesFiltersCard({ barrioOptions, filters, onFilterChange, queueSort, setQueueSort }) {
  return (
    <section className="admin-muni-queue-card admin-ops-card">
      <div className="admin-muni-card-head compact">
        <div>
          <span className="admin-muni-kicker">Vista 5</span>
          <h3>Filtros operativos</h3>
        </div>
      </div>

      <div className="admin-muni-filter-row admin-muni-filter-row-wide">
        <label>
          <span>Estado</span>
          <select value={filters.status} onChange={(event) => onFilterChange({ status: event.target.value })}>
            <option value="">Todos</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>

        <label>
          <span>Prioridad</span>
          <select value={filters.priorityBand} onChange={(event) => onFilterChange({ priorityBand: event.target.value })}>
            <option value="">Todas</option>
            {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>

        <label>
          <span>Barrio</span>
          <select value={filters.barrioSlug} onChange={(event) => onFilterChange({ barrioSlug: event.target.value })}>
            <option value="">Todos</option>
            {barrioOptions.map((item) => (
              <option key={item.slug} value={item.slug}>{item.label}</option>
            ))}
          </select>
        </label>

        <label>
          <span>Impacto</span>
          <select value={filters.impactLevel} onChange={(event) => onFilterChange({ impactLevel: event.target.value })}>
            <option value="">Todos</option>
            <option value="alto">Alto</option>
            <option value="medio">Medio</option>
            <option value="bajo">Bajo</option>
          </select>
        </label>

        <label>
          <span>Orden</span>
          <select value={queueSort} onChange={(event) => setQueueSort(event.target.value)}>
            <option value="priority_desc">Prioridad desc</option>
            <option value="impact_desc">Impacto desc</option>
            <option value="confirmations_desc">Confirmaciones desc</option>
            <option value="date_desc">Fecha desc</option>
            <option value="date_asc">Fecha asc</option>
          </select>
        </label>
      </div>
    </section>
  )
}

function PlaceholderSection({ kicker, title, body, cta }) {
  return (
    <section className="admin-muni-surface admin-muni-placeholder-card">
      <span className="admin-muni-kicker">{kicker}</span>
      <h2>{title}</h2>
      <p>{body}</p>
      {cta ? <span className="admin-muni-chip">{cta}</span> : null}
    </section>
  )
}

function AdminMunicipalPage() {
  const { user, sessionId: appSessionId, openLoginModal, municipality } = useAppContext()
  const { navigate } = useHashRoute()
  const handleNavigate = makeNavigate(navigate)

  const [session, setSession] = useState(null)
  const [status, setStatus] = useState('booting')
  const [message, setMessage] = useState('')
  const [dashboard, setDashboard] = useState(null)
  const [reports, setReports] = useState([])
  const [filters, setFilters] = useState({
    status: '',
    priorityBand: '',
    barrioSlug: '',
    impactLevel: '',
    riskLevel: '',
  })
  const [drafts, setDrafts] = useState({})
  const [loadingReports, setLoadingReports] = useState(false)
  const [savingId, setSavingId] = useState(null)
  const [generalSelectedIncidentId, setGeneralSelectedIncidentId] = useState(null)
  const [queueSelectedIncidentId, setQueueSelectedIncidentId] = useState(null)
  const [queueSort, setQueueSort] = useState('priority')
  const [detailStatus, setDetailStatus] = useState('idle')
  const [selectedIncidentDetail, setSelectedIncidentDetail] = useState(null)
  const [activeModule, setActiveModule] = useState('baches')
  const [activeBachesView, setActiveBachesView] = useState('general')

  useEffect(() => {
    if (!userHasRole(user, 'admin')) {
      setSession(null)
      setStatus('idle')
      setMessage(user ? 'Tu usuario no tiene permisos de administrador.' : 'Iniciá sesión como administrador para gestionar cambios.')
      return
    }

    const appSession = {
      sessionId: appSessionId ? `app:${appSessionId}` : '',
      expiresAt: null,
      createdBy: user.email,
    }
    setSession(appSession)
    void refreshMunicipalState(appSession.sessionId, { silent: false })
  }, [appSessionId, municipality?.key, user])

  const allIncidents = useMemo(() => enrichIncidents(reports), [reports])

  const incidents = useMemo(() => {
    const statusFiltered = allIncidents.filter((incident) => matchesIncidentStatusFilter(incident, filters.status))
    const priorityFiltered = filters.priorityBand
      ? statusFiltered.filter((incident) => incident.priorityBand === filters.priorityBand)
      : statusFiltered
    const impactFiltered = filters.impactLevel
      ? priorityFiltered.filter((incident) => incident.impactLevel === filters.impactLevel)
      : priorityFiltered
    const riskFiltered = filters.riskLevel
      ? impactFiltered.filter((incident) => toRiskLevel(incident.riskScore) === filters.riskLevel)
      : impactFiltered
    const barrioFiltered = filters.barrioSlug
      ? riskFiltered.filter((incident) => incident.barrioSlug === filters.barrioSlug)
      : riskFiltered
    return sortIncidents(barrioFiltered, queueSort)
  }, [allIncidents, filters.barrioSlug, filters.impactLevel, filters.priorityBand, filters.riskLevel, filters.status, queueSort])

  const reportSummary = dashboard?.summary || buildSummary(reports)
  const incidentSummary = useMemo(() => buildIncidentSummary(allIncidents), [allIncidents])
  const ranking = useMemo(() => buildBarrioRanking(reports), [reports])
  const incidentRanking = useMemo(() => buildIncidentBarrioRanking(allIncidents), [allIncidents])
  const distribution = useMemo(() => buildDistribution(incidentSummary.priority), [incidentSummary.priority])
  const totalConfirmations = reports.reduce((sum, report) => sum + Number(report.confirmationCount || 0), 0)
  const trendSeries = useMemo(() => buildTrendSeries(reports), [reports])
  const averageResolutionHours = useMemo(() => computeAverageResolutionHours(reports), [reports])

  const barrioOptions = useMemo(
    () =>
      [...new Map(reports.map((report) => [report.barrioSlug, { slug: report.barrioSlug, label: report.barrioLabel }])).values()]
        .filter((item) => item.slug)
        .sort((left, right) => left.label.localeCompare(right.label, 'es')),
    [reports],
  )

  const generalSelectedIncident = allIncidents.find((incident) => incident.incidentId === generalSelectedIncidentId) || null
  const queueSelectedIncident = incidents.find((incident) => incident.incidentId === queueSelectedIncidentId) || null
  const selectedIncident = activeBachesView === 'general'
    ? generalSelectedIncident
    : (queueSelectedIncident || generalSelectedIncident)
  const detailIncident = activeBachesView === 'general'
    ? queueSelectedIncident
    : selectedIncident

  useEffect(() => {
    setDrafts(buildIncidentDrafts(incidents))
  }, [incidents])

  useEffect(() => {
    if (!allIncidents.length) {
      setGeneralSelectedIncidentId(null)
      setQueueSelectedIncidentId(null)
      setSelectedIncidentDetail(null)
      return
    }
  }, [allIncidents])

  useEffect(() => {
    if (generalSelectedIncidentId == null) return
    if (allIncidents.some((incident) => incident.incidentId === generalSelectedIncidentId)) return

    setGeneralSelectedIncidentId(null)
  }, [allIncidents, generalSelectedIncidentId])

  useEffect(() => {
    if (queueSelectedIncidentId == null) return
    if (incidents.some((incident) => incident.incidentId === queueSelectedIncidentId)) return

    setQueueSelectedIncidentId(null)
    setSelectedIncidentDetail(null)
  }, [incidents, queueSelectedIncidentId])

  useEffect(() => {
    if (!detailIncident?.primaryReportId) {
      setSelectedIncidentDetail(null)
      setDetailStatus('idle')
      return
    }

    let cancelled = false
    setDetailStatus('loading')

    async function loadDetail() {
      try {
        const relatedReportIds = Array.isArray(detailIncident.relatedReportIds) && detailIncident.relatedReportIds.length
          ? detailIncident.relatedReportIds
          : [detailIncident.primaryReportId]

        const relatedDetails = await Promise.all(
          relatedReportIds.map((reportId) => fetchPotholeReportById(reportId)),
        )

        const primaryDetail =
          relatedDetails.find((detail) => detail?.id === detailIncident.primaryReportId) ||
          relatedDetails[0] ||
          null

        const mergedHistory = relatedDetails
          .flatMap((detail) =>
            (detail?.history || []).map((entry) => ({
              ...entry,
              reportId: detail?.id,
            })),
          )
          .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())

        const mergedImages = relatedDetails.flatMap((detail) => detail?.images || [])
        const mergedConfirmations = relatedDetails
          .flatMap((detail) =>
            (detail?.confirmations || []).map((confirmation) => ({
              ...confirmation,
              reportId: detail?.id,
            })),
          )
          .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())

        const detail = primaryDetail
          ? {
              ...primaryDetail,
              history: mergedHistory,
              images: mergedImages,
              confirmations: mergedConfirmations,
            }
          : null

        if (cancelled) return
        setSelectedIncidentDetail(detail)
        setDetailStatus('ready')
      } catch (_error) {
        if (cancelled) return
        setSelectedIncidentDetail(null)
        setDetailStatus('error')
      }
    }

    void loadDetail()
    return () => {
      cancelled = true
    }
  }, [detailIncident?.primaryReportId, detailIncident?.relatedReportIds])

  async function refreshMunicipalState(sessionId = session?.sessionId, options = {}) {
    const normalizedSessionId = String(sessionId || '').trim()
    if (!normalizedSessionId) {
      setSession(null)
      setDashboard(null)
      setReports([])
      setDrafts({})
      setGeneralSelectedIncidentId(null)
      setQueueSelectedIncidentId(null)
      setStatus('idle')
      setMessage('Iniciá sesión para usar este panel.')
      return null
    }

    setLoadingReports(true)
    if (!options.silent) {
      setStatus('loading')
      setMessage('')
    }

    try {
      const [nextDashboard, nextReports] = await Promise.all([
        fetchPotholeAdminDashboard(normalizedSessionId, {
          municipalitySlug: municipality?.key || '',
        }),
        fetchPotholeAdminReports(normalizedSessionId, {
          municipalitySlug: municipality?.key || '',
        }),
      ])

      setDashboard(nextDashboard)
      setReports(nextReports)
      setStatus('ready')
      setMessage(
        options.silent
          ? 'Panel actualizado.'
          : 'Panel municipal actualizado correctamente.',
      )
      return { sessionId: normalizedSessionId }
    } catch (error) {
      const isInvalidSession =
        error?.status === 401 &&
        ['collection-admin-session-invalid', 'collection-admin-session-required', 'auth-session-required', 'auth-session-invalid'].includes(error?.code)

      if (!isInvalidSession) {
        setStatus('error')
        setMessage('No se pudo actualizar el panel. Probá de nuevo.')
        return null
      }

      setSession(null)
      setDashboard(null)
      setReports([])
      setDrafts({})
      setGeneralSelectedIncidentId(null)
      setQueueSelectedIncidentId(null)
      setStatus('error')
      setMessage('La sesión no es válida o ya venció. Iniciá sesión nuevamente.')
      return null
    } finally {
      setLoadingReports(false)
    }
  }

  async function handleSaveIncident(incident, nextValues) {
    if (!session?.sessionId || !incident) return

    setSavingId(incident.incidentId)
    setMessage('')

    try {
      const updatedReports = await Promise.all(
        incident.relatedReportIds.map((reportId) =>
          updatePotholeAdminReport({
            adminSession: session.sessionId,
            reportId,
            status: nextValues.status,
            priorityBand: nextValues.priorityBand,
            changedBy: session.createdBy || 'admin-muni',
          }),
        ),
      )

      setReports((current) => current.map((report) => updatedReports.find((updated) => updated.id === report.id) || report))
      setMessage('Incidencia actualizada.')
    } catch (_error) {
      setMessage('No se pudo actualizar la incidencia.')
    } finally {
      setSavingId(null)
    }
  }

  const isAuthenticated = Boolean(session?.sessionId)

  if (!isAuthenticated) {
    return (
      <AdminMunicipalLoginGate
        message={message}
        navigation={navigation}
        onLoginClick={() => openLoginModal('Usa el acceso rapido de Administrador.')}
        onNavigate={handleNavigate}
        user={user}
      />
    )
  }

  return (
    <div className="municipal-app admin-muni-theme-light">
      <Header
        activeSection={activeModule}
        navigation={navigation}
        onNavigate={handleNavigate}
        adminShell
        adminNavigation={ADMIN_MODULES}
        onAdminNavigate={setActiveModule}
        adminActions={
          <>
            <MunicipalitySelector />
            <AuthMenu />
          </>
        }
      />

      <main className="page-shell page-shell-admin-muni">
        <div className="admin-muni-shell">
          <section className="ops-panel-title" aria-label="Titulo del panel administrador">
            <h1>Panel Administrador</h1>
          </section>

          {activeModule === 'general' ? (
            <PlaceholderSection
              kicker="General"
              title="Módulo general del panel"
              body="La vista general del panel se implementará en la siguiente etapa."
              cta="Siguiente etapa"
            />
          ) : null}

          {activeModule === 'munita' ? (
            <PlaceholderSection
              kicker="Munita"
              title="Módulo interno para el asistente municipal"
              body="Este espacio queda reservado para analytics, supervisiones y ajustes de Munita. La idea es que también viva como módulo del panel, no como salida al frente público."
              cta="Siguiente etapa"
            />
          ) : null}

          {activeModule === 'basura' ? (
            <PlaceholderSection
              kicker="Basura"
              title="Módulo interno de recolección"
              body="Acá deberían vivir métricas, rutas, incidencias y analítica de basura. La navegación superior ya está preparada para administrarlo como módulo del panel municipal."
              cta="Pendiente de integración"
            />
          ) : null}

          {activeModule === 'baches' ? (
            <div className="admin-muni-dashboard">

              {activeBachesView === 'general' ? (
                <div className="admin-muni-dashboard">
                  <AdminMunicipalAnalytics
                    distribution={distribution}
                    incidentRanking={incidentRanking}
                    incidentSummary={incidentSummary}
                    reportSummary={reportSummary}
                    totalConfirmations={totalConfirmations}
                  />

                  <AdminMunicipalQueue
                    barrioOptions={barrioOptions}
                    detailContent={(
                      <AdminMunicipalIncidentDetail
                        detail={selectedIncidentDetail}
                        incident={detailIncident}
                        loading={detailStatus === 'loading'}
                        relatedReports={detailIncident?.relatedReports || []}
                      />
                    )}
                    filters={filters}
                    incidents={incidents}
                    mapContent={(
                      <section className="admin-muni-map-card admin-muni-map-card-light admin-muni-map-card-inline">
                        <PotholesMap
                          allowMarkerSelection={false}
                          incidentsOverride={incidents}
                          viewOnly
                          showDetailSheet={false}
                          selectedIncidentId={queueSelectedIncidentId}
                        />
                      </section>
                    )}
                    onFilterChange={(next) => setFilters((current) => ({ ...current, ...next }))}
                    onSelectIncident={setQueueSelectedIncidentId}
                    onToggleIncidentStatus={(incident, nextStatus) =>
                      handleSaveIncident(incident, {
                        status: nextStatus,
                        priorityBand: incident.priorityBand,
                      })}
                    queueSort={queueSort}
                    setQueueSort={setQueueSort}
                    savingId={savingId}
                    selectedIncidentId={queueSelectedIncidentId}
                  />
                </div>
              ) : null}

              {activeBachesView === 'detalle' ? (
                <AdminMunicipalIncidentDetail
                  detail={selectedIncidentDetail}
                  incident={selectedIncident}
                  loading={detailStatus === 'loading'}
                  relatedReports={selectedIncident?.relatedReports || []}
                />
              ) : null}

            </div>
          ) : null}
        </div>
      </main>
    </div>
  )
}

export default AdminMunicipalPage
