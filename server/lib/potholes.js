import path from 'node:path'
import { put } from '@vercel/blob'
import { getPool, query } from '../db/index.js'
import { geometryContainsPoint, haversineMeters } from './collectionCore.js'
import { compactWhitespace, repairMojibake } from './text.js'

export const POTHOLE_STATUSES = [
  'nuevo',
  'verificado',
  'priorizado',
  'en_reparacion',
  'resuelto',
  'descartado',
]

export const POTHOLE_SEVERITIES = ['alta', 'media', 'baja']
export const POTHOLE_PRIORITY_BANDS = ['alta', 'media', 'baja']
export const POTHOLE_TYPES = ['bache_aislado', 'conjunto_de_baches', 'hundimiento_o_rotura_grande']
const INCIDENT_CLUSTER_RADIUS_M = 32

const PRIORITY_BASE_SCORE = {
  alta: 34,
  media: 22,
  baja: 12,
}

const MANUAL_PRIORITY_SCORE = {
  alta: 90,
  media: 60,
  baja: 30,
}

const TYPE_RISK_SCORE = {
  bache_aislado: 6,
  conjunto_de_baches: 12,
  hundimiento_o_rotura_grande: 18,
}
const DEFAULT_POTHOLE_MUNICIPALITY_SLUG = 'asuncion'
const BARRIO_NEAREST_MAX_DISTANCE_M = 1200

function parseMaybeJson(value, fallback = null) {
  if (!value) return fallback
  if (typeof value === 'object') return value

  try {
    return JSON.parse(value)
  } catch (_error) {
    return fallback
  }
}

function normalizeText(value) {
  return compactWhitespace(String(value || ''))
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase()
}

function normalizeKey(value) {
  return compactWhitespace(String(value || '')).toLowerCase()
}

function parseOptionalMunicipalityId(value) {
  const normalized = String(value ?? '').trim()
  if (!normalized) return null

  const numericValue = Number(normalized)
  return Number.isFinite(numericValue) ? numericValue : null
}

function normalizeSeverity(value) {
  const fallback = normalizeText(value) ? normalizeText(value).toLowerCase() : 'media'
  const normalized = fallback
  if (!POTHOLE_SEVERITIES.includes(normalized)) {
    const error = new Error('pothole-severity-invalid')
    error.code = 'pothole-severity-invalid'
    throw error
  }
  return normalized
}

function normalizePotholeType(value) {
  const normalized = normalizeText(value).toLowerCase()
  if (!POTHOLE_TYPES.includes(normalized)) {
    const error = new Error('pothole-type-invalid')
    error.code = 'pothole-type-invalid'
    throw error
  }
  return normalized
}

function normalizeStatus(value) {
  const normalized = normalizeText(value).toLowerCase()
  if (!POTHOLE_STATUSES.includes(normalized)) {
    const error = new Error('pothole-status-invalid')
    error.code = 'pothole-status-invalid'
    throw error
  }
  return normalized
}

function normalizePriorityBand(value) {
  const normalized = normalizeText(value).toLowerCase()
  if (!POTHOLE_PRIORITY_BANDS.includes(normalized)) {
    const error = new Error('pothole-priority-invalid')
    error.code = 'pothole-priority-invalid'
    throw error
  }
  return normalized
}

