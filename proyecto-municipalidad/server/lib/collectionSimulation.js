import { query } from '../db/index.js'
import {
  COLLECTION_INTERPOLATION_MAX_SEGMENT_METERS,
  geometryContainsPoint,
  loadCollectionAssets,
} from './collectionCore.js'
import { ensureCollectionSimulationWindow } from '../db/collection-seed.js'
import { isCollectionSimulationEnabled } from './collectionRuntime.js'

const COLLECTION_SIMULATION_MAX_PROGRESS = 0.9995
const COLLECTION_SIMULATION_MIN_VISIBLE_VEHICLES = 10
const COLLECTION_SIMULATION_ROUTE_SPEED_KPH = 18
const COLLECTION_SIMULATION_DWELL_SECONDS = 7
const COLLECTION_SIMULATION_DEPOT_ORDER = ['DEP-N', 'DEP-C', 'DEP-S']

let runtimeCachePromise = null

function buildRouteColor(value) {
  return String(value || '').startsWith('#') ? String(value) : `#${value || '146152'}`
}

function hashText(value) {
  const text = String(value || '')
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 31) + text.charCodeAt(index)) >>> 0
  }
  return hash
}

function buildTruckLabelById(assets) {
  return new Map((assets.servicePlan?.trucks || []).map((truck) => [truck.id, truck.label || truck.id]))
}

function buildFleetAssignments(assets) {
  const routesByDepot = new Map()
  for (const route of assets.servicePlan?.routes || []) {
    if (!routesByDepot.has(route.depotId)) routesByDepot.set(route.depotId, [])
    routesByDepot.get(route.depotId).push(route)
  }

  const assignments = []
  let roundIndex = 0
  while (assignments.length < COLLECTION_SIMULATION_MIN_VISIBLE_VEHICLES) {
    let pickedInRound = false
    for (const depotId of COLLECTION_SIMULATION_DEPOT_ORDER) {
      const routes = routesByDepot.get(depotId) || []
      if (roundIndex >= routes.length) continue
      assignments.push(routes[roundIndex])
      pickedInRound = true
      if (assignments.length >= COLLECTION_SIMULATION_MIN_VISIBLE_VEHICLES) break
    }
    if (!pickedInRound) break
    roundIndex += 1
  }

  return assignments
}

