// ---------------------------------------------------------------------------
// GTFS Static — Mock data para Asunción, Paraguay
// Modela el servicio de recolección de residuos como si fuera una línea de tránsito,
// usando el estándar GTFS (https://gtfs.org/schedule/reference/).
//
// Los shapes (trazados sobre calles) se generan en tiempo de seed llamando a
// OSRM público (router.project-osrm.org). Si OSRM falla, se usa un fallback de
// líneas rectas entre paradas.
//
// Horarios 24h: se generan salidas cada 2 horas (00:00 a 22:00).
// Rutas nocturnas usan service_id TODOS-DIAS (lun-dom).
// report_count: cantidad de usuarios que reportaron la ruta (alimentado por servicio externo).
// ---------------------------------------------------------------------------
import { query } from './index.js'

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving'
const OSRM_TIMEOUT_MS = 10_000

// ── agency.txt ──────────────────────────────────────────────────────────────
const AGENCY = {
  agency_id: 'ASU-MUN',
  agency_name: 'Municipalidad de Asunción — Recolección de Residuos',
  agency_url: 'https://www.asuncion.gov.py',
  agency_timezone: 'America/Asuncion',
  agency_lang: 'es',
}

// ── calendar.txt ─────────────────────────────────────────────────────────────
const CALENDAR = [
  {
    service_id: 'LUN-SAB',
    monday: true, tuesday: true, wednesday: true,
    thursday: true, friday: true, saturday: true, sunday: false,
    start_date: '2025-01-01', end_date: '2026-12-31',
  },
  {
    service_id: 'LUN-VIE',
    monday: true, tuesday: true, wednesday: true,
    thursday: true, friday: true, saturday: false, sunday: false,
    start_date: '2025-01-01', end_date: '2026-12-31',
  },
  {
    service_id: 'TODOS-DIAS',
    monday: true, tuesday: true, wednesday: true,
    thursday: true, friday: true, saturday: true, sunday: true,
    start_date: '2025-01-01', end_date: '2026-12-31',
  },
]

// ── routes.txt ───────────────────────────────────────────────────────────────
// route_type 3 = Bus (el más cercano a camión en el estándar GTFS)
// report_count: cuántos usuarios reportaron esta ruta (fuente: servicio externo)
const ROUTES = [
  { route_id: 'R01', route_short_name: 'R01', route_long_name: 'Centro Histórico',          route_color: '2E7D32', service_id: 'LUN-SAB',    report_count: 142 },
  { route_id: 'R02', route_short_name: 'R02', route_long_name: 'Villa Morra / Carmelitas',   route_color: '1565C0', service_id: 'LUN-SAB',    report_count: 98  },
  { route_id: 'R03', route_short_name: 'R03', route_long_name: 'Sajonia / Barrio Obrero',    route_color: 'E65100', service_id: 'LUN-VIE',    report_count: 76  },
  { route_id: 'R04', route_short_name: 'R04', route_long_name: 'Sur / Terminal',             route_color: '6A1B9A', service_id: 'LUN-SAB',    report_count: 115 },
  { route_id: 'R05', route_short_name: 'R05', route_long_name: 'Trinidad / Las Lomas',       route_color: 'AD1457', service_id: 'LUN-VIE',    report_count: 63  },
  { route_id: 'R06', route_short_name: 'R06', route_long_name: 'Recoleta / Mburucuyá',       route_color: '00838F', service_id: 'TODOS-DIAS', report_count: 201 },
  { route_id: 'R07', route_short_name: 'R07', route_long_name: 'Lambaré / San Jorge',        route_color: 'F57F17', service_id: 'TODOS-DIAS', report_count: 87  },
]