function sanitizeFileName(value) {
  const base = path.basename(String(value || 'foto'))
  return base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-')
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function resolveIncidentStatusGroup(status) {
  return status === 'resuelto' ? 'resolved' : 'open'
}

function scoreToPriorityBand(score) {
  if (score >= 75) return 'alta'
  if (score >= 45) return 'media'
  return 'baja'
}

function computePriorityFromInputs({
  reportedSeverity,
  potholeType = 'bache_aislado',
  reportCount = 1,
  confirmationCount = 0,
  createdAt = new Date(),
  priorityOverridden = false,
  priorityBand = null,
  priorityScore = null,
}) {
  if (priorityOverridden && priorityBand) {
    return {
      priorityBand,
      priorityScore: Number(priorityScore || MANUAL_PRIORITY_SCORE[priorityBand] || 30),
      priorityOverridden: true,
    }
  }

  const createdAtDate = createdAt instanceof Date ? createdAt : new Date(createdAt)
  const ageDays = Math.max(0, (Date.now() - createdAtDate.getTime()) / 86400000)
  const base = PRIORITY_BASE_SCORE[reportedSeverity] || PRIORITY_BASE_SCORE.baja
  const typeRisk = TYPE_RISK_SCORE[potholeType] || TYPE_RISK_SCORE.bache_aislado
  const confirmations = clamp(Number(confirmationCount || 0) * 8, 0, 24)
  const reports = clamp((Number(reportCount || 1) - 1) * 7, 0, 18)
  const age = clamp(Math.round(ageDays * 2), 0, 18)
  const priorityScoreValue = clamp(Math.round(base + typeRisk + confirmations + reports + age), 0, 100)

  return {
    priorityBand: scoreToPriorityBand(priorityScoreValue),
    priorityScore: priorityScoreValue,
    priorityOverridden: false,
  }
}

function buildPrioritySummary(reports = []) {
  const priority = { alta: 0, media: 0, baja: 0 }
  const status = { nuevo: 0, verificado: 0, priorizado: 0, en_reparacion: 0, resuelto: 0, descartado: 0 }

  for (const report of reports) {
    if (priority[report.priorityBand] !== undefined) priority[report.priorityBand] += 1
    if (status[report.status] !== undefined) status[report.status] += 1
  }

  return {
    total: reports.length,
    open: reports.filter((report) => !['resuelto', 'descartado'].includes(report.status)).length,
    priority,
    status,
  }
}

function buildReportSelect() {
  return `
    SELECT
      r.id,
      r.municipality_id,
      m.slug AS municipality_slug,
      m.name AS municipality_name,
      r.lat,
      r.lon,
      r.barrio_slug,
      r.barrio_label,
      r.pothole_type,
      r.reference_text,
      r.description,
      r.reported_severity,
      r.priority_band,
      r.priority_score,
      r.priority_overridden,
      r.status,
      r.reporter_name,
      r.reporter_email,
      r.latest_status_at,
      r.created_at,
      r.updated_at,
      COALESCE(confirmations.confirmation_count, 0) AS confirmation_count,
      image.blob_url AS cover_image_url
    FROM pothole_reports r
    LEFT JOIN rag_municipalities m ON m.id = r.municipality_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS confirmation_count
      FROM pothole_confirmations c
      WHERE c.report_id = r.id
    ) confirmations ON TRUE
    LEFT JOIN LATERAL (
      SELECT blob_url
      FROM pothole_report_images i
      WHERE i.report_id = r.id
      ORDER BY i.sort_order ASC, i.id ASC
      LIMIT 1
    ) image ON TRUE
  `
}

function serializeReportRow(row) {
  if (!row) return null

  return {
    id: Number(row.id),
    municipalityId: row.municipality_id ? Number(row.municipality_id) : null,
    municipalitySlug: row.municipality_slug || DEFAULT_POTHOLE_MUNICIPALITY_SLUG,
    municipalityName: repairMojibake(row.municipality_name || 'Asuncion'),
    lat: Number(row.lat),
    lon: Number(row.lon),
    barrioSlug: row.barrio_slug,
    barrioLabel: repairMojibake(row.barrio_label || ''),
    potholeType: row.pothole_type,
    referenceText: repairMojibake(row.reference_text || ''),
    description: repairMojibake(row.description || ''),
    reportedSeverity: row.reported_severity,
    priorityBand: row.priority_band,
    priorityScore: Number(row.priority_score || 0),
    priorityOverridden: Boolean(row.priority_overridden),
    status: row.status,
    reporterName: repairMojibake(row.reporter_name || ''),
    latestStatusAt: row.latest_status_at ? new Date(row.latest_status_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    confirmationCount: Number(row.confirmation_count || 0),
    coverImageUrl: row.cover_image_url || null,
  }
}

function pickPrimaryReport(reports = []) {
  return [...reports].sort((left, right) => {
    const createdDiff = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    if (createdDiff !== 0) return createdDiff
    return Number(left.id) - Number(right.id)
  })[0] || null
}

function pickLatestStatusReport(reports = []) {
  return [...reports].sort((left, right) => {
    const leftTime = new Date(left.latestStatusAt || left.updatedAt || left.createdAt || 0).getTime()
    const rightTime = new Date(right.latestStatusAt || right.updatedAt || right.createdAt || 0).getTime()
    if (rightTime !== leftTime) return rightTime - leftTime
    return Number(right.id || 0) - Number(left.id || 0)
  })[0] || null
}

function pickDominantType(reports = []) {
  const counts = new Map()
  for (const report of reports) {
    counts.set(report.potholeType, (counts.get(report.potholeType) || 0) + 1)
  }

  return [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1]
    return POTHOLE_TYPES.indexOf(left[0]) - POTHOLE_TYPES.indexOf(right[0])
  })[0]?.[0] || 'bache_aislado'
}

