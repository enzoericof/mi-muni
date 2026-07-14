import { query } from '../db/index.js'
import { DAY_LABELS, buildShapeMetrics, loadCollectionAssets } from './collectionCore.js'
import { ensureCollectionSimulationWindow } from '../db/collection-seed.js'
import { getVehiclePositions } from './gtfsEngine.js'
import { getCollectionRuntimeSettings } from './collectionRuntime.js'
import { repairMojibake } from './text.js'

const MIN_COLLECTION_INTERVAL_DAYS = 3.5
const MAX_MONTHLY_COLLECTION_PASSES = 8
const DEFAULT_COLLECTION_MUNICIPALITY_SLUG = 'asuncion'
const SYNTHETIC_ROUTE_COLORS = ['#146152', '#2A9D8F', '#E76F51', '#E9C46A', '#3D5A80', '#7C6A0A']
const SYNTHETIC_ROUTE_GROUP_SIZE = 3
const FALLBACK_COLLECTION_BARRIOS = {
  lambare: [
    ['centro', 'Centro', -25.3448, -57.6069],
    ['valle-apua', 'Valle Apuá', -25.3388, -57.6232],
    ['san-isidro', 'San Isidro', -25.3509, -57.6212],
    ['mbachio', 'Mbachió', -25.3365, -57.6355],
    ['puerto-pabla', 'Puerto Pabla', -25.3617, -57.6482],
    ['panambi-reta', 'Panambí Retá', -25.3299, -57.6164],
    ['kennedy', 'Kennedy', -25.3435, -57.5948],
    ['santa-rosa', 'Santa Rosa', -25.3561, -57.6072],
    ['villa-virginia', 'Villa Virginia', -25.3515, -57.5944],
  ],
  luque: [
    ['centro', 'Centro', -25.2672, -57.4877],
    ['marambure', 'Maramburé', -25.2512, -57.4937],
    ['laurelty', 'Laurelty', -25.2871, -57.5138],
    ['makai', 'Makaí', -25.2689, -57.5167],
    ['ykua-dure', 'Ykua Duré', -25.2564, -57.5077],
    ['bella-vista', 'Bella Vista', -25.2781, -57.4829],
    ['isla-bogado', 'Isla Bogado', -25.2479, -57.4708],
    ['tarumandy', 'Tarumandy', -25.2241, -57.4347],
    ['itapuami', 'Itapuamí', -25.2122, -57.3915],
    ['mora-cue', 'Mora Cué', -25.2399, -57.5061],
    ['ykaa', 'Ykaá', -25.2869, -57.4704],
    ['campo-grande', 'Campo Grande', -25.3023, -57.4888],
    ['costa-sosa', 'Costa Sosa', -25.2761, -57.4512],
    ['canada-san-rafael', 'Cañada San Rafael', -25.2328, -57.4589],
    ['loma-merlo', 'Loma Merlo', -25.2792, -57.5316],
  ],
  'san-lorenzo': [
    ['centro', 'Centro', -25.3397, -57.5088],
    ['barcequillo', 'Barcequillo', -25.3572, -57.5381],
    ['calle-i', 'Calleí', -25.3276, -57.4963],
    ['capilla-del-monte', 'Capilla del Monte', -25.3501, -57.4998],
    ['lucerito', 'Lucerito', -25.3317, -57.5215],
    ['reduto', 'Reducto', -25.3645, -57.5157],
    ['san-miguel', 'San Miguel', -25.3414, -57.4896],
    ['santa-maria', 'Santa María', -25.3469, -57.5297],
    ['santo-rey', 'Santo Rey', -25.3262, -57.5103],
  ],
}

function parseMaybeJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value

  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function parseOptionalMunicipalityId(value) {
  const normalized = String(value ?? '').trim()
  if (!normalized) return null

  const numericValue = Number(normalized)
  return Number.isFinite(numericValue) ? numericValue : null
}

function chunkArray(items = [], size = 1) {
  const safeSize = Math.max(1, Number(size) || 1)
  const chunks = []
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize))
  }
  return chunks
}

function padRouteNumber(value) {
  return String(value).padStart(2, '0')
}

function buildSyntheticRoutePrefix(municipalitySlug) {
  const compact = normalizeKey(municipalitySlug).replace(/-/g, '')
  return compact.slice(0, 3).toUpperCase() || 'MUN'
}

function buildSyntheticRouteShape(depot, barrioGroup = []) {
  const coords = [[depot.centerLat, depot.centerLon]]

  for (const barrio of barrioGroup) {
    coords.push([barrio.centerLat, barrio.centerLon])
    coords.push([Number((barrio.centerLat + 0.0012).toFixed(6)), Number((barrio.centerLon + 0.0009).toFixed(6))])
  }

  coords.push([depot.centerLat, depot.centerLon])
  return coords
}

function buildFallbackCollectionBarrios(municipality) {
  const fallback = FALLBACK_COLLECTION_BARRIOS[normalizeKey(municipality?.slug)] || []
  return fallback.map(([slug, label, centerLat, centerLon]) => ({
    barrioId: `${normalizeKey(municipality?.slug)}-${slug}`,
    barrioLabel: repairMojibake(label),
    centerLat,
    centerLon,
    bbox: {},
    geometry: {},
  }))
}

function buildSyntheticHistoryEvent({ routeSummary, stopMarker, occurredAt }) {
  const enteredAt = new Date(occurredAt)
  const exitedAt = new Date(enteredAt.getTime() + (3 * 60 * 1000))

  return {
    runId: `${routeSummary.routeId}-${enteredAt.toISOString()}`,
    routeId: routeSummary.routeId,
    routeShortName: routeSummary.shortName,
    routeLongName: routeSummary.longName,
    routeColor: routeSummary.color,
    enteredAt: enteredAt.toISOString(),
    exitedAt: exitedAt.toISOString(),
    stopSequence: Number(stopMarker.sequence || 1),
    firstStopName: routeSummary.stopMarkers[0]?.stopName || stopMarker.stopName,
    lastStopName: routeSummary.stopMarkers.at(-1)?.stopName || stopMarker.stopName,
    dayLabel: DAY_LABELS[enteredAt.getDay()],
  }
}

