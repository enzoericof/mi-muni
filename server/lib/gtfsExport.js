// ---------------------------------------------------------------------------
// GTFS Static Export — genera los archivos .txt oficiales del estándar GTFS
//
// Especificación: https://gtfs.org/documentation/schedule/reference/
// Requisitos clave que cumplimos:
//   • UTF-8 (sin BOM, aunque el estándar permite BOM)
//   • Comma-delimited (CSV según RFC 4180)
//   • Line ending CRLF
//   • Primera línea = nombres de campo (case-sensitive)
//   • Valores con coma o comilla van entre comillas, comilla interna = ""
//   • Fechas en formato YYYYMMDD (calendar.txt, feed_info.txt)
//   • Horarios en HH:MM:SS (stop_times.txt)
//   • Archivos empaquetados en gtfs.zip en la raíz del ZIP (no en subcarpetas)
//
// Archivos generados:
//   agency.txt      (Required)
//   stops.txt       (Required*)
//   routes.txt      (Required)
//   trips.txt       (Required)
//   stop_times.txt  (Required)
//   calendar.txt    (Required*)
//   shapes.txt      (Optional, recomendado)
//   feed_info.txt   (Conditionally Required, recomendado)
// ---------------------------------------------------------------------------
import JSZip from 'jszip'
import { query } from '../db/index.js'

const CRLF = '\r\n'

// ── CSV helpers (RFC 4180) ───────────────────────────────────────────────────
function escapeCsvValue(value) {
  if (value === null || value === undefined) return ''
  const str = String(value)
  // Si contiene coma, comilla, CR, LF → entre comillas y duplicar comillas internas
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function toCsv(header, rows) {
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(header.map((col) => escapeCsvValue(row[col])).join(','))
  }
  return lines.join(CRLF) + CRLF
}

// Convierte "2025-01-01" (ISO) o Date → "20250101" (GTFS)
function toGtfsDate(value) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value).replace(/-/g, '')
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

// pg devuelve TIME como "HH:MM:SS" ya. Lo aseguramos.
function toGtfsTime(value) {
  if (!value) return ''
  const str = String(value)
  // Si viene en formato "HH:MM:SS.sss" recortamos los ms
  return str.length >= 8 ? str.slice(0, 8) : str
}

// ── Builders por archivo ─────────────────────────────────────────────────────

// agency.txt
export async function buildAgencyCsv() {
  const { rows } = await query('SELECT * FROM gtfs_agency')
  const header = ['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang']
  return toCsv(header, rows)
}

// stops.txt — agregamos location_type=0 (stop/platform) por defecto
export async function buildStopsCsv() {
  const { rows } = await query(
    'SELECT stop_id, stop_name, stop_lat, stop_lon, stop_desc, zone_id FROM gtfs_stops ORDER BY stop_id',
  )
  const header = ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'stop_desc', 'zone_id', 'location_type']
  const enriched = rows.map((r) => ({ ...r, location_type: 0 }))
  return toCsv(header, enriched)
}

// routes.txt
export async function buildRoutesCsv() {
  const { rows } = await query(`
    SELECT route_id, agency_id, route_short_name, route_long_name,
           route_desc, route_type, route_color, route_text_color
    FROM gtfs_routes
    ORDER BY route_id
  `)
  const header = [
    'route_id', 'agency_id', 'route_short_name', 'route_long_name',
    'route_desc', 'route_type', 'route_color', 'route_text_color',
  ]
  return toCsv(header, rows)
}

// trips.txt
export async function buildTripsCsv() {
  const { rows } = await query(`
    SELECT trip_id, route_id, service_id, trip_headsign, shape_id, direction_id
    FROM gtfs_trips
    ORDER BY trip_id
  `)
  const header = ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id', 'shape_id']
  return toCsv(header, rows)
}