function pickHighestSeverity(reports = []) {
  const rank = { alta: 3, media: 2, baja: 1 }
  return [...reports]
    .map((report) => report.reportedSeverity)
    .sort((left, right) => (rank[right] || 0) - (rank[left] || 0))[0] || 'media'
}

function buildIncidentFromReports(reports = []) {
  const primaryReport = pickPrimaryReport(reports)
  if (!primaryReport) return null

  const reportCount = reports.length
  const confirmationCount = reports.reduce((total, report) => total + Number(report.confirmationCount || 0), 0)
  const lat = reports.reduce((total, report) => total + report.lat, 0) / reportCount
  const lon = reports.reduce((total, report) => total + report.lon, 0) / reportCount
  const dominantType = pickDominantType(reports)
  const highestSeverity = pickHighestSeverity(reports)
  const manualPriority = [...reports]
    .filter((report) => report.priorityOverridden)
    .sort((left, right) => Number(right.priorityScore || 0) - Number(left.priorityScore || 0))[0] || null
  const incidentPriority = manualPriority
    ? {
        priorityBand: manualPriority.priorityBand,
        priorityScore: Number(manualPriority.priorityScore || MANUAL_PRIORITY_SCORE[manualPriority.priorityBand] || 30),
      }
    : computePriorityFromInputs({
        reportedSeverity: highestSeverity,
        potholeType: dominantType,
        reportCount,
        confirmationCount,
        createdAt: primaryReport.createdAt,
      })
  const activeStatuses = reports.filter((report) => !['resuelto', 'descartado'].includes(report.status))
  const statusSource = pickLatestStatusReport(activeStatuses) || pickLatestStatusReport(reports) || primaryReport

  return {
    incidentId: `incident-${primaryReport.id}`,
    primaryReportId: primaryReport.id,
    municipalityId: primaryReport.municipalityId,
    municipalitySlug: primaryReport.municipalitySlug,
    municipalityName: primaryReport.municipalityName,
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    barrioSlug: primaryReport.barrioSlug,
    barrioLabel: primaryReport.barrioLabel,
    potholeType: dominantType,
    referenceText: primaryReport.referenceText,
    description: primaryReport.description,
    priorityBand: incidentPriority.priorityBand,
    priorityScore: incidentPriority.priorityScore,
    status: statusSource.status || primaryReport.status,
    reportCount,
    confirmationCount,
    coverImageUrl: primaryReport.coverImageUrl,
    relatedReportIds: reports.map((report) => report.id),
    primaryReport,
  }
}

function clusterReportsIntoIncidents(reports = []) {
  const activeReports = reports.filter((report) => report.status !== 'descartado')
  const incidents = []

  for (const report of activeReports) {
    let bestMatch = null
    let bestDistance = Number.POSITIVE_INFINITY
    const reportStatusGroup = resolveIncidentStatusGroup(report.status)

    for (const incident of incidents) {
      if (incident.statusGroup !== reportStatusGroup) continue
      if (incident.municipalityId !== report.municipalityId) continue
      const distance = haversineMeters(report.lat, report.lon, incident.seedLat, incident.seedLon)
      if (distance <= INCIDENT_CLUSTER_RADIUS_M && distance < bestDistance) {
        bestMatch = incident
        bestDistance = distance
      }
    }

    if (!bestMatch) {
      incidents.push({
        municipalityId: report.municipalityId,
        seedLat: report.lat,
        seedLon: report.lon,
        statusGroup: reportStatusGroup,
        reports: [report],
      })
      continue
    }

    bestMatch.reports.push(report)
    bestMatch.seedLat =
      bestMatch.reports.reduce((total, item) => total + Number(item.lat || 0), 0) / bestMatch.reports.length
    bestMatch.seedLon =
      bestMatch.reports.reduce((total, item) => total + Number(item.lon || 0), 0) / bestMatch.reports.length
  }

  return incidents
    .map((incident) => buildIncidentFromReports(incident.reports))
    .filter(Boolean)
    .sort((left, right) => {
      if (right.priorityScore !== left.priorityScore) return right.priorityScore - left.priorityScore
      if (right.confirmationCount !== left.confirmationCount) return right.confirmationCount - left.confirmationCount
      return new Date(right.primaryReport.createdAt).getTime() - new Date(left.primaryReport.createdAt).getTime()
    })
}

async function getIncidentByReportId(reportId) {
  const normalizedId = Number(reportId)
  if (!Number.isFinite(normalizedId)) return null
  const reports = await listPotholeReports()
  const incidents = clusterReportsIntoIncidents(reports)
  return incidents.find((incident) => incident.relatedReportIds.includes(normalizedId)) || null
}