// ── stops.txt ────────────────────────────────────────────────────────────────
const STOPS = [
  // R01 — Centro Histórico
  { stop_id: 'S0101', stop_name: 'Mercado 4',                stop_lat: -25.2935, stop_lon: -57.6310, zone_id: 'Centro' },
  { stop_id: 'S0102', stop_name: 'Plaza Uruguaya',           stop_lat: -25.2830, stop_lon: -57.6335, zone_id: 'Centro' },
  { stop_id: 'S0103', stop_name: 'Plaza de los Héroes',      stop_lat: -25.2854, stop_lon: -57.6372, zone_id: 'Centro' },
  { stop_id: 'S0104', stop_name: 'Panteón Nacional',         stop_lat: -25.2864, stop_lon: -57.6384, zone_id: 'Centro' },
  { stop_id: 'S0105', stop_name: 'Catedral Metropolitana',   stop_lat: -25.2878, stop_lon: -57.6370, zone_id: 'Centro' },

  // R02 — Villa Morra / Carmelitas
  { stop_id: 'S0201', stop_name: 'Shopping del Sol',         stop_lat: -25.2962, stop_lon: -57.5835, zone_id: 'VillaMorra' },
  { stop_id: 'S0202', stop_name: 'Shopping Villa Morra',     stop_lat: -25.2994, stop_lon: -57.5920, zone_id: 'VillaMorra' },
  { stop_id: 'S0203', stop_name: 'Shopping Mariscal López',  stop_lat: -25.3017, stop_lon: -57.5982, zone_id: 'VillaMorra' },
  { stop_id: 'S0204', stop_name: 'WTC Asunción',             stop_lat: -25.2985, stop_lon: -57.5835, zone_id: 'VillaMorra' },
  { stop_id: 'S0205', stop_name: 'Paseo Carmelitas',         stop_lat: -25.2950, stop_lon: -57.5798, zone_id: 'VillaMorra' },

  // R03 — Sajonia / Barrio Obrero
  { stop_id: 'S0301', stop_name: 'Estadio Defensores del Chaco', stop_lat: -25.2925, stop_lon: -57.6220, zone_id: 'Sajonia' },
  { stop_id: 'S0302', stop_name: 'Barrio Obrero',                stop_lat: -25.2965, stop_lon: -57.6170, zone_id: 'Sajonia' },
  { stop_id: 'S0303', stop_name: 'Sajonia Centro',               stop_lat: -25.2940, stop_lon: -57.6250, zone_id: 'Sajonia' },
  { stop_id: 'S0304', stop_name: 'Mcal. López y Brasil',         stop_lat: -25.2905, stop_lon: -57.6290, zone_id: 'Sajonia' },
  { stop_id: 'S0305', stop_name: 'Pettirossi y Gral. Santos',    stop_lat: -25.2880, stop_lon: -57.6270, zone_id: 'Sajonia' },

  // R04 — Sur / Terminal
  { stop_id: 'S0401', stop_name: 'Terminal de Ómnibus',        stop_lat: -25.3170, stop_lon: -57.6290, zone_id: 'Sur' },
  { stop_id: 'S0402', stop_name: 'Barrio Tablada Nueva',       stop_lat: -25.3100, stop_lon: -57.6250, zone_id: 'Sur' },
  { stop_id: 'S0403', stop_name: 'Barrio Republicano',         stop_lat: -25.3060, stop_lon: -57.6210, zone_id: 'Sur' },
  { stop_id: 'S0404', stop_name: 'Avda. Eusebio Ayala',        stop_lat: -25.3115, stop_lon: -57.6150, zone_id: 'Sur' },
  { stop_id: 'S0405', stop_name: 'Mburicaó',                   stop_lat: -25.3000, stop_lon: -57.6120, zone_id: 'Sur' },

  // R05 — Trinidad / Las Lomas
  { stop_id: 'S0501', stop_name: 'Iglesia Santísima Trinidad', stop_lat: -25.2702, stop_lon: -57.6005, zone_id: 'Trinidad' },
  { stop_id: 'S0502', stop_name: 'Parque Trinidad',            stop_lat: -25.2735, stop_lon: -57.6030, zone_id: 'Trinidad' },
  { stop_id: 'S0503', stop_name: 'Avda. Artigas',              stop_lat: -25.2793, stop_lon: -57.6020, zone_id: 'Trinidad' },
  { stop_id: 'S0504', stop_name: 'Las Lomas',                  stop_lat: -25.2810, stop_lon: -57.5990, zone_id: 'Trinidad' },
  { stop_id: 'S0505', stop_name: 'España y Venezuela',         stop_lat: -25.2838, stop_lon: -57.6030, zone_id: 'Trinidad' },

  // R06 — Recoleta / Mburucuyá (norte residencial)
  { stop_id: 'S0601', stop_name: 'Jardín Botánico',            stop_lat: -25.2630, stop_lon: -57.5930, zone_id: 'Recoleta' },
  { stop_id: 'S0602', stop_name: 'Recoleta Centro',            stop_lat: -25.2665, stop_lon: -57.5875, zone_id: 'Recoleta' },
  { stop_id: 'S0603', stop_name: 'Barrio Mburucuyá',           stop_lat: -25.2700, stop_lon: -57.5820, zone_id: 'Recoleta' },
  { stop_id: 'S0604', stop_name: 'Avda. Santísima Trinidad',   stop_lat: -25.2640, stop_lon: -57.5770, zone_id: 'Recoleta' },
  { stop_id: 'S0605', stop_name: 'Mcal. Estigarribia y Aviadores', stop_lat: -25.2590, stop_lon: -57.5840, zone_id: 'Recoleta' },

  // R07 — Lambaré / San Jorge (sur industrial)
  { stop_id: 'S0701', stop_name: 'Lambaré Centro',             stop_lat: -25.3430, stop_lon: -57.6165, zone_id: 'Lambare' },
  { stop_id: 'S0702', stop_name: 'Barrio San Jorge',           stop_lat: -25.3380, stop_lon: -57.6200, zone_id: 'Lambare' },
  { stop_id: 'S0703', stop_name: 'Avda. Mcal. López (Sur)',    stop_lat: -25.3310, stop_lon: -57.6180, zone_id: 'Lambare' },
  { stop_id: 'S0704', stop_name: 'San Antonio (Lambaré)',      stop_lat: -25.3270, stop_lon: -57.6140, zone_id: 'Lambare' },
  { stop_id: 'S0705', stop_name: 'Acceso Sur Asunción',        stop_lat: -25.3210, stop_lon: -57.6270, zone_id: 'Lambare' },
]