function buildRouteTimeline(route, shapePoints = []) {
  if (!shapePoints.length) return null

  const totalDistanceMeters = Number(shapePoints.at(-1)?.cumulativeDistanceMeters || 0)
  if (!Number.isFinite(totalDistanceMeters) || totalDistanceMeters <= 0) return null

  const speedMetersPerSecond = (COLLECTION_SIMULATION_ROUTE_SPEED_KPH * 1000) / 3600
  const anchorRows = (route.barrios || []).map((barrio, index) => {
    const anchorIndex = Math.min(
      Math.max(0, Number(route.anchorIndexes?.[index] ?? 0)),
      shapePoints.length - 1,
    )
    const anchorPoint = shapePoints[anchorIndex]
    return {
      barrioId: barrio.id,
      barrioLabel: barrio.label,
      anchorIndex,
      anchorPoint,
    }
  })
  const anchorByIndex = new Map(anchorRows.map((anchor) => [anchor.anchorIndex, anchor]))

  const segments = []
  const stopWindows = []
  let elapsedSeconds = 0

  for (let index = 1; index < shapePoints.length; index += 1) {
    const previous = shapePoints[index - 1]
    const next = shapePoints[index]
    const segmentDistanceMeters = Number(next.cumulativeDistanceMeters - previous.cumulativeDistanceMeters)
    if (!Number.isFinite(segmentDistanceMeters) || segmentDistanceMeters <= 0) continue

    if (segmentDistanceMeters <= COLLECTION_INTERPOLATION_MAX_SEGMENT_METERS) {
      const segmentDurationSeconds = Math.max(1, segmentDistanceMeters / speedMetersPerSecond)
      segments.push({
        kind: 'move',
        startSeconds: elapsedSeconds,
        endSeconds: elapsedSeconds + segmentDurationSeconds,
        from: previous,
        to: next,
        startDistanceMeters: Number(previous.cumulativeDistanceMeters || 0),
        endDistanceMeters: Number(next.cumulativeDistanceMeters || 0),
      })
      elapsedSeconds += segmentDurationSeconds
    }

    const anchor = anchorByIndex.get(index)
    if (anchor) {
      stopWindows.push({
        barrioId: anchor.barrioId,
        barrioLabel: anchor.barrioLabel,
        point: anchor.anchorPoint,
        startSeconds: elapsedSeconds,
        endSeconds: elapsedSeconds + COLLECTION_SIMULATION_DWELL_SECONDS,
      })
      segments.push({
        kind: 'dwell',
        startSeconds: elapsedSeconds,
        endSeconds: elapsedSeconds + COLLECTION_SIMULATION_DWELL_SECONDS,
        point: anchor.anchorPoint,
        barrioId: anchor.barrioId,
        barrioLabel: anchor.barrioLabel,
        distanceMeters: Number(anchor.anchorPoint?.cumulativeDistanceMeters || 0),
      })
      elapsedSeconds += COLLECTION_SIMULATION_DWELL_SECONDS
    }
  }

  if (!segments.length) {
    const firstPoint = shapePoints[0]
    segments.push({
      kind: 'dwell',
      startSeconds: 0,
      endSeconds: COLLECTION_SIMULATION_DWELL_SECONDS,
      point: firstPoint,
      barrioId: anchorRows[0]?.barrioId || null,
      barrioLabel: anchorRows[0]?.barrioLabel || null,
      distanceMeters: Number(firstPoint.cumulativeDistanceMeters || 0),
    })
    elapsedSeconds = COLLECTION_SIMULATION_DWELL_SECONDS
  }

  return {
    totalDistanceMeters,
    cycleDurationSeconds: Math.max(1, elapsedSeconds),
    segments,
    stopWindows,
  }
}

function getTimelineState(routeSummary, phaseSeconds) {
  const timeline = routeSummary?.timeline
  if (!timeline) return null

  const normalizedPhase = ((phaseSeconds % timeline.cycleDurationSeconds) + timeline.cycleDurationSeconds) % timeline.cycleDurationSeconds
  const segment =
    timeline.segments.find((item) => normalizedPhase >= item.startSeconds && normalizedPhase < item.endSeconds) ||
    timeline.segments.at(-1) ||
    null

  if (!segment) return null

  const activeStop =
    timeline.stopWindows.find((window) => normalizedPhase >= window.startSeconds && normalizedPhase < window.endSeconds) ||
    null
  const nextStop =
    timeline.stopWindows.find((window) => window.startSeconds > normalizedPhase) ||
    timeline.stopWindows[0] ||
    null
  const secondsUntilNextStop = nextStop
    ? nextStop.startSeconds > normalizedPhase
      ? nextStop.startSeconds - normalizedPhase
      : (timeline.cycleDurationSeconds - normalizedPhase) + nextStop.startSeconds
    : null

  if (segment.kind === 'dwell') {
    return {
      lat: Number(segment.point?.lat || 0),
      lon: Number(segment.point?.lon || 0),
      progress: Number(
        Math.min(
          COLLECTION_SIMULATION_MAX_PROGRESS,
          Math.max(0, Number(segment.distanceMeters || 0) / Math.max(1, timeline.totalDistanceMeters)),
        ).toFixed(4),
      ),
      currentBarrioId: segment.barrioId || activeStop?.barrioId || null,
      currentBarrioLabel: segment.barrioLabel || activeStop?.barrioLabel || null,
      nextStop,
      secondsUntilNextStop,
    }
  }

  const segmentDuration = Math.max(0.001, segment.endSeconds - segment.startSeconds)
  const segmentProgress = Math.max(0, Math.min(1, (normalizedPhase - segment.startSeconds) / segmentDuration))
  const lat = Number(segment.from.lat) + ((Number(segment.to.lat) - Number(segment.from.lat)) * segmentProgress)
  const lon = Number(segment.from.lon) + ((Number(segment.to.lon) - Number(segment.from.lon)) * segmentProgress)
  const distanceMeters =
    Number(segment.startDistanceMeters) +
    ((Number(segment.endDistanceMeters) - Number(segment.startDistanceMeters)) * segmentProgress)

  return {
    lat,
    lon,
    progress: Number(
      Math.min(
        COLLECTION_SIMULATION_MAX_PROGRESS,
        Math.max(0, distanceMeters / Math.max(1, timeline.totalDistanceMeters)),
      ).toFixed(4),
    ),
    currentBarrioId: activeStop?.barrioId || null,
    currentBarrioLabel: activeStop?.barrioLabel || null,
    nextStop,
    secondsUntilNextStop,
  }
}