function buildSyntheticCollectionPlan(municipality, barrioRows = []) {
  const validBarrios = barrioRows
    .filter((row) => Number.isFinite(row.centerLat) && Number.isFinite(row.centerLon))
    .sort((left, right) => left.barrioLabel.localeCompare(right.barrioLabel, 'es'))

  if (!municipality || !validBarrios.length) {
    return {
      municipality: buildMunicipalityDescriptor(municipality, barrioRows, { collectionReady: false }),
      depots: [],
      zones: barrioRows.map((row) => ({
        id: row.barrioId,
        label: row.barrioLabel,
        stopCount: 0,
        routeCount: 0,
        centerLat: row.centerLat,
        centerLon: row.centerLon,
        routeNames: [],
        bbox: row.bbox || null,
        geometryReady: hasGeometry(row.geometry),
      })),
      features: barrioRows.map(buildMunicipalFeature).filter(Boolean),
      collectionReady: false,
      routeSummaries: new Map(),
      coverageByBarrio: new Map(),
    }
  }

  const depot = {
    id: `DEP-${normalizeKey(municipality.slug).toUpperCase()}`,
    label: `Base ${municipality.name}`,
    centerLat: municipality.centerLat ?? validBarrios[0].centerLat,
    centerLon: municipality.centerLon ?? validBarrios[0].centerLon,
  }
  const routePrefix = buildSyntheticRoutePrefix(municipality.slug)
  const routeGroups = chunkArray(validBarrios, SYNTHETIC_ROUTE_GROUP_SIZE)
  const routeSummaries = new Map()
  const coverageByBarrio = new Map()

  routeGroups.forEach((group, index) => {
    const routeNumber = padRouteNumber(index + 1)
    const routeId = `${normalizeKey(municipality.slug)}-route-${routeNumber}`
    const shortName = `${routePrefix}-${routeNumber}`
    const shapePoints = buildSyntheticRouteShape(depot, group)
    const shapeMetrics = buildShapeMetrics(shapePoints)
    const color = SYNTHETIC_ROUTE_COLORS[index % SYNTHETIC_ROUTE_COLORS.length]
    const stopMarkers = group.map((barrio, stopIndex) => ({
      stopId: barrio.barrioId,
      stopName: barrio.barrioLabel,
      lat: barrio.centerLat,
      lon: barrio.centerLon,
      sequence: stopIndex + 1,
      isPrimary: true,
    }))
    const referenceLabels = stopMarkers.map((marker) => marker.stopName)
    const routeSummary = {
      routeId,
      shortName,
      longName: `Circuito ${municipality.name} ${index + 1}`,
      color,
      shapeId: `shape-${routeId}`,
      durationMinutes: Math.max(28, 18 + (group.length * 12)),
      shapePoints,
      stopMarkers,
      referenceLabels,
      referenceStop: referenceLabels.length
        ? `${referenceLabels[0]} -> ${referenceLabels.at(-1)}`
        : null,
      totalDistanceMeters: shapeMetrics.totalDistanceMeters,
      routeIndex: index,
    }

    routeSummaries.set(routeId, routeSummary)
    stopMarkers.forEach((marker) => {
      const current = coverageByBarrio.get(marker.stopId) || []
      current.push(routeSummary)
      coverageByBarrio.set(marker.stopId, current)
    })
  })

  return {
    municipality: buildMunicipalityDescriptor(municipality, barrioRows, { collectionReady: true }),
    depots: [depot],
    zones: barrioRows.map((row) => {
      const routes = coverageByBarrio.get(row.barrioId) || []
      return {
        id: row.barrioId,
        label: row.barrioLabel,
        stopCount: routes.length,
        routeCount: routes.length,
        centerLat: row.centerLat,
        centerLon: row.centerLon,
        routeNames: routes.map((route) => route.shortName),
        bbox: row.bbox || null,
        geometryReady: hasGeometry(row.geometry),
      }
    }),
    features: barrioRows.map(buildMunicipalFeature).filter(Boolean),
    collectionReady: true,
    routeSummaries,
    coverageByBarrio,
  }
}

function buildGeoOnlyCollectionPlan(municipality, barrioRows = []) {
  return {
    municipality: buildMunicipalityDescriptor(municipality, barrioRows, { collectionReady: false }),
    depots: [],
    zones: barrioRows.map((row) => ({
      id: row.barrioId,
      label: row.barrioLabel,
      stopCount: 0,
      routeCount: 0,
      centerLat: row.centerLat,
      centerLon: row.centerLon,
      routeNames: [],
      bbox: row.bbox || null,
      geometryReady: hasGeometry(row.geometry),
    })),
    features: barrioRows.map(buildMunicipalFeature).filter(Boolean),
    collectionReady: false,
    routeSummaries: new Map(),
    coverageByBarrio: new Map(),
  }
}