async function listViewerConfirmedReportIds(viewerEmail, reportIds = []) {
  const normalizedEmail = normalizeEmail(viewerEmail)
  const normalizedIds = [...new Set(reportIds.map((value) => Number(value)).filter((value) => Number.isFinite(value)))]
  if (!normalizedEmail || !normalizedIds.length) return new Set()

  const { rows } = await query(
    `
      SELECT report_id
      FROM pothole_confirmations
      WHERE confirmer_email = $1
        AND report_id = ANY($2::bigint[])
    `,
    [normalizedEmail, normalizedIds],
  )

  return new Set(rows.map((row) => Number(row.report_id)))
}

function buildViewerConfirmedMap(reportIds = [], viewerConfirmedReportIds = new Set()) {
  const confirmed = new Set(viewerConfirmedReportIds)
  return [...new Set(reportIds.map((value) => Number(value)).filter(Number.isFinite))].reduce((accumulator, reportId) => {
    accumulator[reportId] = confirmed.has(reportId)
    return accumulator
  }, {})
}

function expandBounds(bounds, delta = 0.015) {
  if (!bounds) return null
  return {
    minLat: Number(bounds.minLat) - delta,
    maxLat: Number(bounds.maxLat) + delta,
    minLon: Number(bounds.minLon) - delta,
    maxLon: Number(bounds.maxLon) + delta,
  }
}

function boundsContainPoint(bounds, lat, lon) {
  if (!bounds) return false
  return (
    lat >= Number(bounds.minLat) &&
    lat <= Number(bounds.maxLat) &&
    lon >= Number(bounds.minLon) &&
    lon <= Number(bounds.maxLon)
  )
}

async function resolveMunicipality({ municipalityId = '', municipalitySlug = '' } = {}) {
  const params = []
  const filters = []

  const numericMunicipalityId = parseOptionalMunicipalityId(municipalityId)
  if (numericMunicipalityId !== null) {
    params.push(numericMunicipalityId)
    filters.push(`id = $${params.length}`)
  }

  if (municipalitySlug) {
    params.push(normalizeKey(municipalitySlug))
    filters.push(`slug = $${params.length}`)
  }

  if (!filters.length) {
    params.push(DEFAULT_POTHOLE_MUNICIPALITY_SLUG)
    filters.push(`slug = $${params.length}`)
  }

  const { rows } = await query(
    `
      SELECT id, slug, name, center_lat, center_lon, bbox, geometry
      FROM rag_municipalities
      WHERE ${filters.join(' OR ')}
      ORDER BY id ASC
      LIMIT 1
    `,
    params,
  )

  const row = rows[0]
  if (row) {
    return {
      id: Number(row.id),
      slug: row.slug,
      name: repairMojibake(row.name || 'Asuncion'),
      centerLat: row.center_lat === null || row.center_lat === undefined ? null : Number(row.center_lat),
      centerLon: row.center_lon === null || row.center_lon === undefined ? null : Number(row.center_lon),
      bbox: parseMaybeJson(row.bbox, {}),
      geometry: parseMaybeJson(row.geometry, {}),
    }
  }

  return null
}

async function loadMunicipalBarrios(municipalityId) {
  const { rows } = await query(
    `
      SELECT barrio_slug, barrio_label, center_lat, center_lon, bbox, geometry
      FROM municipal_barrios
      WHERE municipality_id = $1
      ORDER BY barrio_label ASC
    `,
    [Number(municipalityId)],
  )

  return rows.map((row) => ({
    barrioId: row.barrio_slug,
    barrioLabel: repairMojibake(row.barrio_label || row.barrio_slug),
    centerLat: Number(row.center_lat),
    centerLon: Number(row.center_lon),
    bbox: parseMaybeJson(row.bbox, {}),
    geometry: parseMaybeJson(row.geometry, {}),
  }))
}

async function resolveBarrioForPoint(lat, lon, municipality) {
  const barrios = await loadMunicipalBarrios(municipality.id)
  if (!barrios.length) return null

  const directMatch = barrios.find((barrio) => geometryContainsPoint(barrio.geometry, lat, lon))
  if (directMatch) return directMatch

  const municipalityBounds = expandBounds(municipality?.bbox || null)
  if (municipalityBounds && !boundsContainPoint(municipalityBounds, lat, lon)) {
    return null
  }

  const nearest = [...barrios].sort(
    (left, right) =>
      haversineMeters(lat, lon, left.centerLat, left.centerLon) -
      haversineMeters(lat, lon, right.centerLat, right.centerLon),
  )[0]

  if (!nearest) return null
  const nearestDistance = haversineMeters(lat, lon, nearest.centerLat, nearest.centerLon)
  return nearestDistance <= BARRIO_NEAREST_MAX_DISTANCE_M ? nearest : null
}

