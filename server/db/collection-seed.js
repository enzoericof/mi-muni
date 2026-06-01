import { query } from './index.js'
import {
  addDaysToDateKey,
  asuncionDateTimeToUtc,
  buildShapeMetrics,
  COLLECTION_FUTURE_DAYS,
  COLLECTION_HISTORY_DAYS,
  geometryBounds,
  geometryCenter,
  getAsuncionDateKey,
  getDayNameForDateKey,
  gtfsTimeToMinutes,
  loadCollectionAssets,
  minutesToGtfsTime,
  slugify,
} from '../lib/collectionCore.js'

const AVG_TRAVEL_SPEED_KMH = 22
const DWELL_MINUTES_PER_BARRIO = 4
const EXIT_BUFFER_MINUTES = 3
const ROUTE_END_BUFFER_MINUTES = 8

let ensurePromise = null
let lastEnsureDateKey = ''

async function batchInsert(tableName, columns, rows, { chunkSize = 250, casts = {}, onConflict = '' } = {}) {
  if (!rows.length) return []

  const results = []
  for (let start = 0; start < rows.length; start += chunkSize) {
    const slice = rows.slice(start, start + chunkSize)
    const values = []
    const placeholders = []

    slice.forEach((row, rowIndex) => {
      const columnPlaceholders = columns.map((column, columnIndex) => {
        const parameterIndex = (rowIndex * columns.length) + columnIndex + 1
        values.push(row[column])
        return `$${parameterIndex}${casts[column] ? `::${casts[column]}` : ''}`
      })
      placeholders.push(`(${columnPlaceholders.join(', ')})`)
    })

    const sql = `
      INSERT INTO ${tableName} (${columns.join(', ')})
      VALUES ${placeholders.join(', ')}
      ${onConflict}
    `
    const { rows: insertedRows } = await query(sql, values)
    results.push(...insertedRows)
  }

  return results
}

function routeShapeId(routeId) {
  return `COL-${routeId}`
}

function normalizeRouteLongName(value) {
  return String(value || '').replace(/\s*·\s*/g, ' - ').replace(/\s+/g, ' ').trim()
}

function buildCalendarFlags(days = []) {
  const normalizedDays = new Set(days.map((day) => String(day || '').toLowerCase()))
  return {
    sunday: normalizedDays.has('sunday'),
    monday: normalizedDays.has('monday'),
    tuesday: normalizedDays.has('tuesday'),
    wednesday: normalizedDays.has('wednesday'),
    thursday: normalizedDays.has('thursday'),
    friday: normalizedDays.has('friday'),
    saturday: normalizedDays.has('saturday'),
  }
}

function estimateRouteTimings(route, shapeMetrics) {
  const barrioCount = route.barrios.length
  const travelMinutes = Math.max(
    36,
    Math.round(((shapeMetrics.totalDistanceMeters / 1000) / AVG_TRAVEL_SPEED_KMH) * 60),
  )

  const totalDistance = Math.max(shapeMetrics.totalDistanceMeters, 1)
  const coverage = route.barrios.map((barrio, index) => {
    const anchorIndex = Number(route.anchorIndexes?.[index] ?? 0)
    const anchorPoint = shapeMetrics.points[Math.min(anchorIndex, shapeMetrics.points.length - 1)]
    const travelProgressMinutes = Math.round((anchorPoint.cumulativeDistanceMeters / totalDistance) * travelMinutes)
    const arrivalOffsetMinutes = travelProgressMinutes + (index * DWELL_MINUTES_PER_BARRIO)
    const exitOffsetMinutes = arrivalOffsetMinutes + EXIT_BUFFER_MINUTES

    return {
      barrioId: barrio.id,
      barrioLabel: barrio.label,
      sequence: Number(barrio.sequence || index + 1),
      stopLat: Number(barrio.lat),
      stopLon: Number(barrio.lon),
      anchorPointIndex: anchorIndex + 1,
      arrivalOffsetMinutes,
      exitOffsetMinutes,
      isPrimary: Boolean(barrio.isPrimary ?? true),
    }
  })

  const lastExitOffset = coverage.at(-1)?.exitOffsetMinutes ?? 0
  const durationMinutes = Math.max(
    travelMinutes + (barrioCount * DWELL_MINUTES_PER_BARRIO),
    lastExitOffset + ROUTE_END_BUFFER_MINUTES,
  )

  return {
    coverage,
    durationMinutes,
    travelMinutes,
  }
}