function buildSyntheticBarrioOverview(plan, barrio, now = new Date()) {
  const routeSummaries = plan.coverageByBarrio.get(barrio.barrioId) || []
  const pastEvents = []
  const futureEvents = []

  routeSummaries.forEach((routeSummary) => {
    const stopMarker = routeSummary.stopMarkers.find((marker) => marker.stopId === barrio.barrioId) || routeSummary.stopMarkers[0]
    const cadenceDays = MIN_COLLECTION_INTERVAL_DAYS + (routeSummary.routeIndex % 3)
    const baseHour = 6 + ((routeSummary.routeIndex * 2) % 10)
    const baseMinute = (routeSummary.routeIndex * 11) % 60

    for (let index = 0; index < 8; index += 1) {
      const eventDate = new Date(now)
      eventDate.setHours(baseHour, baseMinute, 0, 0)
      eventDate.setDate(eventDate.getDate() - Math.round(index * cadenceDays))
      eventDate.setMinutes(eventDate.getMinutes() + ((stopMarker.sequence - 1) * 9))
      if (eventDate <= now) {
        pastEvents.push(buildSyntheticHistoryEvent({ routeSummary, stopMarker, occurredAt: eventDate }))
      }
    }

    for (let index = 1; index <= 3; index += 1) {
      const eventDate = new Date(now)
      eventDate.setHours(baseHour, baseMinute, 0, 0)
      eventDate.setDate(eventDate.getDate() + Math.round(index * cadenceDays))
      eventDate.setMinutes(eventDate.getMinutes() + ((stopMarker.sequence - 1) * 9))
      futureEvents.push(buildSyntheticHistoryEvent({ routeSummary, stopMarker, occurredAt: eventDate }))
    }
  })

  pastEvents.sort((left, right) => new Date(right.enteredAt) - new Date(left.enteredAt))
  futureEvents.sort((left, right) => new Date(left.enteredAt) - new Date(right.enteredAt))

  const recentWeekThreshold = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000))
  const currentYearThreshold = new Date(now.getTime() - (365 * 24 * 60 * 60 * 1000))
  const recentWeekEvents = pastEvents.filter((event) => new Date(event.enteredAt) >= recentWeekThreshold)
  const currentYearEvents = pastEvents.filter((event) => new Date(event.enteredAt) >= currentYearThreshold)
  const frequentRoute = routeSummaries[0] || null
  const latestRoute = routeSummaries[0] || null
  const frequentEvent = pastEvents.find((event) => event.routeId === frequentRoute?.routeId) || null
  const latestEvent = pastEvents[0] || null

  return {
    routeSummaries,
    routeLayers: {
      frequent: buildRouteLayer(frequentRoute, frequentEvent, 'frequent', 'Frecuente'),
      latest: buildRouteLayer(latestRoute, latestEvent, 'latest', 'Ultima'),
    },
    history: {
      recentPasses: pastEvents.slice(0, 12).map((event) => ({
        tripId: event.runId,
        routeId: event.routeId,
        routeShortName: event.routeShortName,
        routeLongName: event.routeLongName,
        routeColor: event.routeColor,
        firstStopName: event.firstStopName,
        lastStopName: event.lastStopName,
        occurredAt: event.enteredAt,
        exitedAt: event.exitedAt,
        dayLabel: event.dayLabel,
      })),
      stats: {
        passesLast7Days: recentWeekEvents.length,
        averageIntervalHours: computeAverageIntervalHours(pastEvents.slice(0, 12)),
        estimatedIntervalHours: computeAverageIntervalHours(recentWeekEvents),
        averageIntervalDays: computeCadenceDays(pastEvents.slice(0, 12)),
        estimatedMonthlyPasses: estimateMonthlyPasses(pastEvents.slice(0, 12)),
        estimatedYearlyPasses: currentYearEvents.length,
        habitualWindow: computeHabitualWindow(pastEvents.slice(0, 20)),
        userReportsCount: 0,
        validationCount: 0,
      },
      nextEstimate: futureEvents[0]
        ? {
            tripId: futureEvents[0].runId,
            routeId: futureEvents[0].routeId,
            routeShortName: futureEvents[0].routeShortName,
            routeLongName: futureEvents[0].routeLongName,
            routeColor: futureEvents[0].routeColor,
            occurredAt: futureEvents[0].enteredAt,
            firstStopName: futureEvents[0].firstStopName,
            lastStopName: futureEvents[0].lastStopName,
          }
        : null,
    },
  }
}

function boundsFromRows(rows = []) {
  const valid = rows
    .map((row) => row?.bbox)
    .filter((bbox) =>
      bbox &&
      Number.isFinite(Number(bbox.minLat)) &&
      Number.isFinite(Number(bbox.maxLat)) &&
      Number.isFinite(Number(bbox.minLon)) &&
      Number.isFinite(Number(bbox.maxLon)),
    )

  if (!valid.length) return null

  return {
    minLat: Math.min(...valid.map((bbox) => Number(bbox.minLat))),
    maxLat: Math.max(...valid.map((bbox) => Number(bbox.maxLat))),
    minLon: Math.min(...valid.map((bbox) => Number(bbox.minLon))),
    maxLon: Math.max(...valid.map((bbox) => Number(bbox.maxLon))),
  }
}

function hasGeometry(geometry) {
  return Boolean(geometry?.type && Array.isArray(geometry?.coordinates))
}

function buildMunicipalFeature(row) {
  if (!hasGeometry(row?.geometry)) return null
  return {
    type: 'Feature',
    properties: {
      id: row.barrioId,
      slug: row.barrioId,
      nombre: row.barrioLabel,
      label: row.barrioLabel,
      geometryReady: true,
    },
    geometry: row.geometry,
  }
}

function buildMunicipalityDescriptor(municipality, barrioRows = [], { collectionReady = false } = {}) {
  if (!municipality) return null

  const bbox = municipality.bbox && Object.keys(municipality.bbox).length
    ? municipality.bbox
    : boundsFromRows(barrioRows)
  const centerLat = municipality.centerLat ?? averageCoordinate(barrioRows.map((row) => row.centerLat))
  const centerLon = municipality.centerLon ?? averageCoordinate(barrioRows.map((row) => row.centerLon))

  return {
    id: municipality.id,
    slug: municipality.slug,
    name: municipality.name,
    centerLat: Number.isFinite(Number(centerLat)) ? Number(Number(centerLat).toFixed(6)) : null,
    centerLon: Number.isFinite(Number(centerLon)) ? Number(Number(centerLon).toFixed(6)) : null,
    bbox: bbox || null,
    barrioCount: barrioRows.length,
    collectionReady,
  }
}