function assertBlobConfigured() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return
  const error = new Error('pothole-storage-not-configured')
  error.code = 'pothole-storage-not-configured'
  throw error
}

async function uploadPotholeImage(file, reportId, sortOrder) {
  assertBlobConfigured()

  const extension = path.extname(file.originalname || '') || '.jpg'
  const safeName = sanitizeFileName(file.originalname || `foto${extension}`)
  const pathname = `potholes/${reportId}/${Date.now()}-${sortOrder + 1}-${safeName}`

  const blob = await put(pathname, file.buffer, {
    access: 'public',
    addRandomSuffix: false,
    contentType: file.mimetype || 'application/octet-stream',
    token: process.env.BLOB_READ_WRITE_TOKEN,
  })

  return {
    blobPath: blob.pathname,
    blobUrl: blob.url,
    fileName: safeName,
    mimeType: file.mimetype || 'application/octet-stream',
    sizeBytes: Number(file.size || 0),
    sortOrder,
  }
}

async function listPotholeImages(reportId, client = null) {
  const executor = client || { query }
  const { rows } = await executor.query(
    `
      SELECT id, blob_path, blob_url, file_name, mime_type, size_bytes, sort_order, created_at
      FROM pothole_report_images
      WHERE report_id = $1
      ORDER BY sort_order ASC, id ASC
    `,
    [reportId],
  )

  return rows.map((row) => ({
    id: Number(row.id),
    blobPath: row.blob_path,
    blobUrl: row.blob_url,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes || 0),
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }))
}

async function listPotholeHistory(reportId, client = null) {
  const executor = client || { query }
  const { rows } = await executor.query(
    `
      SELECT id, from_status, to_status, changed_by, note, created_at
      FROM pothole_status_history
      WHERE report_id = $1
      ORDER BY created_at DESC, id DESC
    `,
    [reportId],
  )

  return rows.map((row) => ({
    id: Number(row.id),
    fromStatus: row.from_status || null,
    toStatus: row.to_status,
    changedBy: row.changed_by,
    note: row.note || '',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }))
}

async function listPotholeConfirmations(reportId, client = null) {
  const executor = client || { query }
  const { rows } = await executor.query(
    `
      SELECT id, confirmer_name, confirmer_email, note, created_at
      FROM pothole_confirmations
      WHERE report_id = $1
      ORDER BY created_at DESC, id DESC
    `,
    [reportId],
  )

  return rows.map((row) => ({
    id: Number(row.id),
    confirmerName: repairMojibake(row.confirmer_name || ''),
    note: repairMojibake(row.note || ''),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }))
}

export async function listPotholeReports(filters = {}) {
  const where = []
  const params = []

  const numericMunicipalityId = parseOptionalMunicipalityId(filters.municipalityId)
  if (numericMunicipalityId !== null) {
    params.push(numericMunicipalityId)
    where.push(`r.municipality_id = $${params.length}`)
  } else if (filters.municipalitySlug) {
    params.push(normalizeKey(filters.municipalitySlug))
    where.push(`m.slug = $${params.length}`)
  }

  if (filters.status) {
    params.push(normalizeStatus(filters.status))
    where.push(`r.status = $${params.length}`)
  }

  if (filters.priorityBand) {
    params.push(normalizePriorityBand(filters.priorityBand))
    where.push(`r.priority_band = $${params.length}`)
  }

  if (filters.barrioSlug) {
    params.push(normalizeKey(filters.barrioSlug))
    where.push(`r.barrio_slug = $${params.length}`)
  }

  const limit = Number.isFinite(Number(filters.limit)) ? Math.max(1, Math.min(250, Number(filters.limit))) : null
  const suffix = limit ? ` LIMIT ${limit}` : ''

  const { rows } = await query(
    `
      ${buildReportSelect()}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY
        CASE r.priority_band
          WHEN 'alta' THEN 1
          WHEN 'media' THEN 2
          ELSE 3
        END,
        r.created_at DESC
      ${suffix}
    `,
    params,
  )

  return rows.map(serializeReportRow)
}

