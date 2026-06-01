import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ASUNCION_TZ = 'America/Asuncion'
export const SERVICE_DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
export const DAY_LABELS = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado']
export const COLLECTION_HISTORY_DAYS = 60
export const COLLECTION_FUTURE_DAYS = 7
export const COLLECTION_INTERPOLATION_MAX_SEGMENT_METERS = 300

const libDir = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(libDir, '../data')

let collectionAssetsPromise = null

function round(value, precision = 6) {
  const factor = 10 ** precision
  return Math.round(Number(value) * factor) / factor
}

export async function loadCollectionAssets() {
  if (!collectionAssetsPromise) {
    collectionAssetsPromise = Promise.all([
      readFile(path.join(dataDir, 'barrios-asu.geojson'), 'utf8'),
      readFile(path.join(dataDir, 'collection-service-plan.json'), 'utf8'),
      readFile(path.join(dataDir, 'calles-asu.graph.json'), 'utf8'),
    ]).then(([barriosRaw, servicePlanRaw, graphRaw]) => ({
      barriosGeojson: JSON.parse(barriosRaw),
      servicePlan: JSON.parse(servicePlanRaw),
      streetsGraph: JSON.parse(graphRaw),
    }))
  }

  return collectionAssetsPromise
}

export function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

export function gtfsTimeToMinutes(timeStr) {
  const [hours, minutes, seconds] = String(timeStr || '00:00:00').split(':').map(Number)
  return (hours || 0) * 60 + (minutes || 0) + ((seconds || 0) / 60)
}

export function minutesToGtfsTime(totalMinutes) {
  const safeMinutes = Math.max(0, Math.round(Number(totalMinutes || 0)))
  const hours = String(Math.floor(safeMinutes / 60)).padStart(2, '0')
  const minutes = String(safeMinutes % 60).padStart(2, '0')
  return `${hours}:${minutes}:00`
}

export function getZonedParts(date = new Date(), timeZone = ASUNCION_TZ) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
}

export function getAsuncionNow() {
  const parts = getZonedParts(new Date(), ASUNCION_TZ)
  return new Date(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    ),
  )
}