async function truncateCollectionTables() {
  await query(`
    TRUNCATE TABLE
      collection_run_barrio_events,
      collection_runs,
      collection_route_barrio_coverage,
      collection_route_shapes,
      collection_service_patterns,
      collection_trucks,
      collection_routes,
      collection_depots,
      collection_barrios,
      collection_manual_reports,
      collection_route_validations,
      collection_notifications,
      gtfs_stop_times,
      gtfs_trips,
      gtfs_shapes,
      gtfs_stops,
      gtfs_routes,
      gtfs_calendar,
      gtfs_agency
    RESTART IDENTITY CASCADE
  `)
}

async function insertBarrios(barriosGeojson) {
  const rows = []
  for (const feature of barriosGeojson.features || []) {
    const properties = feature.properties || {}
    const geometry = feature.geometry || null
    const center = {
      lat: Number(properties.centerLat ?? geometryCenter(geometry)?.lat ?? 0),
      lon: Number(properties.centerLon ?? geometryCenter(geometry)?.lon ?? 0),
    }
    const bounds = geometryBounds(geometry)
    const barrioId = properties.slug || slugify(properties.nombre)

    rows.push({
      barrio_id: barrioId,
      barrio_label: String(properties.nombre || barrioId),
      zone_number: properties.zona ?? null,
      center_lat: center.lat,
      center_lon: center.lon,
      bbox: JSON.stringify(bounds || {}),
      geometry: JSON.stringify(geometry || {}),
    })
  }

  await batchInsert(
    'collection_barrios',
    ['barrio_id', 'barrio_label', 'zone_number', 'center_lat', 'center_lon', 'bbox', 'geometry'],
    rows,
    { casts: { bbox: 'jsonb', geometry: 'jsonb' } },
  )
}

async function insertDepotsAndTrucks(servicePlan) {
  await batchInsert(
    'collection_depots',
    ['depot_id', 'depot_label', 'center_lat', 'center_lon'],
    (servicePlan.depots || []).map((depot) => ({
      depot_id: depot.id,
      depot_label: depot.label,
      center_lat: depot.lat,
      center_lon: depot.lon,
    })),
  )

  await batchInsert(
    'collection_trucks',
    ['truck_id', 'truck_label', 'depot_id', 'active'],
    (servicePlan.trucks || []).map((truck) => ({
      truck_id: truck.id,
      truck_label: truck.label,
      depot_id: truck.depotId,
      active: truck.active !== false,
    })),
  )
}

async function insertRoutes(servicePlan) {
  const routeSummaries = new Map()
  const routeRows = []
  const shapeRows = []
  const coverageRows = []
  const patternRows = []

  for (const route of servicePlan.routes || []) {
    const shapeMetrics = buildShapeMetrics(route.shape || [])
    const timings = estimateRouteTimings(route, shapeMetrics)
    const shapeId = routeShapeId(route.id)
    const longName = normalizeRouteLongName(route.longName)

    routeRows.push({
      route_id: route.id,
      route_short_name: route.shortName,
      route_long_name: longName,
      route_color: route.color,
      depot_id: route.depotId,
      shape_id: shapeId,
      total_distance_m: shapeMetrics.totalDistanceMeters,
      travel_minutes: timings.travelMinutes,
      duration_minutes: timings.durationMinutes,
    })

    for (const point of shapeMetrics.points) {
      shapeRows.push({
        route_id: route.id,
        shape_id: shapeId,
        point_sequence: point.sequence,
        point_lat: point.lat,
        point_lon: point.lon,
        cumulative_distance_m: point.cumulativeDistanceMeters,
      })
    }

    for (const coverage of timings.coverage) {
      coverageRows.push({
        route_id: route.id,
        barrio_id: coverage.barrioId,
        stop_sequence: coverage.sequence,
        stop_lat: coverage.stopLat,
        stop_lon: coverage.stopLon,
        anchor_point_index: coverage.anchorPointIndex,
        arrival_offset_minutes: coverage.arrivalOffsetMinutes,
        exit_offset_minutes: coverage.exitOffsetMinutes,
        is_primary: coverage.isPrimary,
      })
    }

    for (const pattern of route.servicePatterns || []) {
      patternRows.push({
        service_pattern_id: pattern.id,
        route_id: route.id,
        truck_id: pattern.truckId,
        pattern_label: pattern.label || pattern.id,
        service_days: JSON.stringify(pattern.days || []),
        start_time: pattern.startTime,
      })
    }

    routeSummaries.set(route.id, {
      route,
      shapeMetrics,
      timings,
      longName,
      shapeId,
    })
  }

  await batchInsert(
    'collection_routes',
    [
      'route_id',
      'route_short_name',
      'route_long_name',
      'route_color',
      'depot_id',
      'shape_id',
      'total_distance_m',
      'travel_minutes',
      'duration_minutes',
    ],
    routeRows,
  )

  await batchInsert(
    'collection_route_shapes',
    ['route_id', 'shape_id', 'point_sequence', 'point_lat', 'point_lon', 'cumulative_distance_m'],
    shapeRows,
    { chunkSize: 500 },
  )

  await batchInsert(
    'collection_route_barrio_coverage',
    [
      'route_id',
      'barrio_id',
      'stop_sequence',
      'stop_lat',
      'stop_lon',
      'anchor_point_index',
      'arrival_offset_minutes',
      'exit_offset_minutes',
      'is_primary',
    ],
    coverageRows,
  )

  await batchInsert(
    'collection_service_patterns',
    ['service_pattern_id', 'route_id', 'truck_id', 'pattern_label', 'service_days', 'start_time'],
    patternRows,
    { casts: { service_days: 'jsonb' } },
  )

  return routeSummaries
}

