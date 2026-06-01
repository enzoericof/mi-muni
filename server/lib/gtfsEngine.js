import { query } from '../db/index.js'
import { geometryContainsPoint } from './collectionCore.js'
import { getCollectionRuntimeEnvironmentKey } from './collectionRuntime.js'
import { getActiveCollectionVehicles } from './collectionSimulation.js'

const TARGET_COLLECTION_VEHICLE_COUNT = 10
const REPORTED_VEHICLE_STALE_MINUTES = 20
const recolectorEnvironmentKey = getCollectionRuntimeEnvironmentKey()

function buildRouteColor(value) {
  return String(value || '').startsWith('#') ? String(value) : `#${value || '146152'}`
}

function buildRealtimeHeader(timestamp) {
  return {
    gtfsRealtimeVersion: '2.0',
    incrementality: 'FULL_DATASET',
    timestamp,
    timeZone: 'America/Asuncion',
  }
}

function locateBarrio(barrios, lat, lon) {
  return barrios.find((barrio) => geometryContainsPoint(barrio.geometry, lat, lon)) || null
}

async function getReportedVehiclePositions() {
  const [{ rows: shifts }, { rows: barrioRows }] = await Promise.all([
    query(
      `
        SELECT
          shift.id,
          shift.user_id,
          shift.route_id,
          shift.route_label,
          shift.barrio_slug,
          shift.barrio_label,
          shift.last_lat,
          shift.last_lon,
          shift.last_seen_at,
          user_row.name AS recolector_name,
          COALESCE(route.route_short_name, shift.route_id) AS route_short_name,
          COALESCE(route.route_long_name, shift.route_label) AS route_long_name,
          COALESCE(route.route_color, '146152') AS route_color
        FROM recolector_shifts shift
        JOIN app_users user_row ON user_row.id = shift.user_id
        LEFT JOIN gtfs_routes route ON route.route_id = shift.route_id
        WHERE shift.status = 'online'
          AND shift.environment_key = $1
          AND shift.last_lat IS NOT NULL
          AND shift.last_lon IS NOT NULL
          AND shift.last_seen_at IS NOT NULL
          AND shift.last_seen_at >= (NOW() - ($2 * INTERVAL '1 minute'))
        ORDER BY shift.started_at, shift.id
      `,
      [recolectorEnvironmentKey, REPORTED_VEHICLE_STALE_MINUTES],
    ),
    query(
      `
        SELECT barrio_id, barrio_label, geometry
        FROM collection_barrios
        ORDER BY barrio_label
      `,
    ),
  ])

  const barrios = barrioRows.map((row) => ({
    barrioId: row.barrio_id,
    barrioLabel: row.barrio_label,
    geometry: row.geometry,
  }))

  return shifts.map((shift) => {
    const currentBarrio = locateBarrio(barrios, Number(shift.last_lat), Number(shift.last_lon))

    return {
      vehicle_id: `REC-${shift.id}`,
      trip_id: `recolector-shift-${shift.id}`,
      route_id: shift.route_id,
      route_short_name: shift.route_short_name,
      route_long_name: shift.route_long_name,
      route_color: buildRouteColor(shift.route_color),
      trip_headsign: shift.route_long_name,
      current_lat: Number(shift.last_lat),
      current_lon: Number(shift.last_lon),
      progress: null,
      status: 'active',
      current_stop_sequence: 0,
      next_stop: currentBarrio
        ? {
            stop_id: currentBarrio.barrioId,
            stop_name: currentBarrio.barrioLabel,
            arrival_time: new Date(shift.last_seen_at).toISOString(),
          }
        : null,
      current_barrio_id: currentBarrio?.barrioId || shift.barrio_slug || null,
      current_barrio_label: currentBarrio?.barrioLabel || shift.barrio_label || null,
      updated_at: new Date(shift.last_seen_at).toISOString(),
      source: 'reported_gps',
      source_label: 'GPS reportado por recolector',
      vehicle_label: shift.recolector_name || `Recolector ${shift.user_id}`,
    }
  })
}

export async function getVehiclePositions({ includeSimulated = true } = {}) {
  const [simulatedVehicles, reportedVehicles] = await Promise.all([
    includeSimulated ? getActiveCollectionVehicles() : Promise.resolve([]),
    getReportedVehiclePositions(),
  ])

  const normalizedSimulatedVehicles = [...simulatedVehicles].sort((left, right) =>
    String(left.vehicle_id || '').localeCompare(String(right.vehicle_id || ''), 'es'),
  )
  const normalizedReportedVehicles = [...reportedVehicles].sort((left, right) =>
    String(left.vehicle_id || '').localeCompare(String(right.vehicle_id || ''), 'es'),
  )
  const vehiclesById = new Map(normalizedSimulatedVehicles.map((vehicle) => [vehicle.vehicle_id, vehicle]))

  for (const vehicle of normalizedReportedVehicles) {
    vehiclesById.set(vehicle.vehicle_id, vehicle)
  }

  const preferredVehicles = [
    ...normalizedReportedVehicles,
    ...normalizedSimulatedVehicles.filter((vehicle) => !vehiclesById.has(vehicle.vehicle_id) || vehicle.source !== 'reported_gps'),
  ]
  const selectedVehicles = []
  const seenVehicleIds = new Set()

  for (const vehicle of preferredVehicles) {
    if (!vehicle?.vehicle_id || seenVehicleIds.has(vehicle.vehicle_id)) continue
    const canonicalVehicle = vehiclesById.get(vehicle.vehicle_id) || vehicle
    selectedVehicles.push(canonicalVehicle)
    seenVehicleIds.add(vehicle.vehicle_id)
    if (selectedVehicles.length >= TARGET_COLLECTION_VEHICLE_COUNT) break
  }

  return selectedVehicles
}

export async function getRealtimeVehiclePositionsFeed() {
  const timestamp = Math.floor(Date.now() / 1000)
  const vehicles = await getVehiclePositions()

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
          label: vehicle.vehicle_label || vehicle.vehicle_id,
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

export async function getRealtimeTripUpdatesFeed() {
  const timestamp = Math.floor(Date.now() / 1000)
  const vehicles = await getVehiclePositions()

  return {
    header: buildRealtimeHeader(timestamp),
    entity: vehicles.map((vehicle) => ({
      id: vehicle.trip_id,
      tripUpdate: {
        trip: {
          tripId: vehicle.trip_id,
          routeId: vehicle.route_id,
        },
        vehicle: {
          id: vehicle.vehicle_id,
          label: vehicle.vehicle_label || vehicle.vehicle_id,
        },
        stopTimeUpdate: [],
        timestamp,
      },
    })),
  }
}

export async function getFullFeed() {
  const [agency, calendar, routes, stops, trips, stopTimes, shapes] = await Promise.all([
    query('SELECT * FROM gtfs_agency'),
    query('SELECT * FROM gtfs_calendar'),
    query('SELECT * FROM gtfs_routes ORDER BY route_id'),
    query('SELECT * FROM gtfs_stops ORDER BY stop_id'),
    query('SELECT * FROM gtfs_trips ORDER BY trip_id'),
    query('SELECT * FROM gtfs_stop_times ORDER BY trip_id, stop_sequence'),
    query('SELECT * FROM gtfs_shapes ORDER BY shape_id, shape_pt_sequence'),
  ])

  return {
    agency: agency.rows,
    calendar: calendar.rows,
    routes: routes.rows,
    stops: stops.rows,
    trips: trips.rows,
    stop_times: stopTimes.rows,
    shapes: shapes.rows,
  }
}
