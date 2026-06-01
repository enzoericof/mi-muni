import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listSourceStatuses, loadRagEngine } from './lib/rag.js'
import { connectWithRetry, initSchema, query } from './db/index.js'
import { ensureCollectionSimulationWindow, seedCollectionData } from './db/collection-seed.js'
import { ensureLegacyRagMunicipalityBindings, seedRagIfEmpty, seedSnapshotChunks } from './db/rag-seed.js'
import { seedAppUsers } from './db/auth-seed.js'
import {
  getFullFeed,
  getRealtimeTripUpdatesFeed,
  getRealtimeVehiclePositionsFeed,
  getVehiclePositions,
} from './lib/gtfsEngine.js'
import { GTFS_TXT_BUILDERS, buildGtfsZipBuffer } from './lib/gtfsExport.js'
import { resetCollectionRuntimeCache } from './lib/collectionSimulation.js'
import {
  deleteCollectionNotification,
  getCollectionMap,
  getCollectionOverview,
  getCollectionZones,
  listCollectionNotifications,
  saveCollectionManualReport,
  saveCollectionNotification,
  saveCollectionRouteValidation,
} from './lib/collectionInsights.js'
import { getCollectionRuntimeSettings, setCollectionSimulationEnabled } from './lib/collectionRuntime.js'
import {
  createCollectionAdminSession,
  getCollectionAdminAuthStatus,
  getCollectionAdminSession,
  isCollectionAdminAuthConfigured,
  revokeCollectionAdminSession,
} from './lib/collectionAdminSessions.js'
import {
  createPotholeConfirmation,
  createPotholeReport,
  getPotholeDashboard,
  getPotholeReportById,
  getPotholesMap,
  listPotholeReports,
  updatePotholeReportAdmin,
} from './lib/potholes.js'
import {
  bootstrapMunicipalityGeography,
  createMunicipalBarrio,
  importMunicipalityBarriosFromFile,
  listMunicipalBarrios,
  syncAsuncionMunicipalCoverage,
  updateMunicipalBarrio,
} from './lib/municipalities.js'
import { APP_ACTIONS, consumeUserAction, getUserActionQuota } from './lib/actionLimits.js'
import {
  ensureRole,
  getSessionWithUser,
  hasRole,
  loginWithCredentials,
  loginWithGoogleCredential,
  registerDifusorWithEmail,
  revokeSession,
  ROLES,
} from './lib/auth.js'
import { createJwt, verifyJwt } from './lib/jwt.js'
import {
  broadcastRecolectorNotifications,
  endRecolectorShift,
  getDifusorProfile,
  getRecolectorProfile,
  listCollectionNotificationEvents,
  startRecolectorShift,
  updateRecolectorPosition,
} from './lib/profiles.js'
import {
  bulkUpdateRagInfoPublication,
  cancelRagCrawlJob,
  clearRagEmbeddings,
  deleteRagCrawlJob,
  deleteRagSeedUrl,
  createRagCrawlJob,
  createRagMunicipality,
  createRagSeedUrl,
  getRagAssistantRuntime,
  getRagCatalogItem,
  getRagRuntime,
  checkRagSeedUrl,
  listRagAdminCatalog,
  listRagCrawlJobResults,
  listRagCrawlJobs,
  listRagEmbeddingDetails,
  listActiveRagMunicipalities,
  listRagMunicipalities,
  listRagSeedUrls,
  listRagSourceHealth,
  rebuildApprovedSpiderChunks,
  rebuildRagEmbeddings,
  updateRagInfoPublication,
  updateRagMunicipality,
  updateRagRuntimeSettings,
  updateRagSeedUrl,
} from './lib/ragSpider.js'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distPath = path.join(serverRoot, 'dist')
const ADMIN_SESSION_COOKIE = 'mimuni_admin_session'
const APP_SESSION_COOKIE = 'mimuni_app_session'
const APP_JWT_COOKIE = 'mimuni_app_jwt'
const ADMIN_SESSION_DURATION_MS = 30 * 60 * 1000
const APP_SESSION_DURATION_MS = 12 * 60 * 60 * 1000
const APP_JWT_DURATION_SECONDS = APP_SESSION_DURATION_MS / 1000
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const POTHOLE_UPLOAD_MAX_FILES = 1
const POTHOLE_UPLOAD_MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024
const MUNICIPAL_GEO_UPLOAD_MAX_FILES = 1
const MUNICIPAL_GEO_UPLOAD_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024
const COLLECTION_ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000
const COLLECTION_ADMIN_LOGIN_MAX_ATTEMPTS = 5
const COLLECTION_ADMIN_LOGIN_BLOCK_MS = 15 * 60 * 1000
const POTHOLE_UPLOAD_ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
])

let appPromise = null
const collectionAdminLoginAttempts = new Map()

function createPotholeUploadError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function getClientIp(req) {
  const forwardedFor = String(req.header('x-forwarded-for') || '')
    .split(',')[0]
    .trim()
  return forwardedFor || req.ip || req.socket?.remoteAddress || 'unknown'
}

function getCollectionAdminLoginKey(req, username = '') {
  return `${getClientIp(req)}::${String(username || '').trim().toLowerCase()}`
}

function pruneCollectionAdminLoginAttempts(now = Date.now()) {
  for (const [key, state] of collectionAdminLoginAttempts.entries()) {
    const blockedExpired = !state.blockedUntil || state.blockedUntil <= now
    const windowExpired = !state.windowStartedAt || now - state.windowStartedAt > COLLECTION_ADMIN_LOGIN_WINDOW_MS
    if (blockedExpired && windowExpired) {
      collectionAdminLoginAttempts.delete(key)
    }
  }
}

function getCollectionAdminLoginThrottleState(req, username = '') {
  const now = Date.now()
  pruneCollectionAdminLoginAttempts(now)
  const key = getCollectionAdminLoginKey(req, username)
  const state = collectionAdminLoginAttempts.get(key)
  if (!state) {
    return { key, blocked: false, remainingMs: 0, attempts: 0 }
  }

  if (state.blockedUntil && state.blockedUntil > now) {
    return {
      key,
      blocked: true,
      remainingMs: state.blockedUntil - now,
      attempts: state.attempts || 0,
    }
  }

  return {
    key,
    blocked: false,
    remainingMs: 0,
    attempts: state.attempts || 0,
  }
}

function registerCollectionAdminLoginFailure(req, username = '') {
  const now = Date.now()
  const key = getCollectionAdminLoginKey(req, username)
  const current = collectionAdminLoginAttempts.get(key)
  const withinWindow = current && current.windowStartedAt && now - current.windowStartedAt <= COLLECTION_ADMIN_LOGIN_WINDOW_MS
  const attempts = withinWindow ? (current.attempts || 0) + 1 : 1
  const nextState = {
    attempts,
    windowStartedAt: withinWindow ? current.windowStartedAt : now,
    blockedUntil: attempts >= COLLECTION_ADMIN_LOGIN_MAX_ATTEMPTS ? now + COLLECTION_ADMIN_LOGIN_BLOCK_MS : 0,
  }
  collectionAdminLoginAttempts.set(key, nextState)
  return nextState
}

function clearCollectionAdminLoginFailures(req, username = '') {
  collectionAdminLoginAttempts.delete(getCollectionAdminLoginKey(req, username))
}

const potholeUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: POTHOLE_UPLOAD_MAX_FILES,
    fileSize: POTHOLE_UPLOAD_MAX_FILE_SIZE_BYTES,
  },
  fileFilter(_req, file, callback) {
    const mimeType = String(file.mimetype || '').toLowerCase()
    if (!POTHOLE_UPLOAD_ALLOWED_MIME_TYPES.has(mimeType)) {
      callback(createPotholeUploadError('pothole-image-type-invalid'))
      return
    }

    callback(null, true)
  },
})

const municipalGeoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MUNICIPAL_GEO_UPLOAD_MAX_FILES,
    fileSize: MUNICIPAL_GEO_UPLOAD_MAX_FILE_SIZE_BYTES,
  },
})

function normalizeOrigin(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return url.origin
  } catch (_error) {
    return ''
  }
}

function getConfiguredOrigins() {
  return [
    process.env.CORS_ORIGINS,
    process.env.APP_ORIGIN,
    process.env.VITE_APP_ORIGIN,
    process.env.VITE_API_BASE_URL,
  ]
    .flatMap((value) => String(value || '').split(','))
    .map(normalizeOrigin)
    .filter(Boolean)
}

function isLocalDevelopmentOrigin(origin) {
  const normalized = normalizeOrigin(origin)
  if (!normalized) return false
  try {
    const { hostname } = new URL(normalized)
    return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(hostname)
  } catch (_error) {
    return false
  }
}

function isAllowedOrigin(origin) {
  const normalized = normalizeOrigin(origin)
  if (!normalized) return true

  const configuredOrigins = getConfiguredOrigins()
  if (configuredOrigins.includes(normalized)) return true

  if (process.env.NODE_ENV !== 'production' && isLocalDevelopmentOrigin(normalized)) {
    return true
  }

  return false
}

function verifyRequestOrigin(req, res, next) {
  if (!UNSAFE_METHODS.has(req.method)) return next()

  const origin = req.header('origin')
  const fetchSite = String(req.header('sec-fetch-site') || '').toLowerCase()
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ ok: false, error: 'origin-forbidden' })
  }
  if (!origin && fetchSite === 'cross-site') {
    return res.status(403).json({ ok: false, error: 'origin-forbidden' })
  }

  return next()
}

function parseCookies(req) {
  const raw = String(req.header('cookie') || '')
  const cookies = {}

  for (const entry of raw.split(';')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    cookies[key] = decodeURIComponent(value)
  }

  return cookies
}

function readAdminSession(req) {
  const headerSession = String(req.header('x-admin-session') || '').trim()
  if (headerSession) return headerSession
  return String(parseCookies(req)[ADMIN_SESSION_COOKIE] || '').trim()
}

function readAppSession(req) {
  const headerSession = String(req.header('x-app-session') || '').trim()
  if (headerSession) return headerSession
  return String(parseCookies(req)[APP_SESSION_COOKIE] || '').trim()
}

function readAppJwt(req) {
  const authHeader = String(req.header('authorization') || '').trim()
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i)
  if (bearerMatch?.[1]) return bearerMatch[1].trim()

  const headerJwt = String(req.header('x-app-jwt') || '').trim()
  if (headerJwt) return headerJwt

  return String(parseCookies(req)[APP_JWT_COOKIE] || '').trim()
}

function isSecureRequest(req) {
  if (req.secure) return true
  return String(req.header('x-forwarded-proto') || '').toLowerCase() === 'https'
}

function setAdminSessionCookie(req, res, sessionId) {
  res.cookie(ADMIN_SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
    maxAge: ADMIN_SESSION_DURATION_MS,
  })
}

function clearAdminSessionCookie(req, res) {
  res.clearCookie(ADMIN_SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
  })
}

function setAppSessionCookie(req, res, sessionId) {
  res.cookie(APP_SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
    maxAge: APP_SESSION_DURATION_MS,
  })
}

function setAppJwtCookie(req, res, token) {
  res.cookie(APP_JWT_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
    maxAge: APP_SESSION_DURATION_MS,
  })
}

function clearAppSessionCookie(req, res) {
  res.clearCookie(APP_SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
  })
  res.clearCookie(APP_JWT_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
  })
}

function createAppAccessToken(session) {
  return createJwt(
    {
      sub: String(session.user.id),
      sid: session.sessionId,
      email: session.user.email,
      role: session.user.role,
      roles: session.user.roles || [session.user.role],
    },
    { expiresInSeconds: APP_JWT_DURATION_SECONDS },
  )
}

function attachAccessToken(session) {
  if (!session?.sessionId || !session?.user) return session
  return {
    ...session,
    accessToken: createAppAccessToken(session),
    tokenType: 'Bearer',
  }
}

function toPublicSession(session) {
  if (!session) return session
  const { accessToken: _accessToken, tokenType: _tokenType, ...publicSession } = session
  return publicSession
}

function setAppAuthCookies(req, res, session) {
  setAppSessionCookie(req, res, session.sessionId)
  if (session.accessToken) {
    setAppJwtCookie(req, res, session.accessToken)
  }
}

function runPotholeUpload(req, res) {
  return new Promise((resolve, reject) => {
    potholeUpload.array('images', POTHOLE_UPLOAD_MAX_FILES)(req, res, (error) => {
      if (error) reject(error)
      else resolve(req.files || [])
    })
  })
}

async function assertCollectionAdminAccess(req, res, { roles = [ROLES.ADMIN, ROLES.DESARROLLADOR] } = {}) {
  const appSession = await getRequestAppSession(req)
  if (appSession?.user && roles.some((role) => hasRole(appSession.user, role))) {
    return { kind: 'app-session', session: appSession, user: appSession.user }
  }

  if (appSession?.user) {
    res.status(403).json({ ok: false, error: 'auth-role-forbidden' })
    return null
  }

  const sessionId = readAdminSession(req)

  if (sessionId) {
    const session = await getCollectionAdminSession(sessionId)
    if (!session) {
      res.status(401).json({ ok: false, error: 'collection-admin-session-invalid' })
      return null
    }
    return { kind: 'session', session }
  }

  if (!isCollectionAdminAuthConfigured()) {
    const authStatus = getCollectionAdminAuthStatus()
    res.status(503).json({ ok: false, error: authStatus.code || 'collection-admin-auth-not-configured' })
    return null
  }

  res.status(401).json({ ok: false, error: 'collection-admin-session-required' })
  return null
}

async function getRequestAppSession(req) {
  const jwt = readAppJwt(req)
  if (jwt) {
    const claims = verifyJwt(jwt)
    if (claims?.sid) {
      return getSessionWithUser(claims.sid)
    }
  }

  const sessionId = readAppSession(req)
  if (!sessionId) return null
  return getSessionWithUser(sessionId)
}

async function assertAppSession(req, res) {
  const session = await getRequestAppSession(req)
  if (!session) {
    res.status(401).json({ ok: false, error: 'auth-session-required' })
    return null
  }
  return session
}

async function assertAppRole(req, res, roles) {
  const session = await assertAppSession(req, res)
  if (!session) return null
  const allowed = Array.isArray(roles) ? roles : [roles]
  if (!allowed.some((role) => hasRole(session.user, role))) {
    res.status(403).json({ ok: false, error: 'auth-role-forbidden' })
    return null
  }
  return session
}