async function rebuildGtfsCompatibility(routeSummaries, barriosGeojson) {
  const startDate = '2025-01-01'
  const endDate = '2026-12-31'

  await batchInsert(
    'gtfs_agency',
    ['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang'],
    [{
      agency_id: 'ASU-MUN-COL',
      agency_name: 'Municipalidad de Asuncion - Recoleccion de Residuos',
      agency_url: 'https://www.asuncion.gov.py',
      agency_timezone: 'America/Asuncion',
      agency_lang: 'es',
    }],
  )

  const stopRows = []
  for (const feature of barriosGeojson.features || []) {
    const properties = feature.properties || {}
    const barrioId = properties.slug || slugify(properties.nombre)
    stopRows.push({
      stop_id: `BR-${barrioId}`,
      stop_name: properties.nombre,
      stop_lat: Number(properties.centerLat),
      stop_lon: Number(properties.centerLon),
      stop_desc: `Barrio ${properties.nombre}`,
      zone_id: barrioId,
    })
  }
  await batchInsert(
    'gtfs_stops',
    ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'stop_desc', 'zone_id'],
    stopRows,
  )

  const routeRows = []
  const shapeRows = []
  const calendarRows = []
  const tripRows = []
  const stopTimeRows = []

  for (const [routeId, summary] of routeSummaries.entries()) {
    const { route, shapeMetrics, timings, longName, shapeId } = summary

    routeRows.push({
      route_id: routeId,
      agency_id: 'ASU-MUN-COL',
      route_short_name: route.shortName,
      route_long_name: longName,
      route_type: 3,
      route_color: route.color,
      route_text_color: 'FFFFFF',
      route_desc: `Recorrido de recoleccion con base ${route.depotId}`,
      report_count: 0,
    })

    for (const point of shapeMetrics.points) {
      shapeRows.push({
        shape_id: shapeId,
        shape_pt_lat: point.lat,
        shape_pt_lon: point.lon,
        shape_pt_sequence: point.sequence,
      })
    }

    for (const pattern of route.servicePatterns || []) {
      const flags = buildCalendarFlags(pattern.days || [])
      calendarRows.push({
        service_id: pattern.id,
        monday: flags.monday,
        tuesday: flags.tuesday,
        wednesday: flags.wednesday,
        thursday: flags.thursday,
        friday: flags.friday,
        saturday: flags.saturday,
        sunday: flags.sunday,
        start_date: startDate,
        end_date: endDate,
      })

      tripRows.push({
        trip_id: pattern.id,
        route_id: routeId,
        service_id: pattern.id,
        trip_headsign: `${longName} - ${pattern.label || pattern.id}`,
        shape_id: shapeId,
        direction_id: 0,
      })

      const startMinutes = gtfsTimeToMinutes(pattern.startTime)
      for (const coverage of timings.coverage) {
        stopTimeRows.push({
          trip_id: pattern.id,
          stop_id: `BR-${coverage.barrioId}`,
          arrival_time: minutesToGtfsTime(startMinutes + coverage.arrivalOffsetMinutes),
          departure_time: minutesToGtfsTime(startMinutes + coverage.exitOffsetMinutes),
          stop_sequence: coverage.sequence,
        })
      }
    }
  }

  await batchInsert(
    'gtfs_routes',
    [
      'route_id',
      'agency_id',
      'route_short_name',
      'route_long_name',
      'route_type',
      'route_color',
      'route_text_color',
      'route_desc',
      'report_count',
    ],
    routeRows,
  )

  await batchInsert(
    'gtfs_shapes',
    ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'],
    shapeRows,
    { chunkSize: 500 },
  )

  await batchInsert(
    'gtfs_calendar',
    [
      'service_id',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
      'start_date',
      'end_date',
    ],
    calendarRows,
  )

  await batchInsert(
    'gtfs_trips',
    ['trip_id', 'route_id', 'service_id', 'trip_headsign', 'shape_id', 'direction_id'],
    tripRows,
  )

  await batchInsert(
    'gtfs_stop_times',
    ['trip_id', 'stop_id', 'arrival_time', 'departure_time', 'stop_sequence'],
    stopTimeRows,
    { chunkSize: 500 },
  )
}