function buildVirtualFleet(assets, shapesByRoute) {
  const routeAssignments = buildFleetAssignments(assets)
  const truckLabelById = buildTruckLabelById(assets)

  return routeAssignments.map((route, fleetIndex) => {
    const truckId = route.servicePatterns?.[fleetIndex % (route.servicePatterns?.length || 1)]?.truckId
      || route.servicePatterns?.[0]?.truckId
      || `SIM-${route.id}`
    const shapePoints = shapesByRoute.get(route.id) || []
    return {
      vehicleId: truckId,
      vehicleLabel: truckLabelById.get(truckId) || truckId,
      routeId: route.id,
      routeShortName: route.shortName,
      routeLongName: route.longName,
      routeColor: buildRouteColor(route.color),
      phaseOffsetSeconds: hashText(`${route.id}:${truckId}`) % 7200,
      timeline: buildRouteTimeline(route, shapePoints),
      shapePoints,
    }
  }).filter((entry) => entry.timeline && entry.shapePoints.length > 1)
}

async function loadRuntimeCache() {
  if (!runtimeCachePromise) {
    runtimeCachePromise = (async () => {
      const assets = await loadCollectionAssets()
      const { rows: shapeRows } = await query(`
        SELECT route_id, point_sequence, point_lat, point_lon, cumulative_distance_m
        FROM collection_route_shapes
        ORDER BY route_id, point_sequence
      `)
      const { rows: barrioRows } = await query(`
        SELECT barrio_id, barrio_label, center_lat, center_lon, geometry
        FROM collection_barrios
        ORDER BY barrio_label
      `)

      const shapesByRoute = new Map()
      for (const row of shapeRows) {
        if (!shapesByRoute.has(row.route_id)) shapesByRoute.set(row.route_id, [])
        shapesByRoute.get(row.route_id).push({
          sequence: Number(row.point_sequence),
          lat: Number(row.point_lat),
          lon: Number(row.point_lon),
          cumulativeDistanceMeters: Number(row.cumulative_distance_m),
        })
      }

      const barrios = barrioRows.map((row) => ({
        barrioId: row.barrio_id,
        barrioLabel: row.barrio_label,
        centerLat: Number(row.center_lat),
        centerLon: Number(row.center_lon),
        geometry: row.geometry,
      }))

      return {
        assets,
        shapesByRoute,
        barrios,
        virtualFleet: buildVirtualFleet(assets, shapesByRoute),
      }
    })()
  }

  return runtimeCachePromise
}

export function resetCollectionRuntimeCache() {
  runtimeCachePromise = null
}

function locateBarrio(barrios, lat, lon) {
  return barrios.find((barrio) => geometryContainsPoint(barrio.geometry, lat, lon)) || null
}

function buildRealtimeHeader(timestamp) {
  return {
    gtfsRealtimeVersion: '2.0',
    incrementality: 'FULL_DATASET',
    timestamp,
    timeZone: 'America/Asuncion',
  }
}

