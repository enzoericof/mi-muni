const INCIDENT_CLUSTER_RADIUS_M = 32

export const STATUS_LABELS = {
  nuevo: 'Nuevo',
  verificado: 'Verificado',
  priorizado: 'Priorizado',
  en_reparacion: 'En reparación',
  resuelto: 'Resuelto',
  descartado: 'Descartado',
}

export const PRIORITY_LABELS = {
  alta: 'Alta',
  media: 'Media',
  baja: 'Baja',
}

export const SEVERITY_LABELS = {
  alta: 'Alto',
  media: 'Medio',
  baja: 'Bajo',
}

export const POTHOLE_TYPE_LABELS = {
  bache_aislado: 'Un pozo en la calle',
  conjunto_de_baches: 'Varios pozos juntos',
  hundimiento_o_rotura_grande: 'Hundimiento o rotura',
}

export function formatDateTime(value) {
  if (!value) return 'Sin registro'
  return new Date(value).toLocaleString('es-PY', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatPriorityLabel(value) {
  return PRIORITY_LABELS[value] || 'Media'
}

export function buildDrafts(reports) {
  return Object.fromEntries(
    reports.map((report) => [
      report.id,
      {
        status: report.status,
        priorityBand: report.priorityBand,
      },
    ]),
  )
}

export function buildSummary(reports = []) {
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

export function buildIncidentSummary(incidents = []) {
  const priority = { alta: 0, media: 0, baja: 0 }
  const status = { nuevo: 0, verificado: 0, priorizado: 0, en_reparacion: 0, resuelto: 0, descartado: 0 }

  for (const incident of incidents) {
    if (!['resuelto', 'descartado'].includes(incident.status) && priority[incident.priorityBand] !== undefined) {
      priority[incident.priorityBand] += 1
    }
    if (status[incident.status] !== undefined) status[incident.status] += 1
  }

  return {
    total: incidents.length,
    open: incidents.filter((incident) => !['resuelto', 'descartado'].includes(incident.status)).length,
    priority,
    status,
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRadians = (value) => (value * Math.PI) / 180
  const earthRadius = 6371000
  const latDelta = toRadians(lat2 - lat1)
  const lonDelta = toRadians(lon2 - lon1)
  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(lonDelta / 2) ** 2

  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function resolveIncidentStatusGroup(status) {
  return status === 'resuelto' ? 'resolved' : 'open'
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

function buildIncidentFromReports(reports = []) {
  const primaryReport = pickPrimaryReport(reports)
  if (!primaryReport) return null

  const reportCount = reports.length
  const confirmationCount = reports.reduce((total, report) => total + Number(report.confirmationCount || 0), 0)
  const severityOrder = { alta: 3, media: 2, baja: 1 }
  const highestSeverity =
    [...reports]
      .map((report) => report.reportedSeverity)
      .filter(Boolean)
      .sort((left, right) => (severityOrder[right] || 0) - (severityOrder[left] || 0))[0] || primaryReport.reportedSeverity || 'media'
  const lat = reports.reduce((total, report) => total + Number(report.lat || 0), 0) / reportCount
  const lon = reports.reduce((total, report) => total + Number(report.lon || 0), 0) / reportCount
  const manualPriorityReport =
    [...reports]
      .filter((report) => report.priorityOverridden)
      .sort((left, right) => {
        if (Number(right.priorityScore || 0) !== Number(left.priorityScore || 0)) {
          return Number(right.priorityScore || 0) - Number(left.priorityScore || 0)
        }
        return Number(right.confirmationCount || 0) - Number(left.confirmationCount || 0)
      })[0] || null
  const topPriorityReport =
    manualPriorityReport ||
    [...reports].sort((left, right) => {
      if (Number(right.priorityScore || 0) !== Number(left.priorityScore || 0)) {
        return Number(right.priorityScore || 0) - Number(left.priorityScore || 0)
      }
      return Number(right.confirmationCount || 0) - Number(left.confirmationCount || 0)
    })[0] ||
    primaryReport
  const activeStatuses = reports.filter((report) => !['resuelto', 'descartado'].includes(report.status))
  const statusSource = pickLatestStatusReport(activeStatuses) || pickLatestStatusReport(reports) || primaryReport

  return {
    incidentId: `incident-${primaryReport.id}`,
    primaryReportId: primaryReport.id,
    relatedReportIds: reports.map((report) => report.id),
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6)),
    barrioSlug: primaryReport.barrioSlug,
    barrioLabel: primaryReport.barrioLabel,
    referenceText: primaryReport.referenceText,
    description: primaryReport.description,
    potholeType: topPriorityReport.potholeType || primaryReport.potholeType,
    reportedSeverity: highestSeverity,
    priorityBand: topPriorityReport.priorityBand || primaryReport.priorityBand,
    priorityScore: Number(topPriorityReport.priorityScore || 0),
    priorityOverridden: Boolean(manualPriorityReport),
    status: statusSource.status || primaryReport.status,
    reportCount,
    confirmationCount,
    coverImageUrl: primaryReport.coverImageUrl || topPriorityReport.coverImageUrl || null,
    createdAt: primaryReport.createdAt,
    updatedAt: primaryReport.updatedAt,
    latestStatusAt: statusSource.latestStatusAt || primaryReport.latestStatusAt || null,
  }
}

export function clusterReportsIntoIncidents(reports = []) {
  const activeReports = reports.filter((report) => report.status !== 'descartado')
  const clusters = []

  for (const report of activeReports) {
    let bestCluster = null
    let bestDistance = Number.POSITIVE_INFINITY
    const reportStatusGroup = resolveIncidentStatusGroup(report.status)

    for (const cluster of clusters) {
      if (cluster.statusGroup !== reportStatusGroup) continue
      const distance = haversineMeters(report.lat, report.lon, cluster.seedLat, cluster.seedLon)
      if (distance <= INCIDENT_CLUSTER_RADIUS_M && distance < bestDistance) {
        bestCluster = cluster
        bestDistance = distance
      }
    }

    if (!bestCluster) {
      clusters.push({
        seedLat: report.lat,
        seedLon: report.lon,
        statusGroup: reportStatusGroup,
        reports: [report],
      })
      continue
    }

    bestCluster.reports.push(report)
    bestCluster.seedLat =
      bestCluster.reports.reduce((total, item) => total + Number(item.lat || 0), 0) / bestCluster.reports.length
    bestCluster.seedLon =
      bestCluster.reports.reduce((total, item) => total + Number(item.lon || 0), 0) / bestCluster.reports.length
  }

  return clusters
    .map((cluster) => buildIncidentFromReports(cluster.reports))
    .filter(Boolean)
    .sort((left, right) => {
      if (Number(right.priorityScore) !== Number(left.priorityScore)) {
        return Number(right.priorityScore) - Number(left.priorityScore)
      }
      return Number(right.confirmationCount) - Number(left.confirmationCount)
    })
}

export function buildBarrioRanking(reports = []) {
  const counts = new Map()
  for (const report of reports) {
    const key = report.barrioLabel || report.barrioSlug || 'Sin barrio'
    counts.set(key, (counts.get(key) || 0) + 1)
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5)
}

export function buildIncidentBarrioRanking(incidents = []) {
  const counts = new Map()
  for (const incident of incidents) {
    if (['resuelto', 'descartado'].includes(incident.status)) continue
    const key = incident.barrioLabel || incident.barrioSlug || 'Sin barrio'
    counts.set(key, (counts.get(key) || 0) + 1)
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5)
}

export function buildDistribution(priority = {}) {
  const keys = ['alta', 'media', 'baja']
  const total = keys.reduce((sum, key) => sum + Number(priority[key] || 0), 0) || 1
  let offset = 0

  return keys.map((key) => {
    const value = Number(priority[key] || 0)
    const size = (value / total) * 100
    const segment = {
      key,
      label: formatPriorityLabel(key),
      value,
      offset,
      size,
    }
    offset += size
    return segment
  })
}

export function resolveIncidentReportId(incident, reports = []) {
  if (!incident) return null
  const preferred = reports.find((report) => incident.relatedReportIds.includes(report.id) && !['resuelto', 'descartado'].includes(report.status))
  return preferred?.id || incident.primaryReportId || incident.relatedReportIds[0] || null
}

export function sortReports(reports = [], sortBy = 'score_desc') {
  return [...reports].sort((left, right) => {
    if (sortBy === 'score_asc') return Number(left.priorityScore || 0) - Number(right.priorityScore || 0)
    if (sortBy === 'date_asc') return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    if (sortBy === 'date_desc') return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    return Number(right.priorityScore || 0) - Number(left.priorityScore || 0)
  })
}