export async function getPotholeReportById(reportId, { viewerEmail = '' } = {}) {
  const normalizedId = Number(reportId)
  if (!Number.isFinite(normalizedId)) return null

  const { rows } = await query(
    `
      ${buildReportSelect()}
      WHERE r.id = $1
      LIMIT 1
    `,
    [normalizedId],
  )

  if (!rows.length) return null

  const report = serializeReportRow(rows[0])
  const [images, history, confirmations, incident] = await Promise.all([
    listPotholeImages(normalizedId),
    listPotholeHistory(normalizedId),
    listPotholeConfirmations(normalizedId),
    getIncidentByReportId(normalizedId),
  ])
  const viewerConfirmedReportIds = incident
    ? await listViewerConfirmedReportIds(viewerEmail, [incident.primaryReportId])
    : new Set()

  return {
    ...report,
    images,
    history,
    confirmations,
    viewerConfirmedReportIds: incident
      ? buildViewerConfirmedMap([incident.primaryReportId], viewerConfirmedReportIds)
      : {},
    incident: incident
      ? {
          incidentId: incident.incidentId,
          primaryReportId: incident.primaryReportId,
          municipalityId: incident.municipalityId,
          municipalitySlug: incident.municipalitySlug,
          municipalityName: incident.municipalityName,
          reportCount: incident.reportCount,
          confirmationCount: incident.confirmationCount,
          priorityBand: incident.priorityBand,
          priorityScore: incident.priorityScore,
          relatedReportIds: incident.relatedReportIds,
          potholeType: incident.potholeType,
          viewerHasConfirmed: viewerConfirmedReportIds.has(incident.primaryReportId),
        }
      : null,
  }
}

export async function getPotholesMap({ viewerEmail = '', municipalityId = '', municipalitySlug = '' } = {}) {
  const municipality = await resolveMunicipality({ municipalityId, municipalitySlug })
  const hasRequestedMunicipality = Boolean(String(municipalityId || '').trim() || String(municipalitySlug || '').trim())
  const reports = municipality
    ? await listPotholeReports({
        municipalityId: municipality.id,
        municipalitySlug: municipality.slug,
      })
    : hasRequestedMunicipality
      ? []
      : await listPotholeReports({
          municipalitySlug: DEFAULT_POTHOLE_MUNICIPALITY_SLUG,
        })
  const barrios = municipality?.id ? await loadMunicipalBarrios(municipality.id) : []

  const incidents = clusterReportsIntoIncidents(reports)
  const viewerConfirmedReportIds = await listViewerConfirmedReportIds(
    viewerEmail,
    incidents.map((incident) => incident.primaryReportId),
  )

  return {
    generatedAt: new Date().toISOString(),
    municipality: municipality
      ? {
          id: municipality.id,
          slug: municipality.slug,
          name: municipality.name,
          centerLat:
            municipality.centerLat ??
            (barrios.length
              ? Number((barrios.reduce((total, barrio) => total + barrio.centerLat, 0) / barrios.length).toFixed(6))
              : null),
          centerLon:
            municipality.centerLon ??
            (barrios.length
              ? Number((barrios.reduce((total, barrio) => total + barrio.centerLon, 0) / barrios.length).toFixed(6))
              : null),
          bbox: municipality.bbox || null,
          barrioCount: barrios.length,
        }
      : null,
    reports,
    incidents: incidents.map((incident) => ({
      incidentId: incident.incidentId,
      primaryReportId: incident.primaryReportId,
      municipalityId: incident.municipalityId,
      municipalitySlug: incident.municipalitySlug,
      municipalityName: incident.municipalityName,
      lat: incident.lat,
      lon: incident.lon,
      barrioSlug: incident.barrioSlug,
      barrioLabel: incident.barrioLabel,
      potholeType: incident.potholeType,
      referenceText: incident.referenceText,
      description: incident.description,
      priorityBand: incident.priorityBand,
      priorityScore: incident.priorityScore,
      status: incident.status,
      reportCount: incident.reportCount,
      confirmationCount: incident.confirmationCount,
      coverImageUrl: incident.coverImageUrl,
      relatedReportIds: incident.relatedReportIds,
      viewerHasConfirmed: viewerConfirmedReportIds.has(incident.primaryReportId),
    })),
    viewerConfirmedReportIds: buildViewerConfirmedMap(
      incidents.map((incident) => incident.primaryReportId),
      viewerConfirmedReportIds,
    ),
    barrios: barrios.map((row) => ({
      id: row.barrioId,
      label: row.barrioLabel,
      centerLat: row.centerLat,
      centerLon: row.centerLon,
    })),
    summary: buildPrioritySummary(reports),
  }
}