// Mapeo ruta → paradas en orden de recorrido
const ROUTE_STOPS = {
  R01: ['S0101', 'S0102', 'S0103', 'S0104', 'S0105'],
  R02: ['S0203', 'S0202', 'S0204', 'S0201', 'S0205'],
  R03: ['S0305', 'S0304', 'S0303', 'S0301', 'S0302'],
  R04: ['S0401', 'S0402', 'S0403', 'S0404', 'S0405'],
  R05: ['S0501', 'S0502', 'S0503', 'S0504', 'S0505'],
  R06: ['S0601', 'S0602', 'S0603', 'S0604', 'S0605'],
  R07: ['S0701', 'S0702', 'S0703', 'S0704', 'S0705'],
}

// ── trips.txt + stop_times.txt ───────────────────────────────────────────────
// Horario 24h: salidas cada 2 horas (00:00 a 22:00).
// GTFS permite horas >= 24:00 para viajes que cruzan medianoche (ej. 25:30:00).
// Cada parada demora 12 minutos (tiempo de recolección + traslado).
function buildTripsAndStopTimes() {
  const trips = []
  const stopTimes = []

  const STOP_DWELL_MINUTES = 12

  // Genera salidas cada 2 horas durante las 24h
  const departures = []
  for (let h = 0; h < 24; h += 2) {
    const suffix = String(h).padStart(2, '0') + '00'
    const label = `${String(h).padStart(2, '0')}:00`
    departures.push({ suffix, label, startH: h, startM: 0 })
  }

  for (const route of ROUTES) {
    const stops = ROUTE_STOPS[route.route_id]
    for (const dep of departures) {
      const tripId = `${route.route_id}-${dep.suffix}`
      trips.push({
        trip_id: tripId,
        route_id: route.route_id,
        service_id: route.service_id,
        trip_headsign: `${route.route_long_name} — ${dep.label}`,
        shape_id: `SHP-${route.route_id}`,
        direction_id: 0,
      })

      let minuteOffset = 0
      for (let i = 0; i < stops.length; i++) {
        // GTFS permite horas >= 24 para viajes que comienzan tarde y cruzan medianoche
        const totalMinutes = dep.startH * 60 + dep.startM + minuteOffset
        const h = String(Math.floor(totalMinutes / 60)).padStart(2, '0')
        const m = String(totalMinutes % 60).padStart(2, '0')
        const timeStr = `${h}:${m}:00`

        stopTimes.push({
          trip_id: tripId,
          stop_id: stops[i],
          arrival_time: timeStr,
          departure_time: timeStr,
          stop_sequence: i + 1,
        })

        minuteOffset += STOP_DWELL_MINUTES
      }
    }
  }

  return { trips, stopTimes }
}