async function resolveCollectionMunicipality({ municipalityId = '', municipalitySlug = '' } = {}) {
  const params = []
  const filters = []
  const numericMunicipalityId = parseOptionalMunicipalityId(municipalityId)

  if (numericMunicipalityId !== null) {
    params.push(numericMunicipalityId)
    filters.push(`id = $${params.length}`)
  }

  const normalizedSlug = normalizeKey(municipalitySlug)
  if (normalizedSlug) {
    params.push(normalizedSlug)
    filters.push(`slug = $${params.length}`)
  }

  if (!filters.length) {
    params.push(DEFAULT_COLLECTION_MUNICIPALITY_SLUG)
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
  if (!row) return null

  return {
    id: Number(row.id),
    slug: row.slug,
    name: repairMojibake(row.name || row.slug),
    centerLat: row.center_lat === null || row.center_lat === undefined ? null : Number(row.center_lat),
    centerLon: row.center_lon === null || row.center_lon === undefined ? null : Number(row.center_lon),
    bbox: parseMaybeJson(row.bbox, {}),
    geometry: parseMaybeJson(row.geometry, {}),
  }
}

async function loadMunicipalBarriosForCollection(municipalityId) {
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

async function getAsuncionCollectionZoneCatalog(municipality) {
  const [coverageResult, barrioRows] = await Promise.all([
    query(`
      SELECT
        b.barrio_id,
        b.barrio_label,
        b.center_lat,
        b.center_lon,
        COUNT(DISTINCT c.route_id) AS route_count
      FROM collection_barrios b
      LEFT JOIN collection_route_barrio_coverage c ON c.barrio_id = b.barrio_id
      GROUP BY b.barrio_id, b.barrio_label, b.center_lat, b.center_lon
      ORDER BY b.barrio_label
    `),
    loadMunicipalBarriosForCollection(municipality.id),
  ])

  const geoBySlug = new Map(barrioRows.map((row) => [row.barrioId, row]))
  const zones = coverageResult.rows.map((row) => {
    const geo = geoBySlug.get(row.barrio_id)
    return {
      id: row.barrio_id,
      label: repairMojibake(row.barrio_label || row.barrio_id),
      stopCount: 1,
      routeCount: Number(row.route_count || 0),
      centerLat: Number(row.center_lat),
      centerLon: Number(row.center_lon),
      routeNames: [],
      bbox: geo?.bbox || null,
      geometryReady: hasGeometry(geo?.geometry),
    }
  })

  return {
    municipality: buildMunicipalityDescriptor(municipality, barrioRows, { collectionReady: true }),
    zones,
    features: barrioRows.map(buildMunicipalFeature).filter(Boolean),
    collectionReady: true,
  }
}

async function getMunicipalGeoZoneCatalog(municipality) {
  const storedBarrioRows = await loadMunicipalBarriosForCollection(municipality.id)
  const barrioRows = storedBarrioRows.length ? storedBarrioRows : buildFallbackCollectionBarrios(municipality)
  if (!barrioRows.length) {
    return buildGeoOnlyCollectionPlan(municipality, barrioRows)
  }
  return buildSyntheticCollectionPlan(municipality, barrioRows)
}

async function getCollectionZoneCatalog({ municipalityId = '', municipalitySlug = '' } = {}) {
  const municipality = await resolveCollectionMunicipality({ municipalityId, municipalitySlug })
  if (!municipality) {
    return {
      municipality: null,
      zones: [],
      features: [],
      collectionReady: false,
    }
  }

  if (municipality.slug === DEFAULT_COLLECTION_MUNICIPALITY_SLUG) {
    return getAsuncionCollectionZoneCatalog(municipality)
  }

  return getMunicipalGeoZoneCatalog(municipality)
}

function averageCoordinate(values) {
  if (!values.length) return null
  return values.reduce((acc, value) => acc + Number(value), 0) / values.length
}

function computeAverageIntervalHours(events) {
  if (events.length < 2) return null
  const sorted = [...events].sort((left, right) => new Date(left.enteredAt) - new Date(right.enteredAt))
  let total = 0

  for (let index = 1; index < sorted.length; index += 1) {
    total += new Date(sorted[index].enteredAt) - new Date(sorted[index - 1].enteredAt)
  }

  return Number((total / (sorted.length - 1) / (60 * 60 * 1000)).toFixed(1))
}

function computeCadenceDays(events) {
  const averageHours = computeAverageIntervalHours(events)
  if (!averageHours) return MIN_COLLECTION_INTERVAL_DAYS
  return Math.max(MIN_COLLECTION_INTERVAL_DAYS, Number((averageHours / 24).toFixed(1)))
}

function computeHabitualWindow(events) {
  if (!events.length) return null
  const counts = new Map()

  for (const event of events) {
    const hour = new Intl.DateTimeFormat('es-PY', {
      timeZone: 'America/Asuncion',
      hour: '2-digit',
      hour12: false,
    }).format(new Date(event.enteredAt))
    counts.set(hour, (counts.get(hour) || 0) + 1)
  }

  const [hour] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]
  return `${hour}:00`
}

function estimateMonthlyPasses(events) {
  if (!events.length) return 0
  const cadenceDays = computeCadenceDays(events)
  if (!cadenceDays) return 0

  const estimatedPasses = Math.round(30 / cadenceDays)
  return Math.max(1, Math.min(MAX_MONTHLY_COLLECTION_PASSES, estimatedPasses))
}

function buildHistoryEvent(row) {
  return {
    runId: row.run_id,
    routeId: row.route_id,
    routeShortName: row.route_short_name,
    routeLongName: row.route_long_name,
    routeColor: row.route_color?.startsWith('#') ? row.route_color : `#${row.route_color || '146152'}`,
    enteredAt: new Date(row.enters_at).toISOString(),
    exitedAt: new Date(row.exits_at).toISOString(),
    stopSequence: Number(row.stop_sequence),
    firstStopName: row.first_stop_name,
    lastStopName: row.last_stop_name,
    dayLabel: DAY_LABELS[new Date(row.enters_at).getUTCDay()],
  }
}

function buildRouteLayer(routeSummary, referenceEvent, kind, accent) {
  if (!routeSummary) return null

  return {
    kind,
    routeId: routeSummary.routeId,
    shortName: routeSummary.shortName,
    longName: routeSummary.longName,
    color: routeSummary.color,
    shapeId: routeSummary.shapeId,
    shapePoints: routeSummary.shapePoints || [],
    streets: routeSummary.referenceLabels,
    durationMinutes: routeSummary.durationMinutes,
    referenceDate: referenceEvent?.enteredAt || null,
    referenceStop: routeSummary.referenceStop,
    accent,
  }
}

function buildCityVehicle(vehicle) {
  return {
    vehicleId: vehicle.vehicle_id,
    routeId: vehicle.route_id,
    routeShortName: vehicle.route_short_name,
    routeLongName: vehicle.route_long_name,
    routeColor: vehicle.route_color,
    status: vehicle.status,
    currentLat: vehicle.current_lat,
    currentLon: vehicle.current_lon,
    progress: vehicle.progress,
    nextStop: vehicle.next_stop,
    sourceLabel: vehicle.source_label || 'GPS reportado por recolector',
    realtime: true,
    isEstimated: false,
  }
}

async function getRouteShapesForVehicles(vehicles) {
  const routeIds = [...new Set(vehicles.map((vehicle) => vehicle.route_id).filter(Boolean))]
  if (!routeIds.length) return {}

  const { rows } = await query(
    `
      SELECT route_id, point_lat, point_lon, cumulative_distance_m
      FROM collection_route_shapes
      WHERE route_id = ANY($1)
      ORDER BY route_id, point_sequence
    `,
    [routeIds],
  )

  const routeShapes = {}
  for (const row of rows) {
    if (!routeShapes[row.route_id]) {
      routeShapes[row.route_id] = {
        totalDistanceMeters: 0,
        points: [],
      }
    }

    const cumulativeDistanceMeters = Number(row.cumulative_distance_m || 0)
    routeShapes[row.route_id].points.push({
      lat: Number(row.point_lat),
      lon: Number(row.point_lon),
      cumulativeDistanceMeters,
    })
    routeShapes[row.route_id].totalDistanceMeters = Math.max(
      routeShapes[row.route_id].totalDistanceMeters,
      cumulativeDistanceMeters,
    )
  }

  return routeShapes
}

async function getBarrioRouteSummaries(barrioId) {
  const assets = await loadCollectionAssets()
  const servicePlanRoutes = new Map(
    (assets.servicePlan?.routes || []).map((route) => [route.id, route]),
  )

  const { rows } = await query(
    `
      SELECT
        c.route_id,
        c.barrio_id,
        c.stop_sequence,
        c.stop_lat,
        c.stop_lon,
        c.is_primary,
        b.barrio_label,
        r.route_short_name,
        r.route_long_name,
        r.route_color,
        r.shape_id,
        r.duration_minutes
      FROM collection_route_barrio_coverage c
      JOIN collection_barrios b ON b.barrio_id = c.barrio_id
      JOIN collection_routes r ON r.route_id = c.route_id
      WHERE c.barrio_id = $1
      ORDER BY c.route_id, c.stop_sequence
    `,
    [barrioId],
  )

  const routeMap = new Map()
  for (const row of rows) {
    if (!routeMap.has(row.route_id)) {
      routeMap.set(row.route_id, {
        routeId: row.route_id,
        shortName: row.route_short_name,
        longName: row.route_long_name,
        color: row.route_color?.startsWith('#') ? row.route_color : `#${row.route_color || '146152'}`,
        shapeId: row.shape_id,
        durationMinutes: Number(row.duration_minutes || 0),
        shapePoints: servicePlanRoutes.get(row.route_id)?.shape || [],
        stopMarkers: [],
        referenceLabels: [],
      })
    }

    const summary = routeMap.get(row.route_id)
    summary.stopMarkers.push({
      stopId: row.barrio_id,
      stopName: row.barrio_label,
      lat: Number(row.stop_lat),
      lon: Number(row.stop_lon),
      sequence: Number(row.stop_sequence),
      isPrimary: Boolean(row.is_primary),
    })
    summary.referenceLabels.push(row.barrio_label)
  }

  for (const summary of routeMap.values()) {
    summary.referenceStop = summary.referenceLabels.length
      ? `${summary.referenceLabels[0]} -> ${summary.referenceLabels.at(-1)}`
      : null
  }

  return [...routeMap.values()]
}

async function getBarrioHistoryRows(barrioId) {
  const [pastResult, futureResult] = await Promise.all([
    query(
      `
        SELECT
          e.run_id,
          e.route_id,
          e.barrio_id,
          e.barrio_label,
          e.stop_sequence,
          e.enters_at,
          e.exits_at,
          r.route_short_name,
          r.route_long_name,
          r.route_color,
          first_event.barrio_label AS first_stop_name,
          last_event.barrio_label AS last_stop_name
        FROM collection_run_barrio_events e
        JOIN collection_routes r ON r.route_id = e.route_id
        JOIN LATERAL (
          SELECT barrio_label
          FROM collection_run_barrio_events
          WHERE run_id = e.run_id
          ORDER BY stop_sequence
          LIMIT 1
        ) first_event ON TRUE
        JOIN LATERAL (
          SELECT barrio_label
          FROM collection_run_barrio_events
          WHERE run_id = e.run_id
          ORDER BY stop_sequence DESC
          LIMIT 1
        ) last_event ON TRUE
        WHERE e.barrio_id = $1
          AND e.enters_at <= NOW()
        ORDER BY e.enters_at DESC
        LIMIT 180
      `,
      [barrioId],
    ),
    query(
      `
        SELECT
          e.run_id,
          e.route_id,
          e.barrio_id,
          e.barrio_label,
          e.stop_sequence,
          e.enters_at,
          e.exits_at,
          r.route_short_name,
          r.route_long_name,
          r.route_color,
          first_event.barrio_label AS first_stop_name,
          last_event.barrio_label AS last_stop_name
        FROM collection_run_barrio_events e
        JOIN collection_routes r ON r.route_id = e.route_id
        JOIN LATERAL (
          SELECT barrio_label
          FROM collection_run_barrio_events
          WHERE run_id = e.run_id
          ORDER BY stop_sequence
          LIMIT 1
        ) first_event ON TRUE
        JOIN LATERAL (
          SELECT barrio_label
          FROM collection_run_barrio_events
          WHERE run_id = e.run_id
          ORDER BY stop_sequence DESC
          LIMIT 1
        ) last_event ON TRUE
        WHERE e.barrio_id = $1
          AND e.enters_at > NOW()
        ORDER BY e.enters_at ASC
        LIMIT 30
      `,
      [barrioId],
    ),
  ])

  return {
    past: pastResult.rows.map(buildHistoryEvent),
    future: futureResult.rows.map(buildHistoryEvent),
  }
}

export async function getCollectionZones({ municipalityId = '', municipalitySlug = '', includeGeometry = true } = {}) {
  const catalog = await getCollectionZoneCatalog({ municipalityId, municipalitySlug })
  return {
    municipality: catalog.municipality,
    collectionReady: catalog.collectionReady,
    zones: catalog.zones,
    features: includeGeometry ? catalog.features : [],
  }
}

export async function getCollectionMap({ includeRouteShapes = true, municipalityId = '', municipalitySlug = '' } = {}) {
  const runtime = await getCollectionRuntimeSettings()
  const zoneCatalog = await getCollectionZoneCatalog({ municipalityId, municipalitySlug })
  const isAsuncion = zoneCatalog.municipality?.slug === DEFAULT_COLLECTION_MUNICIPALITY_SLUG
  const simulationEnabled = runtime.simulationEnabled && zoneCatalog.collectionReady && isAsuncion
  const liveVehicleFeedEnabled = zoneCatalog.collectionReady && isAsuncion
  const [depotsResult, vehicles] = await Promise.all([
    zoneCatalog.collectionReady && isAsuncion
      ? query(`
        SELECT depot_id, depot_label, center_lat, center_lon
        FROM collection_depots
        ORDER BY depot_label
      `)
      : Promise.resolve({ rows: [] }),
    liveVehicleFeedEnabled
      ? getVehiclePositions({ includeSimulated: false })
      : Promise.resolve([]),
  ])
  const routeShapes = includeRouteShapes && liveVehicleFeedEnabled ? await getRouteShapesForVehicles(vehicles) : {}
  const syntheticRouteShapes = !isAsuncion && includeRouteShapes && zoneCatalog.routeSummaries
    ? Object.fromEntries(
      [...zoneCatalog.routeSummaries.values()].map((routeSummary) => [
        routeSummary.routeId,
        buildShapeMetrics(routeSummary.shapePoints),
      ]),
    )
    : {}

  return {
    municipality: zoneCatalog.municipality,
    collectionReady: zoneCatalog.collectionReady,
    vehicles: vehicles.map(buildCityVehicle),
    routeShapes: isAsuncion ? routeShapes : syntheticRouteShapes,
    zones: zoneCatalog.zones,
    depots: isAsuncion
      ? depotsResult.rows.map((row) => ({
        id: row.depot_id,
        label: row.depot_label,
        centerLat: Number(row.center_lat),
        centerLon: Number(row.center_lon),
      }))
      : (zoneCatalog.depots || []),
    generatedAt: new Date().toISOString(),
    realtime: liveVehicleFeedEnabled,
    simulationEnabled,
  }
}

export async function getCollectionOverview(zoneId, { municipalityId = '', municipalitySlug = '' } = {}) {
  const runtime = await getCollectionRuntimeSettings()
  const municipality = await resolveCollectionMunicipality({ municipalityId, municipalitySlug })
  const hasRequestedMunicipality = Boolean(String(municipalityId || '').trim() || String(municipalitySlug || '').trim())
  if (!municipality && hasRequestedMunicipality) return null
  const normalizedMunicipalitySlug = municipality?.slug || DEFAULT_COLLECTION_MUNICIPALITY_SLUG

  if (runtime.simulationEnabled && normalizedMunicipalitySlug === DEFAULT_COLLECTION_MUNICIPALITY_SLUG) {
    await ensureCollectionSimulationWindow()
  }

  const barrioId = String(zoneId || '').trim()
  if (!barrioId) return null

  if (normalizedMunicipalitySlug !== DEFAULT_COLLECTION_MUNICIPALITY_SLUG) {
    const barrioRows = await loadMunicipalBarriosForCollection(municipality?.id)
    const syntheticPlan = buildSyntheticCollectionPlan(municipality, barrioRows)
    const barrio = barrioRows.find((row) =>
      normalizeKey(row.barrioId) === normalizeKey(barrioId) ||
      normalizeKey(row.barrioLabel) === normalizeKey(barrioId),
    )
    if (!barrio) return null
    const [manualReportsResult, validationsResult, notificationsResult] = await Promise.all([
      query(
        `
          SELECT id, zone_id, route_id, address_label, notes, reported_at
          FROM collection_manual_reports
          WHERE zone_id = $1
          ORDER BY reported_at DESC
          LIMIT 6
        `,
        [barrio.barrioId],
      ),
      query(
        `
          SELECT id, zone_id, route_id, validation_status, notes, created_at
          FROM collection_route_validations
          WHERE zone_id = $1
          ORDER BY created_at DESC
          LIMIT 6
        `,
        [barrio.barrioId],
      ),
      query(
        `
          SELECT id, zone_id, event_type, channel, lead_minutes, preferred_days, time_window_start, time_window_end, active, created_at
          FROM collection_notifications
          WHERE zone_id = $1
          ORDER BY created_at DESC
          LIMIT 20
        `,
        [barrio.barrioId],
      ),
    ])
    const syntheticOverview = buildSyntheticBarrioOverview(syntheticPlan, barrio)

    return {
      simulationEnabled: runtime.simulationEnabled,
      zone: {
        id: barrio.barrioId,
        label: barrio.barrioLabel,
        routeIds: syntheticOverview.routeSummaries.map((summary) => summary.routeId),
        routeCount: syntheticOverview.routeSummaries.length,
        stopCount: syntheticOverview.routeSummaries.length,
        centerLat: Number(barrio.centerLat),
        centerLon: Number(barrio.centerLon),
        stopMarkers: syntheticOverview.routeSummaries.flatMap((summary) => summary.stopMarkers.map((marker) => ({
          stopId: marker.stopId,
          stopName: marker.stopName,
          lat: marker.lat,
          lon: marker.lon,
        }))),
      },
      routeLayers: syntheticOverview.routeLayers,
      history: {
        ...syntheticOverview.history,
        stats: {
          ...syntheticOverview.history.stats,
          userReportsCount: manualReportsResult.rows.length,
          validationCount: validationsResult.rows.length,
        },
      },
      liveVehicle: null,
      manualReports: manualReportsResult.rows,
      validations: validationsResult.rows,
      notifications: notificationsResult.rows.map((row) => ({
        ...row,
        preferred_days: Array.isArray(row.preferred_days)
          ? row.preferred_days
          : parseMaybeJson(row.preferred_days, []),
      })),
    }
  }

  const { rows: barrioRows } = await query(
    `
      SELECT barrio_id, barrio_label, center_lat, center_lon
      FROM collection_barrios
      WHERE barrio_id = $1
    `,
    [barrioId],
  )

  if (!barrioRows.length) return null

  const barrio = barrioRows[0]
  const [routeSummaries, historyRows, vehicles, manualReportsResult, validationsResult, notificationsResult] = await Promise.all([
    getBarrioRouteSummaries(barrioId),
    getBarrioHistoryRows(barrioId),
    normalizedMunicipalitySlug === DEFAULT_COLLECTION_MUNICIPALITY_SLUG
      ? getVehiclePositions({ includeSimulated: false })
      : Promise.resolve([]),
    query(
      `
        SELECT id, zone_id, route_id, address_label, notes, reported_at
        FROM collection_manual_reports
        WHERE zone_id = $1
        ORDER BY reported_at DESC
        LIMIT 6
      `,
      [barrioId],
    ),
    query(
      `
        SELECT id, zone_id, route_id, validation_status, notes, created_at
        FROM collection_route_validations
        WHERE zone_id = $1
        ORDER BY created_at DESC
        LIMIT 6
      `,
      [barrioId],
    ),
    query(
      `
        SELECT id, zone_id, event_type, channel, lead_minutes, preferred_days, time_window_start, time_window_end, active, created_at
        FROM collection_notifications
        WHERE zone_id = $1
        ORDER BY created_at DESC
        LIMIT 20
      `,
      [barrioId],
    ),
  ])

  const routeMap = new Map(routeSummaries.map((summary) => [summary.routeId, summary]))
  const now = new Date()
  const recentWeekThreshold = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000))
  const frequentThreshold = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000))
  const yearThreshold = new Date(now.getTime() - (365 * 24 * 60 * 60 * 1000))

  const recentWeekEvents = historyRows.past.filter((event) => new Date(event.enteredAt) >= recentWeekThreshold)
  const frequentEvents = historyRows.past.filter((event) => new Date(event.enteredAt) >= frequentThreshold)
  const currentYearEvents = historyRows.past.filter((event) => new Date(event.enteredAt) >= yearThreshold)

  const routeCounts = new Map()
  for (const event of frequentEvents) {
    routeCounts.set(event.routeId, (routeCounts.get(event.routeId) || 0) + 1)
  }

  const frequentRouteId =
    [...routeCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ||
    routeSummaries[0]?.routeId ||
    null
  const latestEvent = historyRows.past[0] || null
  const frequentEvent = historyRows.past.find((event) => event.routeId === frequentRouteId) || null
  const latestRoute = latestEvent ? routeMap.get(latestEvent.routeId) : null
  const frequentRoute = frequentRouteId ? routeMap.get(frequentRouteId) : null
  const nextEstimate = historyRows.future[0] || null
  const liveVehicle = vehicles.find((vehicle) => vehicle.current_barrio_id === barrioId) || null

  return {
    simulationEnabled: runtime.simulationEnabled,
    zone: {
      id: barrio.barrio_id,
      label: barrio.barrio_label,
      routeIds: routeSummaries.map((summary) => summary.routeId),
      routeCount: routeSummaries.length,
      stopCount: routeSummaries.length,
      centerLat: Number(barrio.center_lat),
      centerLon: Number(barrio.center_lon),
      stopMarkers: routeSummaries.flatMap((summary) => summary.stopMarkers.map((marker) => ({
        stopId: marker.stopId,
        stopName: marker.stopName,
        lat: marker.lat,
        lon: marker.lon,
      }))),
    },
    routeLayers: {
      frequent: buildRouteLayer(frequentRoute, frequentEvent, 'frequent', 'Frecuente'),
      latest: buildRouteLayer(latestRoute, latestEvent, 'latest', 'Ultima'),
    },
    history: {
      recentPasses: historyRows.past.slice(0, 12).map((event) => ({
        tripId: event.runId,
        routeId: event.routeId,
        routeShortName: event.routeShortName,
        routeLongName: event.routeLongName,
        routeColor: event.routeColor,
        firstStopName: event.firstStopName,
        lastStopName: event.lastStopName,
        occurredAt: event.enteredAt,
        exitedAt: event.exitedAt,
        dayLabel: event.dayLabel,
      })),
      stats: {
        passesLast7Days: recentWeekEvents.length,
        averageIntervalHours: computeAverageIntervalHours(historyRows.past.slice(0, 12)),
        estimatedIntervalHours: computeAverageIntervalHours(recentWeekEvents),
        averageIntervalDays: computeCadenceDays(historyRows.past.slice(0, 12)),
          estimatedMonthlyPasses: estimateMonthlyPasses(historyRows.past.slice(0, 12)),
        estimatedYearlyPasses: currentYearEvents.length,
        habitualWindow: computeHabitualWindow(historyRows.past.slice(0, 20)),
        userReportsCount: manualReportsResult.rows.length,
        validationCount: validationsResult.rows.length,
      },
      nextEstimate: nextEstimate
        ? {
            tripId: nextEstimate.runId,
            routeId: nextEstimate.routeId,
            routeShortName: nextEstimate.routeShortName,
            routeLongName: nextEstimate.routeLongName,
            routeColor: nextEstimate.routeColor,
            occurredAt: nextEstimate.enteredAt,
            firstStopName: nextEstimate.firstStopName,
            lastStopName: nextEstimate.lastStopName,
          }
        : null,
    },
    liveVehicle: liveVehicle
      ? {
          vehicleId: liveVehicle.vehicle_id,
          routeId: liveVehicle.route_id,
          routeShortName: liveVehicle.route_short_name,
          routeLongName: liveVehicle.route_long_name,
          routeColor: liveVehicle.route_color,
          status: liveVehicle.status,
          currentLat: liveVehicle.current_lat,
          currentLon: liveVehicle.current_lon,
          progress: liveVehicle.progress,
          nextStop: liveVehicle.next_stop,
          sourceLabel: liveVehicle.source_label || 'GPS reportado por recolector',
          realtime: true,
          isEstimated: false,
          updatedAt: liveVehicle.updated_at,
        }
      : null,
    manualReports: manualReportsResult.rows,
    validations: validationsResult.rows,
    notifications: notificationsResult.rows.map((row) => ({
      ...row,
      preferred_days: Array.isArray(row.preferred_days) ? row.preferred_days : [],
    })),
  }
}