function sendRagAdminError(res, error) {
  const statusCode = {
    'auth-session-required': 401,
    'auth-role-forbidden': 403,
    'rag-municipality-required': 400,
    'rag-municipality-required-fields': 400,
    'rag-seed-url-invalid': 400,
    'rag-seed-url-required': 400,
    'rag-seed-url-not-found': 404,
    'rag-seed-url-job-active': 409,
    'rag-seed-url-municipality-mismatch': 400,
    'rag-crawl-job-active': 409,
    'rag-public-index-boolean-required': 400,
    'rag-spider-operations-boolean-required': 400,
    'rag-runtime-update-required': 400,
    'rag-publication-visible-required': 400,
    'spider-operation-disabled': 409,
    'openai-disabled': 503,
    'rag-assistant-use-embeddings-boolean-required': 400,
    'rag-assistant-chunk-limit-invalid': 400,
    'rag-assistant-chunk-limit-max-unavailable': 409,
    'rag-assistant-min-relevance-score-invalid': 400,
    'rag-assistant-strict-municipality-scope-boolean-required': 400,
    'municipality-not-found': 404,
    'municipality-ine-code-missing': 400,
    'municipal-barrios-source-unavailable': 503,
    'municipal-barrios-source-empty': 422,
    'municipal-barrios-import-file-required': 400,
    'municipal-barrios-import-format-invalid': 422,
    'municipal-barrios-import-empty': 422,
    'municipal-barrio-required-fields': 400,
    'municipal-barrio-not-found': 404,
    'municipal-barrio-municipality-mismatch': 400,
  }[error.code] || error.status || 500

  res.status(statusCode).json({ ok: false, error: error.code || error.message })
}

async function ensureCollectionStartupWindow() {
  const collectionRuntime = await getCollectionRuntimeSettings()
  if (!collectionRuntime.simulationEnabled) return

  try {
    await ensureCollectionSimulationWindow()
  } catch (error) {
    const canRecover =
      error?.code === '23503' &&
      error?.constraint === 'collection_run_barrio_events_barrio_id_fkey'

    if (!canRecover) throw error

    console.warn('[seed] Se detecto un desajuste en collection_run_barrio_events. Rehaciendo el backend de recoleccion...')
    await seedCollectionData({ force: true })
    resetCollectionRuntimeCache()
    await ensureCollectionSimulationWindow()
  }
}