// stop_times.txt
export async function buildStopTimesCsv() {
  const { rows } = await query(`
    SELECT trip_id, arrival_time, departure_time, stop_id, stop_sequence
    FROM gtfs_stop_times
    ORDER BY trip_id, stop_sequence
  `)
  const header = ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence']
  const formatted = rows.map((r) => ({
    trip_id: r.trip_id,
    arrival_time: toGtfsTime(r.arrival_time),
    departure_time: toGtfsTime(r.departure_time),
    stop_id: r.stop_id,
    stop_sequence: r.stop_sequence,
  }))
  return toCsv(header, formatted)
}

// calendar.txt — fechas en YYYYMMDD
export async function buildCalendarCsv() {
  const { rows } = await query(`
    SELECT service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday,
           start_date, end_date
    FROM gtfs_calendar
    ORDER BY service_id
  `)
  const header = [
    'service_id', 'monday', 'tuesday', 'wednesday', 'thursday',
    'friday', 'saturday', 'sunday', 'start_date', 'end_date',
  ]
  const formatted = rows.map((r) => ({
    service_id: r.service_id,
    monday: r.monday ? 1 : 0,
    tuesday: r.tuesday ? 1 : 0,
    wednesday: r.wednesday ? 1 : 0,
    thursday: r.thursday ? 1 : 0,
    friday: r.friday ? 1 : 0,
    saturday: r.saturday ? 1 : 0,
    sunday: r.sunday ? 1 : 0,
    start_date: toGtfsDate(r.start_date),
    end_date: toGtfsDate(r.end_date),
  }))
  return toCsv(header, formatted)
}

// shapes.txt
export async function buildShapesCsv() {
  const { rows } = await query(`
    SELECT shape_id, shape_pt_lat, shape_pt_lon, shape_pt_sequence
    FROM gtfs_shapes
    ORDER BY shape_id, shape_pt_sequence
  `)
  const header = ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence']
  return toCsv(header, rows)
}

// feed_info.txt — metadata del feed generado dinámicamente
export async function buildFeedInfoCsv() {
  // Tomamos las fechas del calendar existente
  const { rows: calRows } = await query(`
    SELECT MIN(start_date) AS start_date, MAX(end_date) AS end_date FROM gtfs_calendar
  `)
  const cal = calRows[0] ?? {}

  const header = [
    'feed_publisher_name', 'feed_publisher_url', 'feed_lang',
    'feed_start_date', 'feed_end_date', 'feed_version', 'feed_contact_email',
  ]
  const row = {
    feed_publisher_name: 'Municipalidad de Asuncion - Recoleccion de Residuos',
    feed_publisher_url: 'https://www.asuncion.gov.py',
    feed_lang: 'es',
    feed_start_date: toGtfsDate(cal.start_date),
    feed_end_date: toGtfsDate(cal.end_date),
    feed_version: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    feed_contact_email: 'datos@asuncion.gov.py',
  }
  return toCsv(header, [row])
}

// ── Empaquetado: genera gtfs.zip con todos los archivos en la raíz ───────────
export async function buildGtfsZipBuffer() {
  const zip = new JSZip()

  const files = [
    ['agency.txt',     await buildAgencyCsv()],
    ['stops.txt',      await buildStopsCsv()],
    ['routes.txt',     await buildRoutesCsv()],
    ['trips.txt',      await buildTripsCsv()],
    ['stop_times.txt', await buildStopTimesCsv()],
    ['calendar.txt',   await buildCalendarCsv()],
    ['shapes.txt',     await buildShapesCsv()],
    ['feed_info.txt',  await buildFeedInfoCsv()],
  ]

  for (const [name, content] of files) {
    // GTFS pide archivos en la raíz del ZIP, no en una subcarpeta
    zip.file(name, content)
  }

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
}

// Tabla de archivos disponibles — útil para /api/gtfs/txt/:name
export const GTFS_TXT_BUILDERS = {
  'agency.txt':     buildAgencyCsv,
  'stops.txt':      buildStopsCsv,
  'routes.txt':     buildRoutesCsv,
  'trips.txt':      buildTripsCsv,
  'stop_times.txt': buildStopTimesCsv,
  'calendar.txt':   buildCalendarCsv,
  'shapes.txt':     buildShapesCsv,
  'feed_info.txt':  buildFeedInfoCsv,
}