async function getRunsWithEvents(now, { minimumCount = 0 } = {}) {
  if (!(await isCollectionSimulationEnabled())) {
    return []
  }

  await ensureCollectionSimulationWindow()

  const { rows: runRows } = await query(
    `
      SELECT
        run.run_id,
        run.run_key,
        run.route_id,
        run.service_pattern_id,
        run.truck_id,
        run.starts_at,
        run.ends_at,
        route.route_short_name,
        route.route_long_name,
        route.route_color,
        route.shape_id,
        truck.truck_label
      FROM collection_runs run
      JOIN collection_routes route ON route.route_id = run.route_id
      JOIN collection_trucks truck ON truck.truck_id = run.truck_id
      WHERE $1 BETWEEN run.starts_at AND run.ends_at
      ORDER BY run.starts_at, run.route_id
    `,
    [now],
  )

  let selectedRuns = runRows
  if (selectedRuns.length < minimumCount) {
    const { rows: nearbyRunRows } = await query(
      `
        SELECT
          run.run_id,
          run.run_key,
          run.route_id,
          run.service_pattern_id,
          run.truck_id,
          run.starts_at,
          run.ends_at,
          route.route_short_name,
          route.route_long_name,
          route.route_color,
          route.shape_id,
          truck.truck_label
        FROM collection_runs run
        JOIN collection_routes route ON route.route_id = run.route_id
        JOIN collection_trucks truck ON truck.truck_id = run.truck_id
        ORDER BY
          CASE
            WHEN $1 BETWEEN run.starts_at AND run.ends_at THEN 0
            WHEN run.starts_at > $1 THEN 1
            ELSE 2
          END,
          CASE
            WHEN $1 BETWEEN run.starts_at AND run.ends_at THEN EXTRACT(EPOCH FROM ($1 - run.starts_at))
            WHEN run.starts_at > $1 THEN EXTRACT(EPOCH FROM (run.starts_at - $1))
            ELSE EXTRACT(EPOCH FROM ($1 - run.ends_at))
          END,
          run.starts_at,
          run.route_id
        LIMIT $2
      `,
      [now, Math.max(minimumCount, COLLECTION_SIMULATION_MIN_VISIBLE_VEHICLES)],
    )

    const seenRunIds = new Set()
    selectedRuns = [...runRows, ...nearbyRunRows].filter((row) => {
      if (!row?.run_id || seenRunIds.has(row.run_id)) return false
      seenRunIds.add(row.run_id)
      return true
    }).slice(0, Math.max(minimumCount, runRows.length))
  }

  if (!selectedRuns.length) return []

  const runIds = selectedRuns.map((row) => row.run_id)
  const { rows: eventRows } = await query(
    `
      SELECT
        run_id,
        barrio_id,
        barrio_label,
        stop_sequence,
        enters_at,
        exits_at,
        stop_lat,
        stop_lon
      FROM collection_run_barrio_events
      WHERE run_id = ANY($1)
      ORDER BY run_id, stop_sequence
    `,
    [runIds],
  )

  const eventsByRun = new Map()
  for (const row of eventRows) {
    if (!eventsByRun.has(row.run_id)) eventsByRun.set(row.run_id, [])
    eventsByRun.get(row.run_id).push({
      barrioId: row.barrio_id,
      barrioLabel: row.barrio_label,
      stopSequence: Number(row.stop_sequence),
      entersAt: row.enters_at,
      exitsAt: row.exits_at,
      stopLat: Number(row.stop_lat),
      stopLon: Number(row.stop_lon),
    })
  }

  return selectedRuns.map((row) => ({
    ...row,
    events: eventsByRun.get(row.run_id) || [],
  }))
}