// ── shapes.txt vía OSRM ──────────────────────────────────────────────────────
async function fetchOsrmShape(stops) {
  const coords = stops.map((s) => `${s.stop_lon},${s.stop_lat}`).join(';')
  const url = `${OSRM_BASE}/${coords}?overview=full&geometries=geojson`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS)

  try {
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`)
    const data = await res.json()
    if (data.code !== 'Ok' || !data.routes?.[0]?.geometry?.coordinates) {
      throw new Error(`OSRM code=${data.code}`)
    }
    return data.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lon: lng }))
  } catch (error) {
    clearTimeout(timer)
    console.warn(`[OSRM] Falló, usando fallback recto: ${error.message}`)
    const points = []
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i]
      const b = stops[i + 1]
      const steps = 10
      for (let t = 0; t < steps; t++) {
        const f = t / steps
        points.push({
          lat: a.stop_lat + (b.stop_lat - a.stop_lat) * f,
          lon: a.stop_lon + (b.stop_lon - a.stop_lon) * f,
        })
      }
    }
    const last = stops.at(-1)
    points.push({ lat: last.stop_lat, lon: last.stop_lon })
    return points
  }
}

async function buildShapes() {
  const stopById = Object.fromEntries(STOPS.map((s) => [s.stop_id, s]))
  const shapes = []

  for (const [routeId, stopIds] of Object.entries(ROUTE_STOPS)) {
    const routeStops = stopIds.map((id) => stopById[id])
    console.log(`[OSRM] Calculando shape de ${routeId}...`)
    const points = await fetchOsrmShape(routeStops)
    points.forEach((pt, i) => {
      shapes.push({
        shape_id: `SHP-${routeId}`,
        shape_pt_lat: pt.lat,
        shape_pt_lon: pt.lon,
        shape_pt_sequence: i + 1,
      })
    })
    await new Promise((r) => setTimeout(r, 500))
  }

  return shapes
}

// ── Seed principal ───────────────────────────────────────────────────────────
export async function seedGtfsData({ force = false } = {}) {
  const { rows } = await query('SELECT COUNT(*) AS count FROM gtfs_routes')
  const alreadySeeded = Number(rows[0]?.count || 0) > 0

  if (alreadySeeded && !force) {
    console.log('[seed] GTFS ya cargado en DB, se omite el reseed.')
    return
  }

  console.log(force ? '[seed] Forzando reseed GTFS...' : '[seed] Base GTFS vacía, sembrando datos iniciales...')

  await query(`
    TRUNCATE TABLE
      gtfs_stop_times,
      gtfs_trips,
      gtfs_shapes,
      gtfs_stops,
      gtfs_routes,
      gtfs_calendar,
      gtfs_agency
    RESTART IDENTITY CASCADE
  `)

  // agency
  await query(
    `INSERT INTO gtfs_agency VALUES ($1,$2,$3,$4,$5)`,
    [AGENCY.agency_id, AGENCY.agency_name, AGENCY.agency_url, AGENCY.agency_timezone, AGENCY.agency_lang],
  )

  // calendar
  for (const c of CALENDAR) {
    await query(
      `INSERT INTO gtfs_calendar VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [c.service_id, c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday, c.start_date, c.end_date],
    )
  }

  // routes (incluye report_count)
  for (const r of ROUTES) {
    await query(
      `INSERT INTO gtfs_routes (route_id,agency_id,route_short_name,route_long_name,route_type,route_color,report_count) VALUES ($1,$2,$3,$4,3,$5,$6)`,
      [r.route_id, AGENCY.agency_id, r.route_short_name, r.route_long_name, r.route_color, r.report_count],
    )
  }

  // stops
  for (const s of STOPS) {
    await query(
      `INSERT INTO gtfs_stops VALUES ($1,$2,$3,$4,$5,$6)`,
      [s.stop_id, s.stop_name, s.stop_lat, s.stop_lon, s.stop_desc ?? null, s.zone_id ?? null],
    )
  }

  // trips + stop_times
  const { trips, stopTimes } = buildTripsAndStopTimes()
  for (const t of trips) {
    await query(
      `INSERT INTO gtfs_trips VALUES ($1,$2,$3,$4,$5,$6)`,
      [t.trip_id, t.route_id, t.service_id, t.trip_headsign, t.shape_id, t.direction_id],
    )
  }
  for (const st of stopTimes) {
    await query(
      `INSERT INTO gtfs_stop_times VALUES ($1,$2,$3,$4,$5)`,
      [st.trip_id, st.stop_id, st.arrival_time, st.departure_time, st.stop_sequence],
    )
  }

  // shapes (vía OSRM)
  const shapes = await buildShapes()
  for (const sh of shapes) {
    await query(
      `INSERT INTO gtfs_shapes VALUES ($1,$2,$3,$4)`,
      [sh.shape_id, sh.shape_pt_lat, sh.shape_pt_lon, sh.shape_pt_sequence],
    )
  }

  console.log(
    `[seed] OK: 1 agency | ${CALENDAR.length} services | ${ROUTES.length} routes | ${STOPS.length} stops | ${trips.length} trips | ${stopTimes.length} stop_times | ${shapes.length} shape points`,
  )
}