export function getAsuncionDateKey(date = new Date()) {
  const parts = getZonedParts(date, ASUNCION_TZ)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function dateKeyToUtcMidnight(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

export function addDaysToDateKey(dateKey, days) {
  const baseDate = dateKeyToUtcMidnight(dateKey)
  baseDate.setUTCDate(baseDate.getUTCDate() + Number(days || 0))
  return baseDate.toISOString().slice(0, 10)
}

export function getDayNameForDateKey(dateKey) {
  const utcDate = dateKeyToUtcMidnight(dateKey)
  return SERVICE_DAY_NAMES[utcDate.getUTCDay()]
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getZonedParts(date, timeZone)
  const zonedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return zonedAsUtc - date.getTime()
}

export function asuncionDateTimeToUtc(dateKey, timeStr) {
  const [year, month, day] = String(dateKey).split('-').map(Number)
  const [hours, minutes, seconds] = String(timeStr || '00:00:00').split(':').map(Number)
  let guess = new Date(Date.UTC(year, month - 1, day, hours || 0, minutes || 0, seconds || 0))
  let offset = getTimeZoneOffsetMs(guess, ASUNCION_TZ)
  guess = new Date(guess.getTime() - offset)
  offset = getTimeZoneOffsetMs(guess, ASUNCION_TZ)
  return new Date(Date.UTC(year, month - 1, day, hours || 0, minutes || 0, seconds || 0) - offset)
}

export function haversineMeters(latA, lonA, latB, lonB) {
  const radius = 6371000
  const lat1 = (Number(latA) * Math.PI) / 180
  const lat2 = (Number(latB) * Math.PI) / 180
  const deltaLat = ((Number(latB) - Number(latA)) * Math.PI) / 180
  const deltaLon = ((Number(lonB) - Number(lonA)) * Math.PI) / 180
  const term =
    (Math.sin(deltaLat / 2) ** 2) +
    (Math.cos(lat1) * Math.cos(lat2) * (Math.sin(deltaLon / 2) ** 2))
  return 2 * radius * Math.atan2(Math.sqrt(term), Math.sqrt(1 - term))
}

export function buildShapeMetrics(shapePoints = []) {
  let cumulative = 0
  const points = shapePoints.map((point, index) => {
    if (index > 0) {
      cumulative += haversineMeters(
        shapePoints[index - 1][0],
        shapePoints[index - 1][1],
        point[0],
        point[1],
      )
    }
    return {
      sequence: index + 1,
      lat: round(point[0]),
      lon: round(point[1]),
      cumulativeDistanceMeters: Number(cumulative.toFixed(3)),
    }
  })

  return {
    totalDistanceMeters: Number(cumulative.toFixed(3)),
    points,
  }
}

export function interpolateAlongShape(shapePoints = [], progress = 0) {
  if (!shapePoints.length) return null
  if (shapePoints.length === 1) {
    return { lat: shapePoints[0].lat, lon: shapePoints[0].lon, progress: 0 }
  }

  const targetDistance = Math.max(0, Math.min(1, progress)) * Number(shapePoints.at(-1)?.cumulativeDistanceMeters || 0)

  for (let index = 1; index < shapePoints.length; index += 1) {
    const previous = shapePoints[index - 1]
    const next = shapePoints[index]
    if (targetDistance > next.cumulativeDistanceMeters) continue

    const segmentDistance = next.cumulativeDistanceMeters - previous.cumulativeDistanceMeters
    if (segmentDistance > COLLECTION_INTERPOLATION_MAX_SEGMENT_METERS) {
      const snapPoint = targetDistance - previous.cumulativeDistanceMeters < segmentDistance / 2 ? previous : next
      return {
        lat: snapPoint.lat,
        lon: snapPoint.lon,
        progress: Number(progress.toFixed(4)),
      }
    }
    const segmentProgress = segmentDistance > 0
      ? (targetDistance - previous.cumulativeDistanceMeters) / segmentDistance
      : 0

    return {
      lat: previous.lat + ((next.lat - previous.lat) * segmentProgress),
      lon: previous.lon + ((next.lon - previous.lon) * segmentProgress),
      progress: Number(progress.toFixed(4)),
    }
  }

  const lastPoint = shapePoints.at(-1)
  return { lat: lastPoint.lat, lon: lastPoint.lon, progress: 1 }
}

export function geometryCenter(geometry) {
  const coordinates = []

  function visit(value) {
    if (!Array.isArray(value)) return
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      coordinates.push([Number(value[1]), Number(value[0])])
      return
    }
    value.forEach(visit)
  }

  visit(geometry?.coordinates)
  if (!coordinates.length) return null

  return {
    lat: coordinates.reduce((sum, [lat]) => sum + lat, 0) / coordinates.length,
    lon: coordinates.reduce((sum, [, lon]) => sum + lon, 0) / coordinates.length,
  }
}

export function geometryBounds(geometry) {
  const coordinates = []

  function visit(value) {
    if (!Array.isArray(value)) return
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      coordinates.push([Number(value[1]), Number(value[0])])
      return
    }
    value.forEach(visit)
  }

  visit(geometry?.coordinates)
  if (!coordinates.length) return null

  const latitudes = coordinates.map(([lat]) => lat)
  const longitudes = coordinates.map(([, lon]) => lon)
  return {
    minLat: Math.min(...latitudes),
    maxLat: Math.max(...latitudes),
    minLon: Math.min(...longitudes),
    maxLon: Math.max(...longitudes),
  }
}

function pointInRing(lat, lon, ring = []) {
  let inside = false

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [currentLon, currentLat] = ring[index]
    const [previousLon, previousLat] = ring[previous]
    const intersects =
      (currentLat > lat) !== (previousLat > lat) &&
      lon < ((previousLon - currentLon) * (lat - currentLat)) / ((previousLat - currentLat) || Number.EPSILON) + currentLon

    if (intersects) inside = !inside
  }

  return inside
}

export function geometryContainsPoint(geometry, lat, lon) {
  if (!geometry?.type || !geometry?.coordinates) return false

  if (geometry.type === 'Polygon') {
    return geometry.coordinates.some((ring) => pointInRing(lat, lon, ring))
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => polygon.some((ring) => pointInRing(lat, lon, ring)))
  }

  return false
}