export async function seedCollectionData({ force = false } = {}) {
  const { rows: seedStatusRows } = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM collection_routes) AS routes_count,
      (SELECT COUNT(*)::int FROM collection_route_barrio_coverage) AS coverage_count,
      (SELECT COUNT(*)::int FROM collection_service_patterns) AS patterns_count,
      (SELECT COUNT(*)::int FROM gtfs_routes) AS gtfs_routes_count
  `)
  const seedStatus = seedStatusRows[0]
  const alreadySeeded =
    Number(seedStatus.routes_count || 0) > 0 &&
    Number(seedStatus.coverage_count || 0) > 0 &&
    Number(seedStatus.patterns_count || 0) > 0 &&
    Number(seedStatus.gtfs_routes_count || 0) > 0

  if (alreadySeeded && !force) {
    console.log('[seed] Collection backend ya cargado, se omite el reseed.')
    return
  }

  const shouldForce = force || Number(seedStatus.routes_count || 0) > 0
  console.log(shouldForce ? '[seed] Forzando reseed de collection backend...' : '[seed] Sembrando collection backend...')
  const assets = await loadCollectionAssets()
  await truncateCollectionTables()
  lastEnsureDateKey = ''
  await insertBarrios(assets.barriosGeojson)
  await insertDepotsAndTrucks(assets.servicePlan)
  const routeSummaries = await insertRoutes(assets.servicePlan)
  await rebuildGtfsCompatibility(routeSummaries, assets.barriosGeojson)

  console.log(
    `[seed] Collection OK: ${assets.barriosGeojson.features.length} barrios | ${assets.servicePlan.depots.length} bases | ${assets.servicePlan.trucks.length} camiones | ${assets.servicePlan.routes.length} rutas`,
  )
}

async function getPatternRows() {
  const { rows } = await query(`
    SELECT
      sp.service_pattern_id,
      sp.route_id,
      sp.truck_id,
      sp.pattern_label,
      sp.service_days,
      sp.start_time,
      r.duration_minutes
    FROM collection_service_patterns sp
    JOIN collection_routes r ON r.route_id = sp.route_id
    ORDER BY sp.route_id, sp.service_pattern_id
  `)

  return rows.map((row) => ({
    ...row,
    service_days: Array.isArray(row.service_days) ? row.service_days : [],
    duration_minutes: Number(row.duration_minutes || 0),
  }))
}

async function getCoverageRowsByRoute() {
  const { rows } = await query(`
    SELECT
      c.route_id,
      c.barrio_id,
      b.barrio_label,
      c.stop_sequence,
      c.stop_lat,
      c.stop_lon,
      c.anchor_point_index,
      c.arrival_offset_minutes,
      c.exit_offset_minutes,
      c.is_primary
    FROM collection_route_barrio_coverage c
    JOIN collection_barrios b ON b.barrio_id = c.barrio_id
    ORDER BY c.route_id, c.stop_sequence
  `)

  const grouped = new Map()
  for (const row of rows) {
    if (!grouped.has(row.route_id)) grouped.set(row.route_id, [])
    grouped.get(row.route_id).push({
      barrioId: row.barrio_id,
      barrioLabel: row.barrio_label,
      stopSequence: Number(row.stop_sequence),
      stopLat: Number(row.stop_lat),
      stopLon: Number(row.stop_lon),
      anchorPointIndex: Number(row.anchor_point_index),
      arrivalOffsetMinutes: Number(row.arrival_offset_minutes),
      exitOffsetMinutes: Number(row.exit_offset_minutes),
      isPrimary: Boolean(row.is_primary),
    })
  }

  return grouped
}

async function deleteRunsOutsideWindow(fromDateKey, toDateKey) {
  await query(
    `
      DELETE FROM collection_run_barrio_events
      WHERE run_id IN (
        SELECT run_id FROM collection_runs
        WHERE service_date < $1 OR service_date > $2
      )
    `,
    [fromDateKey, toDateKey],
  )

  await query(
    `
      DELETE FROM collection_runs
      WHERE service_date < $1 OR service_date > $2
    `,
    [fromDateKey, toDateKey],
  )
}

async function materializeSimulationWindow() {
  const todayKey = getAsuncionDateKey()
  const fromDateKey = addDaysToDateKey(todayKey, -COLLECTION_HISTORY_DAYS)
  const toDateKey = addDaysToDateKey(todayKey, COLLECTION_FUTURE_DAYS)
  const patterns = await getPatternRows()
  const coverageByRoute = await getCoverageRowsByRoute()

  await deleteRunsOutsideWindow(fromDateKey, toDateKey)

  const runDefinitions = []
  for (let offset = -COLLECTION_HISTORY_DAYS; offset <= COLLECTION_FUTURE_DAYS; offset += 1) {
    const dateKey = addDaysToDateKey(todayKey, offset)
    const dayName = getDayNameForDateKey(dateKey)

    for (const pattern of patterns) {
      if (!pattern.service_days.includes(dayName)) continue
      const runKey = `${pattern.service_pattern_id}:${dateKey}`
      const startsAt = asuncionDateTimeToUtc(dateKey, pattern.start_time)
      const endsAt = new Date(startsAt.getTime() + (pattern.duration_minutes * 60 * 1000))
      runDefinitions.push({
        run_key: runKey,
        route_id: pattern.route_id,
        service_pattern_id: pattern.service_pattern_id,
        truck_id: pattern.truck_id,
        service_date: dateKey,
        starts_at: startsAt,
        ends_at: endsAt,
      })
    }
  }

  const insertedRuns = await batchInsert(
    'collection_runs',
    ['run_key', 'route_id', 'service_pattern_id', 'truck_id', 'service_date', 'starts_at', 'ends_at'],
    runDefinitions,
    {
      onConflict: `
        ON CONFLICT (run_key)
        DO UPDATE SET
          route_id = EXCLUDED.route_id,
          service_pattern_id = EXCLUDED.service_pattern_id,
          truck_id = EXCLUDED.truck_id,
          service_date = EXCLUDED.service_date,
          starts_at = EXCLUDED.starts_at,
          ends_at = EXCLUDED.ends_at
        RETURNING run_id, run_key, route_id, truck_id, starts_at
      `,
    },
  )

  const runIdByKey = new Map(insertedRuns.map((row) => [row.run_key, row]))
  const eventDefinitions = []

  for (const runDefinition of runDefinitions) {
    const runRow = runIdByKey.get(runDefinition.run_key)
    if (!runRow) continue
    const coverageRows = coverageByRoute.get(runDefinition.route_id) || []
    for (const coverage of coverageRows) {
      eventDefinitions.push({
        run_id: runRow.run_id,
        route_id: runDefinition.route_id,
        truck_id: runDefinition.truck_id,
        barrio_id: coverage.barrioId,
        barrio_label: coverage.barrioLabel,
        stop_sequence: coverage.stopSequence,
        enters_at: new Date(new Date(runRow.starts_at).getTime() + (coverage.arrivalOffsetMinutes * 60 * 1000)),
        exits_at: new Date(new Date(runRow.starts_at).getTime() + (coverage.exitOffsetMinutes * 60 * 1000)),
        stop_lat: coverage.stopLat,
        stop_lon: coverage.stopLon,
        is_primary: coverage.isPrimary,
      })
    }
  }

  await batchInsert(
    'collection_run_barrio_events',
    [
      'run_id',
      'route_id',
      'truck_id',
      'barrio_id',
      'barrio_label',
      'stop_sequence',
      'enters_at',
      'exits_at',
      'stop_lat',
      'stop_lon',
      'is_primary',
    ],
    eventDefinitions,
    {
      chunkSize: 400,
      onConflict: `
        ON CONFLICT (run_id, barrio_id, stop_sequence)
        DO UPDATE SET
          route_id = EXCLUDED.route_id,
          truck_id = EXCLUDED.truck_id,
          barrio_label = EXCLUDED.barrio_label,
          enters_at = EXCLUDED.enters_at,
          exits_at = EXCLUDED.exits_at,
          stop_lat = EXCLUDED.stop_lat,
          stop_lon = EXCLUDED.stop_lon,
          is_primary = EXCLUDED.is_primary
      `,
    },
  )

  lastEnsureDateKey = todayKey
}

export async function ensureCollectionSimulationWindow() {
  const todayKey = getAsuncionDateKey()
  if (lastEnsureDateKey === todayKey) return
  if (ensurePromise) return ensurePromise

  ensurePromise = materializeSimulationWindow().finally(() => {
    ensurePromise = null
  })

  return ensurePromise
}