export async function createPotholeReport({
  municipalityId,
  municipalitySlug,
  lat,
  lon,
  potholeType,
  referenceText,
  description,
  reportedSeverity,
  reporterName,
  reporterEmail,
  files = [],
}) {
  const normalizedLat = Number(lat)
  const normalizedLon = Number(lon)
  const cleanDescription = normalizeText(description)
  const cleanReference = normalizeText(referenceText)
  const cleanName = normalizeText(reporterName)
  const cleanEmail = normalizeEmail(reporterEmail)
  const severity = normalizeSeverity(reportedSeverity)
  const normalizedPotholeType = normalizePotholeType(potholeType)

  if (!Number.isFinite(normalizedLat) || !Number.isFinite(normalizedLon)) {
    const error = new Error('pothole-location-invalid')
    error.code = 'pothole-location-invalid'
    throw error
  }

  if (!cleanDescription) {
    const error = new Error('pothole-description-required')
    error.code = 'pothole-description-required'
    throw error
  }

  if (!cleanName || !cleanEmail) {
    const error = new Error('pothole-reporter-required')
    error.code = 'pothole-reporter-required'
    throw error
  }

  const safeFiles = Array.isArray(files) ? files : []

  if (safeFiles.length > 1) {
    const error = new Error('pothole-image-limit-exceeded')
    error.code = 'pothole-image-limit-exceeded'
    throw error
  }

  const municipality = await resolveMunicipality({ municipalityId, municipalitySlug })
  const barrio = municipality ? await resolveBarrioForPoint(normalizedLat, normalizedLon, municipality) : null
  if (!barrio) {
    const error = new Error('pothole-barrio-not-found')
    error.code = 'pothole-barrio-not-found'
    throw error
  }

  const priority = computePriorityFromInputs({
    reportedSeverity: severity,
    potholeType: normalizedPotholeType,
    reportCount: 1,
    confirmationCount: 0,
    createdAt: new Date(),
  })

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query(
      `
        INSERT INTO pothole_reports (
          municipality_id,
          lat,
          lon,
          barrio_slug,
          barrio_label,
          pothole_type,
          reference_text,
          description,
          reported_severity,
          priority_band,
          priority_score,
          priority_overridden,
          status,
          reporter_name,
          reporter_email,
          latest_status_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, FALSE, 'nuevo', $12, $13, NOW())
        RETURNING id
      `,
      [
        municipality?.id || null,
        normalizedLat,
        normalizedLon,
        barrio.barrioId,
        barrio.barrioLabel,
        normalizedPotholeType,
        cleanReference || null,
        cleanDescription,
        severity,
        priority.priorityBand,
        priority.priorityScore,
        cleanName,
        cleanEmail,
      ],
    )

    const reportId = Number(rows[0].id)

    for (let index = 0; index < safeFiles.length; index += 1) {
      const uploaded = await uploadPotholeImage(safeFiles[index], reportId, index)
      await client.query(
        `
          INSERT INTO pothole_report_images (
            report_id,
            blob_path,
            blob_url,
            file_name,
            mime_type,
            size_bytes,
            sort_order
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          reportId,
          uploaded.blobPath,
          uploaded.blobUrl,
          uploaded.fileName,
          uploaded.mimeType,
          uploaded.sizeBytes,
          uploaded.sortOrder,
        ],
      )
    }

    await client.query(
      `
        INSERT INTO pothole_status_history (report_id, from_status, to_status, changed_by, note)
        VALUES ($1, NULL, 'nuevo', $2, $3)
      `,
      [reportId, cleanEmail, 'Reporte creado por vecino/a'],
    )

    await client.query('COMMIT')
    return getPotholeReportById(reportId, { viewerEmail: cleanEmail })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function createPotholeConfirmation(reportId, { confirmerName, confirmerEmail, note = '' }) {
  const normalizedId = Number(reportId)
  const cleanName = normalizeText(confirmerName)
  const cleanEmail = normalizeEmail(confirmerEmail)
  const cleanNote = normalizeText(note)

  if (!Number.isFinite(normalizedId)) {
    const error = new Error('pothole-report-not-found')
    error.code = 'pothole-report-not-found'
    throw error
  }

  if (!cleanName || !cleanEmail) {
    const error = new Error('pothole-confirmer-required')
    error.code = 'pothole-confirmer-required'
    throw error
  }

  const incident = await getIncidentByReportId(normalizedId)
  const targetReportId = incident?.primaryReportId || normalizedId

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')

    const { rows } = await client.query(
      `
        SELECT *
        FROM pothole_reports
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [targetReportId],
    )

    if (!rows.length) {
      const error = new Error('pothole-report-not-found')
      error.code = 'pothole-report-not-found'
      throw error
    }

    const current = rows[0]

    if (['resuelto', 'descartado'].includes(current.status)) {
      const error = new Error('pothole-report-closed')
      error.code = 'pothole-report-closed'
      throw error
    }

    const insertResult = await client.query(
      `
        INSERT INTO pothole_confirmations (report_id, confirmer_name, confirmer_email, note)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (report_id, confirmer_email) DO NOTHING
        RETURNING id
      `,
      [targetReportId, cleanName, cleanEmail, cleanNote || null],
    )

    if (!insertResult.rows.length) {
      const error = new Error('pothole-confirmation-duplicate')
      error.code = 'pothole-confirmation-duplicate'
      throw error
    }

    const nextConfirmationCount = Number(current.priority_overridden)
      ? null
      : Number(
          (
            await client.query(
              `SELECT COUNT(*)::int AS count FROM pothole_confirmations WHERE report_id = $1`,
              [targetReportId],
            )
          ).rows[0].count,
        )

    const nextPriority = computePriorityFromInputs({
      reportedSeverity: current.reported_severity,
      potholeType: incident?.potholeType || current.pothole_type,
      reportCount: incident?.reportCount || 1,
      confirmationCount: nextConfirmationCount || 0,
      createdAt: current.created_at,
      priorityOverridden: Boolean(current.priority_overridden),
      priorityBand: current.priority_band,
      priorityScore: current.priority_score,
    })

    await client.query(
      `
        UPDATE pothole_reports
        SET
          priority_band = $2,
          priority_score = $3,
          updated_at = NOW()
        WHERE id = $1
      `,
      [targetReportId, nextPriority.priorityBand, nextPriority.priorityScore],
    )

    await client.query('COMMIT')
    return getPotholeReportById(targetReportId, { viewerEmail: cleanEmail })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function getPotholeDashboard({ municipalityId = '', municipalitySlug = '' } = {}) {
  const reports = await listPotholeReports({ municipalityId, municipalitySlug })
  const summary = buildPrioritySummary(reports)

  return {
    generatedAt: new Date().toISOString(),
    summary,
    topPriority: reports
      .filter((report) => !['resuelto', 'descartado'].includes(report.status))
      .sort((left, right) => right.priorityScore - left.priorityScore)
      .slice(0, 8),
    recent: [...reports].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt)).slice(0, 8),
  }
}