async function createApp() {
  await connectWithRetry()
  await initSchema()
  await seedAppUsers({ force: process.env.AUTH_FORCE_RESEED === 'true' })
  await seedCollectionData({ force: process.env.GTFS_FORCE_RESEED === 'true' })
  await syncAsuncionMunicipalCoverage()
  resetCollectionRuntimeCache()
  await ensureCollectionStartupWindow()
  await seedRagIfEmpty()
  await ensureLegacyRagMunicipalityBindings()

  if (process.env.RAG_SYNC_ON_BOOT === 'true') {
    await seedSnapshotChunks()
  }

  let engine = await loadRagEngine()

  async function syncRagEngineFromApprovedSpiderSources() {
    const rebuild = await rebuildApprovedSpiderChunks()
    engine = await loadRagEngine()
    return rebuild
  }

  async function ensureRagIndexConsistency() {
    const runtime = await getRagRuntime({ includeSpiderHealth: false })
    const hasVisibleSpiderSources = Number(runtime?.counts?.spiderVisibleItems || 0) > 0
    const hasConnectedSpiderChunks = Number(runtime?.counts?.spiderChunks || 0) > 0

    if (runtime?.publicIndexEnabled && hasVisibleSpiderSources && !hasConnectedSpiderChunks) {
      console.warn('[rag] Indice inconsistente: hay fuentes spider visibles pero 0 chunks conectados. Reconstruyendo indice...')
      return syncRagEngineFromApprovedSpiderSources()
    }

    return null
  }

  await ensureRagIndexConsistency()

  const app = express()
  app.use(
    cors({
      origin(origin, callback) {
        if (isAllowedOrigin(origin)) {
          callback(null, origin || true)
          return
        }
        callback(null, false)
      },
      credentials: true,
    }),
  )
  app.use(express.json())
  app.use(verifyRequestOrigin)

  app.get('/api/health', async (_req, res) => {
    const runtime = await getCollectionRuntimeSettings()
    res.json({
      ok: true,
      service: 'municipal-rag-api',
      city: 'asuncion',
      procedures: engine.procedures.length,
      chunks: engine.chunks.length,
      embeddingModel: engine.embeddingModel,
      chatModel: engine.chatModel,
      ragSyncOnBoot: process.env.RAG_SYNC_ON_BOOT === 'true',
      gtfsForceReseed: process.env.GTFS_FORCE_RESEED === 'true',
      collectionSimulationEnabled: runtime.simulationEnabled,
      collectionAdminConfigured: isCollectionAdminAuthConfigured(),
    })
  })

  app.post('/api/auth/login', async (req, res) => {
    const email = String(req.body?.email || '').trim()
    const password = String(req.body?.password || '').trim()
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'auth-credentials-required' })
    }

    try {
      const session = attachAccessToken(await loginWithCredentials(email, password))
      setAppAuthCookies(req, res, session)
      res.status(201).json({ ok: true, session: toPublicSession(session) })
    } catch (error) {
      if (error.code === 'auth-invalid-credentials') {
        return res.status(401).json({ ok: false, error: error.code })
      }
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.post('/api/auth/register-difusor', async (req, res) => {
    try {
      const session = attachAccessToken(await registerDifusorWithEmail(req.body || {}))
      setAppAuthCookies(req, res, session)
      res.status(201).json({ ok: true, session: toPublicSession(session) })
    } catch (error) {
      const statusCode = {
        'auth-email-invalid': 400,
        'auth-name-required': 400,
        'auth-password-too-short': 400,
        'auth-email-already-registered': 409,
      }[error.code] || 500
      res.status(statusCode).json({ ok: false, error: error.code || error.message })
    }
  })

  app.post('/api/auth/google', async (req, res) => {
    try {
      const session = attachAccessToken(await loginWithGoogleCredential(req.body?.credential, { mode: req.body?.mode }))
      setAppAuthCookies(req, res, session)
      res.status(201).json({ ok: true, session: toPublicSession(session) })
    } catch (error) {
      const statusCode = {
        'auth-google-not-configured': 503,
        'auth-google-credential-required': 400,
        'auth-google-invalid': 401,
        'auth-google-difusor-only': 403,
        'auth-google-account-conflict': 409,
        'auth-google-user-not-found': 404,
        'auth-email-invalid': 400,
        'auth-name-required': 400,
      }[error.code] || 500
      res.status(statusCode).json({ ok: false, error: error.code || error.message })
    }
  })

  app.get('/api/auth/session', async (req, res) => {
    const tokenClaims = verifyJwt(readAppJwt(req))
    const sessionId = tokenClaims?.sid || readAppSession(req)
    if (!sessionId) {
      clearAppSessionCookie(req, res)
      return res.json({ ok: true, session: null })
    }

    try {
      const session = attachAccessToken(await getSessionWithUser(sessionId))
      if (!session) {
        clearAppSessionCookie(req, res)
        return res.json({ ok: true, session: null })
      }
      setAppAuthCookies(req, res, session)
      res.json({ ok: true, session: toPublicSession(session) })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.delete('/api/auth/session', async (req, res) => {
    const sessionId = readAppSession(req)
    try {
      const revoked = sessionId ? await revokeSession(sessionId) : false
      clearAppSessionCookie(req, res)
      res.json({ ok: true, revoked })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/profile/difusor', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DIFUSOR)
    if (!session) return
    try {
      res.json({ ok: true, profile: await getDifusorProfile(session.user) })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/profile/recolector', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.RECOLECTOR)
    if (!session) return
    try {
      res.json({ ok: true, profile: await getRecolectorProfile(session.user) })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.post('/api/recolector/shifts', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.RECOLECTOR)
    if (!session) return
    try {
      const shift = await startRecolectorShift(session.user, req.body || {})
      res.status(201).json({ ok: true, shift })
    } catch (error) {
      const statusCode = error.code === 'recolector-shift-required-fields' ? 400 : 500
      res.status(statusCode).json({ ok: false, error: error.code || error.message })
    }
  })

  app.post('/api/recolector/shifts/:id/positions', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.RECOLECTOR)
    if (!session) return
    try {
      const shift = await updateRecolectorPosition(session.user, req.params.id, req.body || {})
      if (!shift) return res.status(404).json({ ok: false, error: 'recolector-shift-not-found' })
      res.json({ ok: true, shift })
    } catch (error) {
      const statusCode = error.code === 'recolector-position-invalid' ? 400 : 500
      res.status(statusCode).json({ ok: false, error: error.code || error.message })
    }
  })

  app.delete('/api/recolector/shifts/:id', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.RECOLECTOR)
    if (!session) return
    try {
      const shift = await endRecolectorShift(session.user, req.params.id)
      if (!shift) return res.status(404).json({ ok: false, error: 'recolector-shift-not-found' })
      res.json({ ok: true, shift })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.post('/api/recolector/notifications', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.RECOLECTOR)
    if (!session) return
    try {
      const result = await broadcastRecolectorNotifications(session.user, req.body || {})
      res.status(201).json({ ok: true, result })
    } catch (error) {
      const statusCode = error.code === 'recolector-notification-zones-required' ? 400 : 500
      res.status(statusCode).json({ ok: false, error: error.code || error.message })
    }
  })

  app.post('/api/admin/collection/session/login', async (req, res) => {
    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '').trim()
    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'username y password son requeridos' })
    }

    const throttleState = getCollectionAdminLoginThrottleState(req, username)
    if (throttleState.blocked) {
      res.setHeader('Retry-After', String(Math.ceil(throttleState.remainingMs / 1000)))
      return res.status(429).json({ ok: false, error: 'collection-admin-rate-limit-exceeded' })
    }

    try {
      const session = await createCollectionAdminSession({
        username,
        password,
        createdBy: req.body?.createdBy || username || 'admin-recoleccion-page',
      })
      clearCollectionAdminLoginFailures(req, username)
      setAdminSessionCookie(req, res, session.sessionId)
      res.status(201).json({ ok: true, session })
    } catch (error) {
      if (error.code === 'collection-admin-auth-not-configured') {
        return res.status(503).json({ ok: false, error: error.code })
      }
      if (error.code === 'collection-admin-auth-insecure-config') {
        return res.status(503).json({ ok: false, error: error.code })
      }
      if (error.code === 'collection-admin-unauthorized') {
        registerCollectionAdminLoginFailure(req, username)
        return res.status(401).json({ ok: false, error: error.code })
      }
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/admin/collection/session', async (req, res) => {
    const sessionId = readAdminSession(req)
    if (!sessionId) {
      clearAdminSessionCookie(req, res)
      return res.status(401).json({ ok: false, error: 'collection-admin-session-required' })
    }

    try {
      const session = await getCollectionAdminSession(sessionId)
      if (!session) {
        clearAdminSessionCookie(req, res)
        return res.status(401).json({ ok: false, error: 'collection-admin-session-invalid' })
      }
      res.json({ ok: true, session })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.delete('/api/admin/collection/session', async (req, res) => {
    const sessionId = readAdminSession(req)
    if (!sessionId) {
      clearAdminSessionCookie(req, res)
      return res.status(400).json({ ok: false, error: 'collection-admin-session-required' })
    }

    try {
      const revoked = await revokeCollectionAdminSession(sessionId)
      clearAdminSessionCookie(req, res)
      res.json({ ok: true, revoked })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/admin/collection/runtime', async (req, res) => {
    const access = await assertCollectionAdminAccess(req, res)
    if (!access) return

    try {
      res.json({ ok: true, runtime: await getCollectionRuntimeSettings() })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.patch('/api/admin/collection/runtime', async (req, res) => {
    const access = await assertCollectionAdminAccess(req, res)
    if (!access) return

    if (typeof req.body?.simulationEnabled !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'simulationEnabled boolean requerido' })
    }

    try {
      const runtime = await setCollectionSimulationEnabled(
        req.body.simulationEnabled,
        req.body?.updatedBy || 'admin-panel',
      )
      resetCollectionRuntimeCache()
      if (runtime.simulationEnabled) {
        await ensureCollectionSimulationWindow()
      }
      res.json({ ok: true, runtime })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/admin/rag/runtime', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      res.json({ ok: true, runtime: await getRagRuntime() })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.patch('/api/admin/rag/runtime', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const settings = await updateRagRuntimeSettings({
        publicIndexEnabled: req.body?.publicIndexEnabled,
        spiderOperationsEnabled: req.body?.spiderOperationsEnabled,
        assistantUseEmbeddings: req.body?.assistantUseEmbeddings,
        assistantChunkLimit: req.body?.assistantChunkLimit,
        assistantMinRelevanceScore: req.body?.assistantMinRelevanceScore,
        assistantStrictMunicipalityScope: req.body?.assistantStrictMunicipalityScope,
        updatedBy: session.user.email || 'desarrollador',
      })
      engine = await loadRagEngine()
      res.json({ ok: true, runtime: { ...(await getRagRuntime()), ...settings } })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.get('/api/admin/rag/municipalities', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      res.json({ ok: true, municipalities: await listRagMunicipalities() })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.post('/api/admin/rag/municipalities', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const municipality = await createRagMunicipality(req.body || {})
      res.status(201).json({ ok: true, municipality })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.patch('/api/admin/rag/municipalities/:id', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const municipality = await updateRagMunicipality(req.params.id, req.body || {})
      if (!municipality) return res.status(404).json({ ok: false, error: 'rag-municipality-not-found' })
      res.json({ ok: true, municipality })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.post('/api/admin/rag/municipalities/:id/bootstrap-geography', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const result = await bootstrapMunicipalityGeography({
        municipalityId: req.params.id,
        requestedBy: session.user.email || 'desarrollador',
      })
      res.json({ ok: true, result })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.post('/api/admin/rag/municipalities/:id/import-barrios', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    municipalGeoUpload.single('file')(req, res, async (error) => {
      if (error instanceof multer.MulterError) {
        return sendRagAdminError(res, { code: 'municipal-barrios-import-format-invalid', status: 422 })
      }
      if (error) {
        return sendRagAdminError(res, error)
      }

      try {
        const result = await importMunicipalityBarriosFromFile({
          municipalityId: req.params.id,
          fileName: req.file?.originalname || '',
          fileBuffer: req.file?.buffer || null,
          sourceName: String(req.body?.sourceName || '').trim(),
          sourceUrl: String(req.body?.sourceUrl || '').trim(),
          requestedBy: session.user.email || 'desarrollador',
        })
        res.json({ ok: true, result })
      } catch (uploadError) {
        sendRagAdminError(res, uploadError)
      }
    })
  })

  app.get('/api/admin/rag/municipalities/:id/barrios', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const barrios = await listMunicipalBarrios({ municipalityId: req.params.id })
      res.json({ ok: true, barrios })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.post('/api/admin/rag/municipalities/:id/barrios', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const barrio = await createMunicipalBarrio({
        municipalityId: req.params.id,
        barrioLabel: req.body?.barrioLabel,
        barrioCode: req.body?.barrioCode,
        centerLat: req.body?.centerLat,
        centerLon: req.body?.centerLon,
        sourceName: req.body?.sourceName,
        sourceUrl: req.body?.sourceUrl,
        requestedBy: session.user.email || 'desarrollador',
      })
      res.status(201).json({ ok: true, barrio })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.patch('/api/admin/rag/municipalities/:id/barrios/:barrioId', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const barrio = await updateMunicipalBarrio(req.params.barrioId, {
        municipalityId: req.params.id,
        barrioLabel: req.body?.barrioLabel,
        barrioCode: req.body?.barrioCode,
        centerLat: req.body?.centerLat,
        centerLon: req.body?.centerLon,
        requestedBy: session.user.email || 'desarrollador',
      })
      res.json({ ok: true, barrio })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.get('/api/admin/rag/seed-urls', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      res.json({
        ok: true,
        seedUrls: await listRagSeedUrls({ municipalityId: String(req.query.municipality_id || '') }),
      })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.post('/api/admin/rag/seed-urls', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const seedUrl = await createRagSeedUrl(req.body || {}, session.user)
      res.status(201).json({ ok: true, seedUrl })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.patch('/api/admin/rag/seed-urls/:id', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const seedUrl = await updateRagSeedUrl(req.params.id, req.body || {}, session.user)
      if (!seedUrl) return res.status(404).json({ ok: false, error: 'rag-seed-url-not-found' })
      res.json({ ok: true, seedUrl })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.post('/api/admin/rag/seed-urls/:id/check', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const seedUrl = await checkRagSeedUrl(req.params.id, { checkedBy: session.user.email || 'desarrollador' })
      if (!seedUrl) return res.status(404).json({ ok: false, error: 'rag-seed-url-not-found' })
      res.json({ ok: true, seedUrl })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.delete('/api/admin/rag/seed-urls/:id', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const seedUrl = await deleteRagSeedUrl(req.params.id, { deletedBy: session.user.email || 'desarrollador' })
      if (!seedUrl) return res.status(404).json({ ok: false, error: 'rag-seed-url-not-found' })
      res.json({ ok: true, seedUrl })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.get('/api/admin/rag/source-health', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      res.json({
        ok: true,
        sources: await listRagSourceHealth({ municipalityId: String(req.query.municipality_id || '') }),
      })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.get('/api/admin/rag/crawl-jobs', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      res.json({
        ok: true,
        jobs: await listRagCrawlJobs({
          municipalityId: String(req.query.municipality_id || ''),
          limit: Number(req.query.limit || 20),
        }),
      })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.get('/api/admin/rag/crawl-jobs/:id/results', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const results = await listRagCrawlJobResults(req.params.id, {
        type: String(req.query.type || 'pages'),
        page: Number(req.query.page || 1),
        pageSize: Number(req.query.page_size || 8),
      })
      if (!results) return res.status(404).json({ ok: false, error: 'rag-crawl-job-not-found' })
      res.json({ ok: true, results })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.post('/api/admin/rag/crawl-jobs', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const job = await createRagCrawlJob({
        municipalityId: req.body?.municipalityId,
        seedUrlIds: req.body?.seedUrlIds,
        requestedBy: session.user.email || 'desarrollador',
      })
      res.status(201).json({ ok: true, job })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.post('/api/admin/rag/crawl-jobs/:id/cancel', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const job = await cancelRagCrawlJob(req.params.id, { requestedBy: session.user.email || 'desarrollador' })
      if (!job) return res.status(404).json({ ok: false, error: 'rag-crawl-job-not-found' })
      res.json({ ok: true, job })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.delete('/api/admin/rag/crawl-jobs/:id', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const job = await deleteRagCrawlJob(req.params.id, { deletedBy: session.user.email || 'desarrollador' })
      if (!job) return res.status(404).json({ ok: false, error: 'rag-crawl-job-not-found' })
      res.json({ ok: true, job })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  async function handleRagIndexRebuild(req, res) {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const rebuild = await syncRagEngineFromApprovedSpiderSources()
      res.json({ ok: true, rebuild, procedures: engine.procedures.length, chunks: engine.chunks.length })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  }

  app.post('/api/admin/rag/index/rebuild', handleRagIndexRebuild)
  app.post('/api/admin/rag/reload', handleRagIndexRebuild)

  app.post('/api/admin/rag/embeddings/rebuild', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const rebuild = await rebuildRagEmbeddings({ onlyMissing: req.body?.onlyMissing === true })
      engine = await loadRagEngine()
      res.json({ ok: rebuild.ok !== false, rebuild, procedures: engine.procedures.length, chunks: engine.chunks.length })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.get('/api/admin/rag/embeddings', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const details = await listRagEmbeddingDetails({
        municipalityId: String(req.query.municipality_id || ''),
        query: String(req.query.q || ''),
        state: String(req.query.state || 'all'),
        page: Number(req.query.page || 1),
        pageSize: Number(req.query.page_size || 20),
      })
      res.json({ ok: true, details })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.delete('/api/admin/rag/embeddings', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      const result = await clearRagEmbeddings({
        municipalityId: req.body?.municipalityId || req.query?.municipality_id || '',
        connectedOnly: req.body?.connectedOnly !== false,
      })
      engine = await loadRagEngine()
      res.json({ ok: true, result, procedures: engine.procedures.length, chunks: engine.chunks.length })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.get('/api/admin/rag/catalog', async (req, res) => {
    const session = await assertAppRole(req, res, [ROLES.ADMIN, ROLES.DESARROLLADOR])
    if (!session) return

    try {
      res.json({
        ok: true,
        catalog: await listRagAdminCatalog({
          municipalityId: String(req.query.municipality_id || ''),
          sourceType: String(req.query.source_type || ''),
          visibility: String(req.query.visibility || ''),
          query: String(req.query.q || ''),
          limit: Number(req.query.limit || 50),
        }),
      })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.get('/api/admin/rag/catalog/:id', async (req, res) => {
    const session = await assertAppRole(req, res, [ROLES.ADMIN, ROLES.DESARROLLADOR])
    if (!session) return

    try {
      const item = await getRagCatalogItem(req.params.id)
      if (!item) return res.status(404).json({ ok: false, error: 'rag-catalog-item-not-found' })
      res.json({ ok: true, item })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.patch('/api/admin/rag/info-publication/:id', async (req, res) => {
    const session = await assertAppRole(req, res, [ROLES.ADMIN, ROLES.DESARROLLADOR])
    if (!session) return

    try {
      const item = await updateRagInfoPublication(req.params.id, {
        visible: req.body?.visible,
        notes: req.body?.notes,
        selectedBy: session.user.email || 'desarrollador',
      })
      if (!item) return res.status(404).json({ ok: false, error: 'rag-catalog-item-not-found' })
      const rebuild = await syncRagEngineFromApprovedSpiderSources()
      res.json({ ok: true, item, rebuild, procedures: engine.procedures.length, chunks: engine.chunks.length })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.post('/api/admin/rag/info-publication/bulk', async (req, res) => {
    const session = await assertAppRole(req, res, [ROLES.ADMIN, ROLES.DESARROLLADOR])
    if (!session) return

    try {
      const result = await bulkUpdateRagInfoPublication({
        municipalityId: req.body?.municipalityId,
        visible: req.body?.visible,
        sourceType: String(req.body?.sourceType || ''),
        notes: req.body?.notes,
        selectedBy: session.user.email || 'desarrollador',
      })
      const rebuild = await syncRagEngineFromApprovedSpiderSources()
      res.json({ ok: true, result, rebuild, procedures: engine.procedures.length, chunks: engine.chunks.length })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.get('/api/rag/active-municipalities', async (_req, res) => {
    try {
      res.json({ ok: true, municipalities: await listActiveRagMunicipalities() })
    } catch (_error) {
      res.json({ ok: true, municipalities: [] })
    }
  })

  app.get('/api/rag/catalog', async (_req, res) => {
    res.json({
      city: 'asuncion',
      results: engine.procedures.map((p) => ({
        id: p.id,
        titulo: p.titulo,
        categoria: p.categoria,
        tipo: p.tipo,
        fuente: p.fuente,
      })),
    })
  })

  app.get('/api/rag/procedure/:id', async (req, res) => {
    const procedure = engine.getProcedureById(req.params.id)
    if (!procedure) return res.status(404).json({ ok: false, error: 'procedure-not-found' })
    res.json({ ok: true, result: procedure })
  })

  app.get('/api/rag/procedure/:id/section/:section', async (req, res) => {
    const procedure = engine.getProcedureById(req.params.id)
    if (!procedure) return res.status(404).json({ ok: false, error: 'procedure-not-found' })
    const sectionResult = await engine.getProcedureSection(req.params.id, req.params.section)
    if (!sectionResult) return res.status(404).json({ ok: false, error: 'section-not-found' })
    res.json({ ok: true, result: sectionResult })
  })

  app.get('/api/rag/search', async (req, res) => {
    const query_ = String(req.query.q || '')
    const categoria = String(req.query.categoria || 'all')
    const tipo = String(req.query.tipo || 'all')
    const seccion = String(req.query.seccion || 'all')
    const onlyOfficialSource = String(req.query.onlyOfficialSource || 'false') === 'true'
    const limit = Math.max(1, Math.min(10, Number(req.query.limit || 6)))
    const municipalityId = String(req.query.municipality_id || '').trim()
    const municipalitySlug = String(req.query.municipality_slug || req.query.municipality || '').trim()
    const runtimeConfig = await getRagAssistantRuntime()
    res.json(await engine.search({
      query: query_,
      categoria,
      tipo,
      seccion,
      onlyOfficialSource,
      limit,
      municipalityId,
      municipalitySlug,
      runtimeConfig,
    }))
  })

  app.post('/api/rag/ask', async (req, res) => {
    const q = String(req.body?.query || '').trim()
    if (!q) {
      return res
        .status(400)
        .json({ ok: false, error: 'query-required', message: 'Debes enviar una consulta en el body.' })
    }

    try {
      const appSession = await getRequestAppSession(req)
      const user = appSession?.user || null
      const quota = user ? await getUserActionQuota(user, APP_ACTIONS.MUNITA_ASK) : null
      if (quota && !quota.allowed) {
        return res.status(429).json({
          ok: false,
          error: 'action-limit-exceeded',
          message: `Llegaste al límite diario de ${quota.dailyLimit} ${quota.dailyLimit === 1 ? 'consulta' : 'consultas'} para Munita.`,
          usage: {
            [APP_ACTIONS.MUNITA_ASK]: quota,
          },
        })
      }

      const runtimeConfig = await getRagAssistantRuntime()
      const answer = await engine.ask({
        query: q,
        municipalityId: req.body?.municipalityId,
        municipalitySlug: req.body?.municipalitySlug || req.body?.municipality,
        municipalityName: req.body?.municipalityName,
        runtimeConfig,
      })

      const nextQuota = user ? await consumeUserAction(user, APP_ACTIONS.MUNITA_ASK) : null

      res.json({
        ok: true,
        answer,
        usage: nextQuota
          ? {
              [APP_ACTIONS.MUNITA_ASK]: nextQuota,
            }
          : {},
      })
    } catch (error) {
      const statusCode = error?.status || 500
      res.status(statusCode).json({
        ok: false,
        error: error?.code || error?.message || 'rag-ask-failed',
        message: error?.message || 'No se pudo completar la consulta.',
        usage: error?.usage
          ? {
              [error.usage.actionKey]: error.usage,
            }
          : undefined,
      })
    }
  })

  app.get('/api/rag/sources', async (_req, res) => {
    res.json({ city: 'asuncion', sources: await listSourceStatuses() })
  })

  app.post('/api/rag/reload', async (req, res) => {
    const session = await assertAppRole(req, res, ROLES.DESARROLLADOR)
    if (!session) return

    try {
      engine = await loadRagEngine()
      res.json({ ok: true, procedures: engine.procedures.length, chunks: engine.chunks.length })
    } catch (error) {
      sendRagAdminError(res, error)
    }
  })

  app.get('/api/gtfs/feed', async (_req, res) => {
    try {
      res.json({ ok: true, feed: await getFullFeed() })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/gtfs/agency', async (_req, res) => {
    const { rows } = await query('SELECT * FROM gtfs_agency')
    res.json({ ok: true, agency: rows })
  })

  app.get('/api/gtfs/routes', async (_req, res) => {
    const { rows } = await query('SELECT * FROM gtfs_routes ORDER BY route_id')
    res.json({ ok: true, routes: rows })
  })

  app.get('/api/gtfs/stops', async (_req, res) => {
    const { rows } = await query('SELECT * FROM gtfs_stops ORDER BY stop_id')
    res.json({ ok: true, stops: rows })
  })

  app.get('/api/gtfs/trips', async (req, res) => {
    const routeId = req.query.route_id
    const sql = routeId
      ? 'SELECT * FROM gtfs_trips WHERE route_id = $1 ORDER BY trip_id'
      : 'SELECT * FROM gtfs_trips ORDER BY trip_id'
    const { rows } = await query(sql, routeId ? [routeId] : [])
    res.json({ ok: true, trips: rows })
  })

  app.get('/api/gtfs/stop_times', async (req, res) => {
    const tripId = req.query.trip_id
    if (!tripId) return res.status(400).json({ ok: false, error: 'trip_id requerido como query param' })

    const { rows } = await query(
      `SELECT st.*, s.stop_name, s.stop_lat, s.stop_lon
       FROM gtfs_stop_times st
       JOIN gtfs_stops s ON s.stop_id = st.stop_id
       WHERE st.trip_id = $1
       ORDER BY st.stop_sequence`,
      [tripId],
    )

    res.json({ ok: true, stop_times: rows })
  })

  app.get('/api/gtfs/shapes', async (req, res) => {
    const shapeId = req.query.shape_id
    if (!shapeId) return res.status(400).json({ ok: false, error: 'shape_id requerido como query param' })

    const { rows } = await query(
      'SELECT * FROM gtfs_shapes WHERE shape_id = $1 ORDER BY shape_pt_sequence',
      [shapeId],
    )

    res.json({ ok: true, shapes: rows })
  })

  app.get('/api/gtfs/calendar', async (_req, res) => {
    const { rows } = await query('SELECT * FROM gtfs_calendar ORDER BY service_id')
    res.json({ ok: true, calendar: rows })
  })

  app.get('/api/gtfs/vehicles', async (_req, res) => {
    try {
      const runtime = await getCollectionRuntimeSettings()
      const vehicles = await getVehiclePositions()
      res.json({
        ok: true,
        simulationEnabled: runtime.simulationEnabled,
        generated_at: new Date().toISOString(),
        vehicles,
      })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/gtfs-rt/vehicle-positions', async (_req, res) => {
    try {
      const runtime = await getCollectionRuntimeSettings()
      res.json({ ok: true, simulationEnabled: runtime.simulationEnabled, feed: await getRealtimeVehiclePositionsFeed() })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/gtfs-rt/trip-updates', async (_req, res) => {
    try {
      const runtime = await getCollectionRuntimeSettings()
      res.json({ ok: true, simulationEnabled: runtime.simulationEnabled, feed: await getRealtimeTripUpdatesFeed() })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/collection/zones', async (req, res) => {
    try {
      const includeGeometry = req.query.include_geometry !== 'false'
      res.json({
        ok: true,
        ...(await getCollectionZones({
          municipalityId: String(req.query.municipality_id || '').trim(),
          municipalitySlug: String(req.query.municipality_slug || req.query.municipality || '').trim(),
          includeGeometry,
        })),
      })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/collection/map', async (req, res) => {
    try {
      const includeRouteShapes = req.query.include_shapes !== 'false'
      res.json({
        ok: true,
        map: await getCollectionMap({
          includeRouteShapes,
          municipalityId: String(req.query.municipality_id || '').trim(),
          municipalitySlug: String(req.query.municipality_slug || req.query.municipality || '').trim(),
        }),
      })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/collection/overview', async (req, res) => {
    const zoneId = String(req.query.zone_id || '').trim()
    if (!zoneId) {
      return res.status(400).json({ ok: false, error: 'zone_id requerido como query param' })
    }

    try {
      const overview = await getCollectionOverview(zoneId, {
        municipalityId: String(req.query.municipality_id || '').trim(),
        municipalitySlug: String(req.query.municipality_slug || req.query.municipality || '').trim(),
      })
      if (!overview) {
        return res.status(404).json({ ok: false, error: 'zone-not-found' })
      }

      res.json({ ok: true, overview })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.post('/api/collection/reports', async (req, res) => {
    const session = await assertAppRole(req, res, [ROLES.ADMIN, ROLES.DESARROLLADOR, ROLES.RECOLECTOR])
    if (!session) return

    const zoneId = String(req.body?.zoneId || '').trim()
    const routeId = String(req.body?.routeId || '').trim()
    const addressLabel = String(req.body?.addressLabel || '').trim()
    const notes = String(req.body?.notes || '').trim()

    if (!zoneId) {
      return res.status(400).json({ ok: false, error: 'zoneId requerido' })
    }

    try {
      const report = await saveCollectionManualReport({
        zoneId,
        routeId,
        addressLabel,
        notes,
      })
      res.status(201).json({ ok: true, report })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.post('/api/collection/validations', async (req, res) => {
    const session = await assertAppRole(req, res, [ROLES.ADMIN, ROLES.DESARROLLADOR, ROLES.RECOLECTOR])
    if (!session) return

    const zoneId = String(req.body?.zoneId || '').trim()
    const routeId = String(req.body?.routeId || '').trim()
    const validationStatus = String(req.body?.validationStatus || '').trim()
    const notes = String(req.body?.notes || '').trim()

    if (!zoneId || !validationStatus) {
      return res.status(400).json({ ok: false, error: 'zoneId y validationStatus son requeridos' })
    }

    try {
      const validation = await saveCollectionRouteValidation({
        zoneId,
        routeId,
        validationStatus,
        notes,
      })
      res.status(201).json({ ok: true, validation })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.post('/api/collection/notifications', async (req, res) => {
    const appSession = await assertAppSession(req, res)
    if (!appSession) return

    const zoneId = String(req.body?.zoneId || '').trim()
    const eventType = String(req.body?.eventType || '').trim()
    const channel = String(req.body?.channel || '').trim()
    const leadMinutes = Number(req.body?.leadMinutes || 15)
    const preferredDays = Array.isArray(req.body?.preferredDays) ? req.body.preferredDays : []
    const timeWindowStart = String(req.body?.timeWindowStart || '').trim()
    const timeWindowEnd = String(req.body?.timeWindowEnd || '').trim()

    if (!zoneId || !eventType || !channel) {
      return res.status(400).json({ ok: false, error: 'zoneId, eventType y channel son requeridos' })
    }

    try {
      const notification = await saveCollectionNotification({
        userId: appSession.user.id,
        zoneId,
        eventType,
        channel,
        leadMinutes: Number.isFinite(leadMinutes) ? leadMinutes : 15,
        preferredDays,
        timeWindowStart,
        timeWindowEnd,
      })
      res.status(201).json({ ok: true, notification })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/collection/notifications', async (req, res) => {
    const session = await assertAppSession(req, res)
    if (!session) return

    try {
      const zoneId = String(req.query.zone_id || '').trim()
      res.json({ ok: true, notifications: await listCollectionNotifications(zoneId, { userId: session.user.id }) })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/collection/notification-events', async (req, res) => {
    const session = await assertAppSession(req, res)
    if (!session) return

    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json({
        ok: true,
        events: await listCollectionNotificationEvents(session.user, {
          sinceId: Number(req.query.since_id || 0),
          channel: String(req.query.channel || 'panel'),
          limit: Number(req.query.limit || 10),
        }),
      })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.delete('/api/collection/notifications/:id', async (req, res) => {
    const session = await assertAppSession(req, res)
    if (!session) return

    const notificationId = Number(req.params.id)
    if (!Number.isFinite(notificationId)) {
      return res.status(400).json({ ok: false, error: 'notification id invalido' })
    }

    try {
      const deleted = await deleteCollectionNotification(notificationId, { userId: session.user.id })
      if (!deleted) {
        return res.status(404).json({ ok: false, error: 'notification-not-found' })
      }
      res.json({ ok: true, deleted })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/potholes/map', async (req, res) => {
    try {
      const appSession = await getRequestAppSession(req)
      res.setHeader('Cache-Control', 'no-store')
      res.json({
        ok: true,
        map: await getPotholesMap({
          viewerEmail: appSession?.user?.email || '',
          municipalityId: String(req.query.municipality_id || '').trim(),
          municipalitySlug: String(req.query.municipality_slug || req.query.municipality || '').trim(),
        }),
      })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/potholes/reports', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store')
      const reports = await listPotholeReports({
        municipalityId: String(req.query.municipality_id || '').trim(),
        municipalitySlug: String(req.query.municipality_slug || req.query.municipality || '').trim(),
        status: String(req.query.status || '').trim(),
        priorityBand: String(req.query.priority || '').trim(),
        barrioSlug: String(req.query.barrio || '').trim(),
      })
      res.json({ ok: true, reports })
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/potholes/reports/:id', async (req, res) => {
    try {
      const appSession = await getRequestAppSession(req)
      res.setHeader('Cache-Control', 'no-store')
      const report = await getPotholeReportById(req.params.id, {
        viewerEmail: appSession?.user?.email || '',
      })
      if (!report) {
        return res.status(404).json({ ok: false, error: 'pothole-report-not-found' })
      }
      res.json({ ok: true, report })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.post('/api/potholes/reports', async (req, res) => {
    try {
      const session = await assertAppSession(req, res)
      if (!session) return

      const reportQuota = await getUserActionQuota(session.user, APP_ACTIONS.POTHOLE_REPORT_CREATE)
      if (reportQuota && !reportQuota.allowed) {
        return res.status(429).json({
          ok: false,
          error: 'action-limit-exceeded',
          message: `Llegaste al límite diario de ${reportQuota.dailyLimit} ${reportQuota.dailyLimit === 1 ? 'reporte de bache' : 'reportes de baches'}.`,
          usage: {
            [APP_ACTIONS.POTHOLE_REPORT_CREATE]: reportQuota,
          },
        })
      }

      const files = await runPotholeUpload(req, res)
      const report = await createPotholeReport({
        municipalityId: req.body?.municipalityId,
        municipalitySlug: req.body?.municipalitySlug || req.body?.municipality,
        lat: req.body?.lat,
        lon: req.body?.lon,
        potholeType: req.body?.potholeType,
        referenceText: req.body?.referenceText,
        description: req.body?.description,
        reportedSeverity: req.body?.reportedSeverity,
        reporterName: session.user.name,
        reporterEmail: session.user.email,
        files,
      })
      await consumeUserAction(session.user, APP_ACTIONS.POTHOLE_REPORT_CREATE)
      res.status(201).json({ ok: true, report })
    } catch (error) {
      if (error instanceof multer.MulterError) {
        return res.status(400).json({ ok: false, error: error.code })
      }
      const statusCode = {
        'pothole-location-invalid': 400,
        'pothole-description-required': 400,
        'pothole-reporter-required': 400,
        'pothole-image-limit-exceeded': 400,
        'pothole-image-type-invalid': 400,
        'action-limit-exceeded': 429,
        'pothole-severity-invalid': 400,
        'pothole-type-invalid': 400,
        'pothole-barrio-not-found': 400,
        'pothole-storage-not-configured': 503,
      }[error.code] || 500

      res.status(statusCode).json({
        ok: false,
        error: error.code || error.message,
        message: error.message,
        usage: error?.usage
          ? {
              [error.usage.actionKey]: error.usage,
            }
          : undefined,
      })
    }
  })

  app.post('/api/potholes/reports/:id/confirmations', async (req, res) => {
    try {
      const session = await assertAppSession(req, res)
      if (!session) return

      const confirmQuota = await getUserActionQuota(session.user, APP_ACTIONS.POTHOLE_CONFIRM_CREATE)
      if (confirmQuota && !confirmQuota.allowed) {
        return res.status(429).json({
          ok: false,
          error: 'action-limit-exceeded',
          message: `Llegaste al límite diario de ${confirmQuota.dailyLimit} ${confirmQuota.dailyLimit === 1 ? 'confirmación de bache' : 'confirmaciones de baches'}.`,
          usage: {
            [APP_ACTIONS.POTHOLE_CONFIRM_CREATE]: confirmQuota,
          },
        })
      }

      const report = await createPotholeConfirmation(req.params.id, {
        confirmerName: session.user.name,
        confirmerEmail: session.user.email,
        note: req.body?.note,
      })
      await consumeUserAction(session.user, APP_ACTIONS.POTHOLE_CONFIRM_CREATE)
      res.status(201).json({ ok: true, report })
    } catch (error) {
      const statusCode = {
        'pothole-report-not-found': 404,
        'pothole-confirmer-required': 400,
        'pothole-confirmation-duplicate': 409,
        'pothole-report-closed': 409,
        'action-limit-exceeded': 429,
      }[error.code] || 500

      res.status(statusCode).json({
        ok: false,
        error: error.code || error.message,
        message: error.message,
        usage: error?.usage
          ? {
              [error.usage.actionKey]: error.usage,
            }
          : undefined,
      })
    }
  })

  app.get('/api/admin/potholes/dashboard', async (req, res) => {
    const access = await assertCollectionAdminAccess(req, res, { roles: [ROLES.ADMIN] })
    if (!access) return

    try {
      res.setHeader('Cache-Control', 'no-store')
      res.json({
        ok: true,
        dashboard: await getPotholeDashboard({
          municipalityId: String(req.query.municipality_id || '').trim(),
          municipalitySlug: String(req.query.municipality_slug || req.query.municipality || '').trim(),
        }),
      })
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/admin/potholes/reports', async (req, res) => {
    const access = await assertCollectionAdminAccess(req, res, { roles: [ROLES.ADMIN] })
    if (!access) return

    try {
      res.setHeader('Cache-Control', 'no-store')
      const reports = await listPotholeReports({
        municipalityId: String(req.query.municipality_id || '').trim(),
        municipalitySlug: String(req.query.municipality_slug || req.query.municipality || '').trim(),
        status: String(req.query.status || '').trim(),
        priorityBand: String(req.query.priority || '').trim(),
        barrioSlug: String(req.query.barrio || '').trim(),
        limit: 250,
      })
      res.json({ ok: true, reports })
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message })
    }
  })

  app.patch('/api/admin/potholes/reports/:id', async (req, res) => {
    const access = await assertCollectionAdminAccess(req, res, { roles: [ROLES.ADMIN] })
    if (!access) return

    try {
      const report = await updatePotholeReportAdmin(req.params.id, {
        status: req.body?.status,
        priorityBand: req.body?.priorityBand,
        note: req.body?.note,
        changedBy: req.body?.changedBy || access.session?.createdBy || 'admin-panel',
      })
      if (!report) {
        return res.status(404).json({ ok: false, error: 'pothole-report-not-found' })
      }
      res.json({ ok: true, report })
    } catch (error) {
      const statusCode = {
        'pothole-status-invalid': 400,
        'pothole-priority-invalid': 400,
      }[error.code] || 500

      res.status(statusCode).json({ ok: false, error: error.code || error.message })
    }
  })

  app.get('/api/gtfs/txt/:name', async (req, res) => {
    const builder = GTFS_TXT_BUILDERS[req.params.name]
    if (!builder) {
      return res.status(404).json({
        ok: false,
        error: 'file-not-found',
        available: Object.keys(GTFS_TXT_BUILDERS),
      })
    }

    try {
      const csv = await builder()
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Content-Disposition', `inline; filename="${req.params.name}"`)
      res.send(csv)
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  app.get('/api/gtfs/download', async (_req, res) => {
    try {
      const buffer = await buildGtfsZipBuffer()
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', 'attachment; filename="gtfs.zip"')
      res.setHeader('Content-Length', buffer.length)
      res.send(buffer)
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message })
    }
  })

  if (existsSync(path.join(distPath, 'index.html'))) {
    app.use(express.static(distPath))
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'))
    })
  }

  return app
}

export async function getApp() {
  if (!appPromise) {
    appPromise = createApp().catch((error) => {
      appPromise = null
      throw error
    })
  }

  return appPromise
}
