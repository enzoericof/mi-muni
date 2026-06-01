import '../lib/env.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')
const servicePlanPath = path.join(projectRoot, 'server', 'data', 'collection-service-plan.json')

function readArg(name, fallback = '') {
  const prefix = `--${name}=`
  const entry = process.argv.find((value) => value.startsWith(prefix))
  return entry ? entry.slice(prefix.length) : fallback
}

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, ''))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readServicePlan() {
  const raw = await readFile(servicePlanPath, 'utf8')
  return JSON.parse(raw)
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `${response.status} ${response.statusText}`)
  }
  return { response, payload }
}

async function login({ apiBaseUrl, email, password }) {
  const { response, payload } = await requestJson(`${apiBaseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })

  const cookie = response.headers.get('set-cookie')
  if (!cookie) throw new Error('No se recibió cookie de sesión para el recolector.')
  return {
    cookie: cookie.split(';')[0],
    session: payload.session,
  }
}

async function startShift({ apiBaseUrl, cookie, route, barrio, initialPoint }) {
  const { payload } = await requestJson(`${apiBaseUrl}/api/recolector/shifts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({
      routeId: route.id,
      routeLabel: route.longName || route.shortName || route.id,
      barrioSlug: barrio.id,
      barrioLabel: barrio.label,
      lat: initialPoint[0],
      lon: initialPoint[1],
    }),
  })

  return payload.shift
}

async function sendPosition({ apiBaseUrl, cookie, shiftId, point }) {
  await requestJson(`${apiBaseUrl}/api/recolector/shifts/${encodeURIComponent(shiftId)}/positions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({
      lat: point[0],
      lon: point[1],
    }),
  })
}

async function stopShift({ apiBaseUrl, cookie, shiftId }) {
  await requestJson(`${apiBaseUrl}/api/recolector/shifts/${encodeURIComponent(shiftId)}`, {
    method: 'DELETE',
    headers: {
      cookie,
    },
  })
}

function sampleShape(shape, step) {
  if (!Array.isArray(shape) || !shape.length) return []
  const sampled = shape.filter((_, index) => index % step === 0)
  const lastPoint = shape.at(-1)
  const lastSample = sampled.at(-1)
  if (!lastSample || lastSample[0] !== lastPoint[0] || lastSample[1] !== lastPoint[1]) {
    sampled.push(lastPoint)
  }
  return sampled
}

async function main() {
  const apiBaseUrl = String(readArg('api-base-url', process.env.SIMULATOR_API_BASE_URL || 'http://127.0.0.1:8787')).replace(/\/+$/, '')
  const email = readArg('email', process.env.SIMULATOR_RECOLECTOR_EMAIL || 'recolector@mimuni.gov.py')
  const password = readArg('password', process.env.SIMULATOR_RECOLECTOR_PASSWORD || process.env.AUTH_SEED_RECOLECTOR_PASSWORD || 'MiMuniRecolector!2026')
  const routeId = readArg('route-id', process.env.SIMULATOR_ROUTE_ID || 'R01')
  const intervalMs = readNumberArg('interval-ms', 4000)
  const step = readNumberArg('step', 8)
  const loop = readArg('loop', 'true') !== 'false'

  const servicePlan = await readServicePlan()
  const route = (servicePlan.routes || []).find((item) => item.id === routeId)
  if (!route) {
    throw new Error(`No existe la ruta ${routeId} en collection-service-plan.json`)
  }

  const barrio = route.barrios?.[0]
  if (!barrio) {
    throw new Error(`La ruta ${routeId} no tiene barrios definidos.`)
  }

  const points = sampleShape(route.shape || [], step)
  if (!points.length) {
    throw new Error(`La ruta ${routeId} no tiene shape utilizable.`)
  }

  console.log(`[simulator] Login como ${email} en ${apiBaseUrl}`)
  const { cookie, session } = await login({ apiBaseUrl, email, password })
  console.log(`[simulator] Sesión iniciada para ${session?.user?.name || email}`)

  const shift = await startShift({
    apiBaseUrl,
    cookie,
    route,
    barrio,
    initialPoint: points[0],
  })
  console.log(`[simulator] Turno ${shift.id} iniciado para ${route.id} - ${route.longName}`)
  console.log(`[simulator] Enviando ${points.length} puntos cada ${intervalMs} ms${loop ? ' en bucle' : ''}`)

  const shutdown = async () => {
    try {
      await stopShift({ apiBaseUrl, cookie, shiftId: shift.id })
      console.log('[simulator] Turno finalizado.')
    } catch (error) {
      console.error('[simulator] No se pudo cerrar el turno:', error.message)
    } finally {
      process.exit(0)
    }
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  do {
    for (const point of points) {
      await sendPosition({ apiBaseUrl, cookie, shiftId: shift.id, point })
      console.log(`[simulator] -> ${point[0].toFixed(6)}, ${point[1].toFixed(6)}`)
      await sleep(intervalMs)
    }
  } while (loop)

  await shutdown()
}

main().catch((error) => {
  console.error('[simulator] Error:', error.message)
  process.exitCode = 1
})