export async function saveCollectionManualReport({ zoneId, routeId, addressLabel, notes }) {
  const { rows } = await query(
    `
      INSERT INTO collection_manual_reports (zone_id, route_id, address_label, notes)
      VALUES ($1, $2, $3, $4)
      RETURNING id, zone_id, route_id, address_label, notes, reported_at
    `,
    [zoneId, routeId || null, addressLabel || null, notes || null],
  )

  return rows[0]
}

export async function saveCollectionRouteValidation({ zoneId, routeId, validationStatus, notes }) {
  const { rows } = await query(
    `
      INSERT INTO collection_route_validations (zone_id, route_id, validation_status, notes)
      VALUES ($1, $2, $3, $4)
      RETURNING id, zone_id, route_id, validation_status, notes, created_at
    `,
    [zoneId, routeId || null, validationStatus, notes || null],
  )

  return rows[0]
}

export async function saveCollectionNotification({
  userId,
  zoneId,
  eventType,
  channel,
  leadMinutes,
  preferredDays,
  timeWindowStart,
  timeWindowEnd,
}) {
  const { rows } = await query(
    `
      INSERT INTO collection_notifications (
        zone_id,
        event_type,
        channel,
        lead_minutes,
        preferred_days,
        time_window_start,
        time_window_end,
        user_id,
        active
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, TRUE)
      RETURNING id, zone_id, event_type, channel, lead_minutes, preferred_days, time_window_start, time_window_end, user_id, active, created_at
    `,
    [
      zoneId,
      eventType,
      channel,
      leadMinutes,
      JSON.stringify(Array.isArray(preferredDays) ? preferredDays : []),
      timeWindowStart || null,
      timeWindowEnd || null,
      userId || null,
    ],
  )

  return rows[0]
}