export async function getActiveCollectionVehicles() {
  if (!(await isCollectionSimulationEnabled())) {
    return []
  }

  const now = new Date()
  const timestamp = Math.floor(now.getTime() / 1000)
  const { barrios, virtualFleet } = await loadRuntimeCache()
  const nowSeconds = now.getTime() / 1000

  return virtualFleet.map((entry) => {
    const state = getTimelineState(entry, nowSeconds + entry.phaseOffsetSeconds)
    const currentBarrio = state?.currentBarrioId
      ? {
          barrioId: state.currentBarrioId,
          barrioLabel: state.currentBarrioLabel,
        }
      : locateBarrio(barrios, state?.lat || 0, state?.lon || 0)

    return {
      vehicle_id: entry.vehicleId,
      trip_id: `sim-${entry.routeId}-${entry.vehicleId}`,
      route_id: entry.routeId,
      route_short_name: entry.routeShortName,
      route_long_name: entry.routeLongName,
      route_color: entry.routeColor,
      trip_headsign: entry.routeLongName,
      current_lat: state?.lat || 0,
      current_lon: state?.lon || 0,
      progress: Number(state?.progress || 0),
      status: 'active',
      current_stop_sequence: 0,
      next_stop: state?.nextStop
        ? {
            stop_id: state.nextStop.barrioId,
            stop_name: state.nextStop.barrioLabel,
            arrival_time: new Date((timestamp + Math.max(0, state.secondsUntilNextStop || 0)) * 1000).toISOString(),
          }
        : null,
      current_barrio_id: currentBarrio?.barrioId || null,
      current_barrio_label: currentBarrio?.barrioLabel || null,
      updated_at: new Date(timestamp * 1000).toISOString(),
      source: 'simulated_gtfs_rt_continuous',
      source_label: 'Simulacion GTFS-RT continua',
      vehicle_label: entry.vehicleLabel,
    }
  }).slice(0, COLLECTION_SIMULATION_MIN_VISIBLE_VEHICLES)
}

export async function getGtfsRealtimeVehiclePositions() {
  const now = new Date()
  const timestamp = Math.floor(now.getTime() / 1000)
  if (!(await isCollectionSimulationEnabled())) {
    return {
      header: buildRealtimeHeader(timestamp),
      entity: [],
    }
  }

  const vehicles = await getActiveCollectionVehicles()

  return {
    header: buildRealtimeHeader(timestamp),
    entity: vehicles.map((vehicle) => ({
      id: vehicle.vehicle_id,
      vehicle: {
        trip: {
          tripId: vehicle.trip_id,
          routeId: vehicle.route_id,
        },
        vehicle: {
          id: vehicle.vehicle_id,
          label: vehicle.vehicle_id,
        },
        position: {
          latitude: vehicle.current_lat,
          longitude: vehicle.current_lon,
        },
        currentStatus: 'IN_TRANSIT_TO',
        stopId: vehicle.next_stop?.stop_id || null,
        timestamp,
      },
    })),
  }
}

export async function getGtfsRealtimeTripUpdates() {
  const now = new Date()
  const timestamp = Math.floor(now.getTime() / 1000)
  if (!(await isCollectionSimulationEnabled())) {
    return {
      header: buildRealtimeHeader(timestamp),
      entity: [],
    }
  }

  const activeRuns = await getRunsWithEvents(now, {
    minimumCount: COLLECTION_SIMULATION_MIN_VISIBLE_VEHICLES,
  })

  return {
    header: buildRealtimeHeader(timestamp),
    entity: activeRuns.map((run) => ({
      id: run.run_key,
      tripUpdate: {
        trip: {
          tripId: run.run_key,
          routeId: run.route_id,
        },
        vehicle: {
          id: run.truck_id,
          label: run.truck_label,
        },
        stopTimeUpdate: run.events
          .filter((event) => new Date(event.exitsAt).getTime() >= now.getTime())
          .map((event) => ({
            stopSequence: event.stopSequence,
            stopId: event.barrioId,
            arrival: {
              time: Math.floor(new Date(event.entersAt).getTime() / 1000),
            },
            departure: {
              time: Math.floor(new Date(event.exitsAt).getTime() / 1000),
            },
          })),
        timestamp,
      },
    })),
  }
}