export async function updatePotholeReportAdmin(reportId, { status, priorityBand, note = '', changedBy = 'admin' }) {
  const normalizedId = Number(reportId)
  if (!Number.isFinite(normalizedId)) return null

  const nextStatus = status ? normalizeStatus(status) : null
  const nextPriorityBand = priorityBand ? normalizePriorityBand(priorityBand) : null
  const historyNote = normalizeText(note)

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `
        SELECT *
        FROM pothole_reports
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [normalizedId],
    )

    if (!rows.length) {
      await client.query('ROLLBACK')
      return null
    }

    const current = rows[0]
    const finalStatus = nextStatus || current.status
    const finalPriorityBand = nextPriorityBand || current.priority_band
    const finalPriorityScore = nextPriorityBand
      ? MANUAL_PRIORITY_SCORE[finalPriorityBand]
      : Number(current.priority_score || 0)

    await client.query(
      `
        UPDATE pothole_reports
        SET
          status = $2::varchar(30),
          priority_band = $3::varchar(20),
          priority_score = $4,
          priority_overridden = $5,
          latest_status_at = CASE WHEN status <> $2::varchar(30) THEN NOW() ELSE latest_status_at END,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        normalizedId,
        finalStatus,
        finalPriorityBand,
        finalPriorityScore,
        nextPriorityBand ? true : Boolean(current.priority_overridden),
      ],
    )

    const shouldWriteHistory =
      finalStatus !== current.status ||
      finalPriorityBand !== current.priority_band ||
      Boolean(historyNote)

    if (shouldWriteHistory) {
      const composedNote = [
        nextPriorityBand && finalPriorityBand !== current.priority_band
          ? `Prioridad manual: ${finalPriorityBand}.`
          : '',
        historyNote,
      ]
        .filter(Boolean)
        .join(' ')

      await client.query(
        `
          INSERT INTO pothole_status_history (report_id, from_status, to_status, changed_by, note)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [
          normalizedId,
          current.status,
          finalStatus,
          normalizeText(changedBy) || 'admin',
          composedNote || null,
        ],
      )
    }

    await client.query('COMMIT')
    return getPotholeReportById(normalizedId)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