function normalizeNotification(row) {
  return {
    ...row,
    preferred_days: Array.isArray(row.preferred_days) ? row.preferred_days : [],
  }
}

export async function listCollectionNotifications(zoneId = '', { userId } = {}) {
  const normalizedUserId = Number(userId)
  if (!Number.isFinite(normalizedUserId)) return []

  const hasZone = String(zoneId || '').trim().length > 0
  const { rows } = await query(
    `
      SELECT id, zone_id, event_type, channel, lead_minutes, preferred_days, time_window_start, time_window_end, user_id, active, created_at
      FROM collection_notifications
      WHERE active = TRUE
        AND user_id = $1
      ${hasZone ? 'AND zone_id = $2' : ''}
      ORDER BY created_at DESC
    `,
    hasZone ? [normalizedUserId, zoneId] : [normalizedUserId],
  )

  return rows.map(normalizeNotification)
}

export async function deleteCollectionNotification(notificationId, { userId } = {}) {
  const normalizedUserId = Number(userId)
  if (!Number.isFinite(normalizedUserId)) return null

  const { rows } = await query(
    `
      DELETE FROM collection_notifications
      WHERE id = $1
        AND user_id = $2
      RETURNING id
    `,
    [notificationId, normalizedUserId],
  )

  return rows[0] || null
}
