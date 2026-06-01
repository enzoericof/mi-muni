const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname)
    ? 'http://127.0.0.1:8787'
    : '')

const API_ERROR_MESSAGES = {
  'auth-invalid-credentials': 'Email o contraseña inválida.',
  'auth-credentials-required': 'Email y contraseña son requeridos.',
  'auth-session-required': 'Iniciá sesión para continuar.',
  'auth-session-invalid': 'La sesión venció. Iniciá sesión nuevamente.',
  'auth-email-invalid': 'Ingresá un email válido.',
  'auth-name-required': 'Ingresá tu nombre.',
  'auth-password-too-short': 'La contraseña debe tener al menos 6 caracteres.',
  'auth-email-already-registered': 'Ese email ya está registrado. Iniciá sesión.',
  'auth-google-not-configured': 'Google Sign-In todavía no está configurado.',
  'auth-google-credential-required': 'No recibimos la credencial de Google.',
  'auth-google-invalid': 'No se pudo validar tu cuenta de Google.',
  'auth-google-difusor-only': 'Google Sign-In solo está habilitado para difusores.',
  'auth-google-account-conflict': 'Ese email ya está vinculado a otra cuenta de Google.',
  'auth-google-user-not-found': 'No encontramos una cuenta registrada con ese Google. Creá una cuenta primero.',
  'action-limit-exceeded': 'Llegaste al límite diario para esta acción.',
  'pothole-confirmation-duplicate': 'Ya confirmaste este bache.',
  'pothole-report-closed': 'Este bache ya no admite confirmaciones.',
  'pothole-location-invalid': 'No se pudo leer la ubicación seleccionada.',
  'pothole-description-required': 'La descripción es obligatoria.',
  'pothole-reporter-required': 'Iniciá sesión para reportar.',
  'pothole-image-limit-exceeded': 'Podés subir solo 1 foto por reporte.',
  'pothole-image-type-invalid': 'Solo se permiten fotos JPG, PNG, WEBP o HEIC.',
  LIMIT_FILE_COUNT: 'Podés subir solo 1 foto por reporte.',
  LIMIT_FILE_SIZE: 'Cada foto puede pesar hasta 8 MB.',
  'pothole-barrio-not-found': 'La ubicación elegida no pertenece a la ciudad seleccionada. Cambiá la ciudad o marcá un punto dentro de su mapa.',
  'pothole-storage-not-configured': 'La carga de fotos está deshabilitada temporalmente. Podés enviar el reporte sin imagen mientras terminamos la configuración.',
  'collection-admin-unauthorized': 'Credenciales inválidas.',
  'collection-admin-auth-not-configured': 'El acceso administrador de recolección todavía no está configurado.',
  'collection-admin-auth-insecure-config': 'El acceso administrador de recolección está deshabilitado hasta configurar credenciales más seguras.',
  'collection-admin-rate-limit-exceeded': 'Demasiados intentos fallidos. Esperá unos minutos antes de volver a probar.',
  'rag-seed-url-invalid': 'La URL semilla no es válida.',
  'rag-seed-url-required': 'Seleccioná al menos una URL semilla.',
  'rag-seed-url-job-active': 'Esa seed está siendo usada por un job en cola o en ejecución.',
  'rag-municipality-required-fields': 'Completa nombre y slug de la municipalidad.',
  'rag-crawl-job-active': 'Ese job sigue en cola o ejecutándose. Cancelalo antes de borrarlo.',
  'rag-publication-visible-required': 'Indica si el ítem será visible u oculto.',
  'rag-spider-operations-boolean-required': 'Indica si el spider debe quedar prendido o apagado.',
  'rag-runtime-update-required': 'No hay cambios para guardar en la configuración del asistente.',
  'rag-assistant-use-embeddings-boolean-required': 'Indica si Munita debe usar embeddings o solo búsqueda léxica.',
  'rag-assistant-chunk-limit-invalid': 'El límite de chunks debe estar entre 1 y el total de chunks disponible en backend.',
  'rag-assistant-chunk-limit-max-unavailable': 'Todavía no hay un conteo de chunks disponible en backend para guardar ese límite.',
  'rag-assistant-min-relevance-score-invalid': 'El umbral de relevancia debe estar entre 0 y 50.',
  'rag-assistant-strict-municipality-scope-boolean-required': 'Indica si el alcance municipal debe ser estricto o permitir fallback.',
  'municipality-not-found': 'No encontramos esa municipalidad en la base.',
  'municipality-ine-code-missing': 'Esa municipalidad no tiene código INE configurado.',
  'municipal-barrios-source-unavailable': 'No se pudo descargar la cartografía oficial del INE en este momento.',
  'municipal-barrios-source-empty': 'La fuente oficial no devolvió barrios para esa municipalidad.',
  'municipal-barrios-import-file-required': 'Subí un archivo `.geojson`, `.json` o `.csv` para importar barrios.',
  'municipal-barrios-import-format-invalid': 'Ese archivo no tiene un formato compatible para importar barrios.',
  'municipal-barrios-import-empty': 'No encontramos barrios válidos en el archivo seleccionado.',
  'spider-operation-disabled': 'Prendé el spider desde el panel de desarrollador antes de ejecutar.',
  'openai-disabled': 'OpenAI está deshabilitado; no se pueden regenerar embeddings.',
}

Object.assign(API_ERROR_MESSAGES, {
  'municipal-barrio-required-fields': 'CompletÃ¡ nombre, latitud y longitud del barrio.',
  'municipal-barrio-not-found': 'No encontramos ese barrio en la base.',
  'municipal-barrio-municipality-mismatch': 'Ese barrio no pertenece a la municipalidad seleccionada.',
})

export function getApiErrorMessage(codeOrMessage, fallback = '') {
  const normalized = String(codeOrMessage || '').trim()
  if (!normalized) return fallback
  return API_ERROR_MESSAGES[normalized] || normalized || fallback
}

const ADMIN_SESSION_FETCH_OPTIONS = {
  credentials: 'include',
}

const APP_SESSION_FETCH_OPTIONS = {
  credentials: 'include',
}

function buildAppAuthHeaders({ sessionId = '' } = {}) {
  const headers = {}
  const normalizedSessionId = String(sessionId || '').trim()

  if (normalizedSessionId) {
    headers['x-app-session'] = normalizedSessionId
  }

  return headers
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isNetworkError(error) {
  return error instanceof TypeError && /failed to fetch|network/i.test(error.message || '')
}

function buildAdminSessionHeaders(sessionToken) {
  const normalized = String(sessionToken || '').trim()
  if (!normalized) return {}

  if (normalized.startsWith('app:')) {
    return {
      'x-app-session': normalized.slice(4),
    }
  }

  return {
    'x-admin-session': normalized,
  }
}

async function readJson(response) {
  if (!response.ok) {
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const payload = await response.json()
      const code = payload?.error || ''
      const message =
        getApiErrorMessage(payload?.message, '') ||
        getApiErrorMessage(code, '') ||
        `Request failed with ${response.status}`
      const error = new Error(message)
      error.code = code || null
      error.status = response.status
      error.payload = payload
      throw error
    }

    const errorText = await response.text()
    const error = new Error(errorText || `Request failed with ${response.status}`)
    error.status = response.status
    throw error
  }

  return response.json()
}

export async function fetchProcedureById(id) {
  const response = await fetch(`${API_BASE_URL}/api/rag/procedure/${id}`)
  const payload = await readJson(response)
  return payload.result
}

export async function fetchProcedureSection(id, section) {
  const response = await fetch(`${API_BASE_URL}/api/rag/procedure/${id}/section/${section}`)
  const payload = await readJson(response)
  return payload.result
}

export async function fetchActiveMunicipalities() {
  const response = await fetch(`${API_BASE_URL}/api/rag/active-municipalities`)
  return readJson(response)
}

export async function searchMunicipalInfo({
  query = '',
  categoria = 'all',
  tipo = 'all',
  seccion = 'all',
  onlyOfficialSource = false,
  limit = 6,
  municipalityId = '',
  municipalitySlug = '',
} = {}) {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  params.set('categoria', categoria)
  params.set('tipo', tipo)
  params.set('seccion', seccion)
  params.set('onlyOfficialSource', String(onlyOfficialSource))
  params.set('limit', String(limit))
  if (municipalityId) params.set('municipality_id', String(municipalityId))
  if (municipalitySlug) params.set('municipality_slug', String(municipalitySlug))

  const response = await fetch(`${API_BASE_URL}/api/rag/search?${params.toString()}`)
  return readJson(response)
}

export async function askMunicipalAssistant(query, { municipalityId = '', municipalitySlug = '', municipalityName = '' } = {}) {
  const response = await fetch(`${API_BASE_URL}/api/rag/ask`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query,
      municipalityId,
      municipalitySlug,
      municipalityName,
    }),
  })

  const payload = await readJson(response)
  return {
    answer: payload.answer,
    usage: payload.usage || {},
  }
}

export async function createAppSession({ email, password }) {
  const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })
  const payload = await readJson(response)
  return payload.session
}

export async function registerDifusorSession({ email, password, name, phone = '', address = '' }) {
  const response = await fetch(`${API_BASE_URL}/api/auth/register-difusor`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password, name, phone, address }),
  })
  const payload = await readJson(response)
  return payload.session
}

export async function createGoogleAppSession({ credential, mode = 'login' }) {
  const request = () => fetch(`${API_BASE_URL}/api/auth/google`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ credential, mode }),
  })

  try {
    const response = await request()
    const payload = await readJson(response)
    return payload.session
  } catch (error) {
    if (!isNetworkError(error)) throw error
    await wait(650)
    try {
      const response = await request()
      const payload = await readJson(response)
      return payload.session
    } catch (retryError) {
      if (!isNetworkError(retryError)) throw retryError
      throw new Error('No pudimos conectar con el servidor. Probá de nuevo en unos segundos.')
    }
  }
}

export async function fetchAppSession(sessionId = '') {
  const headers = buildAppAuthHeaders({ sessionId })
  const response = await fetch(`${API_BASE_URL}/api/auth/session`, {
    ...APP_SESSION_FETCH_OPTIONS,
    ...(Object.keys(headers).length ? { headers } : {}),
  })
  const payload = await readJson(response)
  return payload.session || null
}

export async function deleteAppSession(sessionId = '') {
  const headers = buildAppAuthHeaders({ sessionId })
  const response = await fetch(`${API_BASE_URL}/api/auth/session`, {
    method: 'DELETE',
    ...APP_SESSION_FETCH_OPTIONS,
    ...(Object.keys(headers).length ? { headers } : {}),
  })
  const payload = await readJson(response)
  return payload.revoked
}

export async function fetchDifusorProfile() {
  const response = await fetch(`${API_BASE_URL}/api/profile/difusor`, {
    credentials: 'include',
  })
  const payload = await readJson(response)
  return payload.profile
}

export async function fetchRecolectorProfile() {
  const response = await fetch(`${API_BASE_URL}/api/profile/recolector`, {
    credentials: 'include',
  })
  const payload = await readJson(response)
  return payload.profile
}

export async function startRecolectorShift(payload) {
  const response = await fetch(`${API_BASE_URL}/api/recolector/shifts`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const result = await readJson(response)
  return result.shift
}

export async function sendRecolectorPosition({ shiftId, lat, lon, barrioSlug, barrioLabel, routeId, routeLabel }) {
  const response = await fetch(`${API_BASE_URL}/api/recolector/shifts/${encodeURIComponent(shiftId)}/positions`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ lat, lon, barrioSlug, barrioLabel, routeId, routeLabel }),
  })
  const result = await readJson(response)
  return result.shift
}

export async function stopRecolectorShift(shiftId) {
  const response = await fetch(`${API_BASE_URL}/api/recolector/shifts/${encodeURIComponent(shiftId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  const result = await readJson(response)
  return result.shift
}

export function stopRecolectorShiftOnExit(shiftId) {
  if (!shiftId) return
  void fetch(`${API_BASE_URL}/api/recolector/shifts/${encodeURIComponent(shiftId)}`, {
    method: 'DELETE',
    credentials: 'include',
    keepalive: true,
  }).catch(() => {})
}

export async function broadcastRecolectorNotifications({ zoneIds = [], message = '', channel = 'app', shiftId = null } = {}) {
  const response = await fetch(`${API_BASE_URL}/api/recolector/notifications`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ zoneIds, message, channel, shiftId }),
  })
  const result = await readJson(response)
  return result.result
}

export async function fetchGtfsRoutes() {
  const response = await fetch(`${API_BASE_URL}/api/gtfs/routes`)
  const payload = await readJson(response)
  return payload.routes
}

export async function fetchGtfsStops() {
  const response = await fetch(`${API_BASE_URL}/api/gtfs/stops`)
  const payload = await readJson(response)
  return payload.stops
}

export async function fetchGtfsVehicles() {
  const response = await fetch(`${API_BASE_URL}/api/gtfs/vehicles`)
  const payload = await readJson(response)
  return payload
}

export async function fetchGtfsStopTimes(tripId) {
  const response = await fetch(`${API_BASE_URL}/api/gtfs/stop_times?trip_id=${encodeURIComponent(tripId)}`)
  const payload = await readJson(response)
  return payload.stop_times
}

export async function fetchGtfsShapes(shapeId) {
  const response = await fetch(`${API_BASE_URL}/api/gtfs/shapes?shape_id=${encodeURIComponent(shapeId)}`)
  const payload = await readJson(response)
  return payload.shapes
}

export async function fetchCollectionZones({ municipalityId = '', municipalitySlug = '', includeGeometry = true } = {}) {
  const params = new URLSearchParams()
  if (municipalityId) params.set('municipality_id', String(municipalityId))
  if (municipalitySlug) params.set('municipality_slug', String(municipalitySlug))
  if (!includeGeometry) params.set('include_geometry', 'false')
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(`${API_BASE_URL}/api/collection/zones${suffix}`, { cache: 'no-store' })
  const payload = await readJson(response)
  return {
    municipality: payload.municipality || null,
    collectionReady: payload.collectionReady === true,
    zones: payload.zones || [],
    features: payload.features || [],
  }
}

export async function fetchCollectionMap({ includeRouteShapes = true, municipalityId = '', municipalitySlug = '' } = {}) {
  const params = new URLSearchParams()
  if (!includeRouteShapes) params.set('include_shapes', 'false')
  if (municipalityId) params.set('municipality_id', String(municipalityId))
  if (municipalitySlug) params.set('municipality_slug', String(municipalitySlug))
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(`${API_BASE_URL}/api/collection/map${suffix}`, { cache: 'no-store' })
  const payload = await readJson(response)
  return payload.map
}

export async function fetchCollectionOverview(zoneId, { municipalityId = '', municipalitySlug = '' } = {}) {
  const params = new URLSearchParams()
  params.set('zone_id', String(zoneId))
  if (municipalityId) params.set('municipality_id', String(municipalityId))
  if (municipalitySlug) params.set('municipality_slug', String(municipalitySlug))
  const response = await fetch(`${API_BASE_URL}/api/collection/overview?${params.toString()}`)
  const payload = await readJson(response)
  return payload.overview
}

export async function createCollectionReport({ zoneId, routeId, addressLabel, notes }) {
  const response = await fetch(`${API_BASE_URL}/api/collection/reports`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ zoneId, routeId, addressLabel, notes }),
  })

  const payload = await readJson(response)
  return payload.report
}

export async function createCollectionValidation({ zoneId, routeId, validationStatus, notes }) {
  const response = await fetch(`${API_BASE_URL}/api/collection/validations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ zoneId, routeId, validationStatus, notes }),
  })

  const payload = await readJson(response)
  return payload.validation
}

export async function createCollectionNotification({
  zoneId,
  eventType,
  channel,
  leadMinutes,
  preferredDays,
  timeWindowStart,
  timeWindowEnd,
}) {
  const response = await fetch(`${API_BASE_URL}/api/collection/notifications`, {
    method: 'POST',
    ...APP_SESSION_FETCH_OPTIONS,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      zoneId,
      eventType,
      channel,
      leadMinutes,
      preferredDays,
      timeWindowStart,
      timeWindowEnd,
    }),
  })

  const payload = await readJson(response)
  return payload.notification
}

export async function fetchCollectionNotifications(zoneId = '') {
  const suffix = zoneId ? `?zone_id=${encodeURIComponent(zoneId)}` : ''
  const response = await fetch(`${API_BASE_URL}/api/collection/notifications${suffix}`, {
    ...APP_SESSION_FETCH_OPTIONS,
  })
  const payload = await readJson(response)
  return payload.notifications
}

export async function fetchCollectionNotificationEvents({ sinceId = 0, channel = 'panel', limit = 10 } = {}) {
  const params = new URLSearchParams()
  params.set('since_id', String(sinceId || 0))
  params.set('channel', String(channel || 'panel'))
  params.set('limit', String(limit || 10))
  const response = await fetch(`${API_BASE_URL}/api/collection/notification-events?${params.toString()}`, {
    ...APP_SESSION_FETCH_OPTIONS,
    cache: 'no-store',
  })
  const payload = await readJson(response)
  return payload.events || []
}

export async function deleteCollectionNotification(notificationId) {
  const response = await fetch(`${API_BASE_URL}/api/collection/notifications/${notificationId}`, {
    method: 'DELETE',
    ...APP_SESSION_FETCH_OPTIONS,
  })
  const payload = await readJson(response)
  return payload.deleted
}

export async function createCollectionAdminSession({ username, password, createdBy = 'admin-panel-login' }) {
  const response = await fetch(`${API_BASE_URL}/api/admin/collection/session/login`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ username, password, createdBy }),
  })
  const payload = await readJson(response)
  return payload.session
}

export async function fetchCollectionAdminSession(adminSession) {
  const response = await fetch(`${API_BASE_URL}/api/admin/collection/session`, {
    ...ADMIN_SESSION_FETCH_OPTIONS,
    ...(adminSession && adminSession !== 'app'
      ? {
          headers: {
            'x-admin-session': adminSession,
          },
        }
      : {}),
  })
  const payload = await readJson(response)
  return payload.session
}

export async function deleteCollectionAdminSession(adminSession) {
  const response = await fetch(`${API_BASE_URL}/api/admin/collection/session`, {
    method: 'DELETE',
    ...ADMIN_SESSION_FETCH_OPTIONS,
    ...(adminSession
      ? {
          headers: {
            'x-admin-session': adminSession,
          },
        }
      : {}),
  })
  const payload = await readJson(response)
  return payload.revoked
}

export async function fetchCollectionRuntimeSession(adminSession) {
  const response = await fetch(`${API_BASE_URL}/api/admin/collection/runtime`, {
    ...ADMIN_SESSION_FETCH_OPTIONS,
    headers: buildAdminSessionHeaders(adminSession),
  })
  const payload = await readJson(response)
  return payload.runtime
}

export async function updateCollectionRuntimeSession({ adminSession, simulationEnabled, updatedBy = 'admin-panel' }) {
  const response = await fetch(`${API_BASE_URL}/api/admin/collection/runtime`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...buildAdminSessionHeaders(adminSession),
    },
    body: JSON.stringify({ simulationEnabled, updatedBy }),
  })
  const payload = await readJson(response)
  return payload.runtime
}

export async function fetchRagAdminRuntime(adminSession) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/runtime`, {
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  const payload = await readJson(response)
  return payload.runtime
}

export async function updateRagAdminRuntime({
  adminSession,
  publicIndexEnabled,
  spiderOperationsEnabled,
  assistantUseEmbeddings,
  assistantChunkLimit,
  assistantMinRelevanceScore,
  assistantStrictMunicipalityScope,
}) {
  const body = {}
  if (publicIndexEnabled !== undefined) body.publicIndexEnabled = publicIndexEnabled
  if (spiderOperationsEnabled !== undefined) body.spiderOperationsEnabled = spiderOperationsEnabled
  if (assistantUseEmbeddings !== undefined) body.assistantUseEmbeddings = assistantUseEmbeddings
  if (assistantChunkLimit !== undefined) body.assistantChunkLimit = assistantChunkLimit
  if (assistantMinRelevanceScore !== undefined) body.assistantMinRelevanceScore = assistantMinRelevanceScore
  if (assistantStrictMunicipalityScope !== undefined) body.assistantStrictMunicipalityScope = assistantStrictMunicipalityScope
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/runtime`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...buildAdminSessionHeaders(adminSession),
    },
    body: JSON.stringify(body),
  })
  const payload = await readJson(response)
  return payload.runtime
}

export async function fetchRagMunicipalities(adminSession) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/municipalities`, {
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  const payload = await readJson(response)
  return payload.municipalities
}

export async function createRagMunicipality(adminSession, payload) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/municipalities`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...buildAdminSessionHeaders(adminSession),
    },
    body: JSON.stringify(payload),
  })
  const result = await readJson(response)
  return result.municipality
}

export async function updateRagMunicipality(adminSession, id, payload) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/municipalities/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...buildAdminSessionHeaders(adminSession),
    },
    body: JSON.stringify(payload),
  })
  const result = await readJson(response)
  return result.municipality
}

export async function bootstrapRagMunicipalityGeography(adminSession, id) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/municipalities/${encodeURIComponent(id)}/bootstrap-geography`, {
    method: 'POST',
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  const result = await readJson(response)
  return result.result
}

export async function importRagMunicipalityBarrios(adminSession, id, { file, sourceName = '', sourceUrl = '' } = {}) {
  const formData = new FormData()
  if (file) formData.set('file', file)
  if (sourceName) formData.set('sourceName', sourceName)
  if (sourceUrl) formData.set('sourceUrl', sourceUrl)

  const response = await fetch(`${API_BASE_URL}/api/admin/rag/municipalities/${encodeURIComponent(id)}/import-barrios`, {
    method: 'POST',
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
    body: formData,
  })
  const result = await readJson(response)
  return result.result
}

export async function fetchMunicipalBarrios(adminSession, municipalityId) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/admin/rag/municipalities/${encodeURIComponent(municipalityId)}/barrios`, {
      credentials: 'include',
      headers: buildAdminSessionHeaders(adminSession),
    })
    const payload = await readJson(response)
    return payload.barrios
  } catch (error) {
    if (Number(error?.status || 0) !== 404) throw error

    const map = await fetchPotholesMap({ municipalityId })
    return (map?.barrios || []).map((barrio, index) => ({
      id: `fallback-${municipalityId}-${index + 1}`,
      municipalityId: Number(municipalityId),
      barrioSlug: barrio.id || `barrio-${index + 1}`,
      barrioLabel: barrio.label || barrio.id || `Barrio ${index + 1}`,
      barrioCode: '',
      centerLat: Number(barrio.centerLat || 0),
      centerLon: Number(barrio.centerLon || 0),
      bbox: {},
      geometry: {},
      metadata: {
        fallback: true,
      },
      sourceName: 'Mapa de Baches (fallback)',
      sourceUrl: '/api/potholes/map',
      importedAt: null,
      createdAt: null,
      updatedAt: null,
      hasGeometry: false,
    }))
  }
}

export async function createMunicipalBarrio(adminSession, municipalityId, payload) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/municipalities/${encodeURIComponent(municipalityId)}/barrios`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...buildAdminSessionHeaders(adminSession),
    },
    body: JSON.stringify(payload),
  })
  const result = await readJson(response)
  return result.barrio
}

export async function updateMunicipalBarrio(adminSession, municipalityId, barrioId, payload) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/municipalities/${encodeURIComponent(municipalityId)}/barrios/${encodeURIComponent(barrioId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...buildAdminSessionHeaders(adminSession),
    },
    body: JSON.stringify(payload),
  })
  const result = await readJson(response)
  return result.barrio
}

export async function fetchRagSeedUrls(adminSession, { municipalityId = '' } = {}) {
  const params = new URLSearchParams()
  if (municipalityId) params.set('municipality_id', municipalityId)
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/seed-urls${suffix}`, {
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  const payload = await readJson(response)
  return payload.seedUrls
}

export async function fetchRagSourceHealth(adminSession, { municipalityId = '' } = {}) {
  const params = new URLSearchParams()
  if (municipalityId) params.set('municipality_id', municipalityId)
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/source-health${suffix}`, {
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  const payload = await readJson(response)
  return payload.sources
}

export async function createRagSeedUrl(adminSession, payload) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/seed-urls`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...buildAdminSessionHeaders(adminSession),
    },
    body: JSON.stringify(payload),
  })
  const result = await readJson(response)
  return result.seedUrl
}

export async function checkRagSeedUrl(adminSession, seedId) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/seed-urls/${encodeURIComponent(seedId)}/check`, {
    method: 'POST',
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  const result = await readJson(response)
  return result.seedUrl
}

export async function deleteRagSeedUrl(adminSession, seedId) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/seed-urls/${encodeURIComponent(seedId)}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  const result = await readJson(response)
  return result.seedUrl
}

export async function fetchRagCrawlJobs(adminSession, { municipalityId = '', limit = 20 } = {}) {
  const params = new URLSearchParams()
  if (municipalityId) params.set('municipality_id', municipalityId)
  params.set('limit', String(limit))
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/crawl-jobs?${params.toString()}`, {
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  const payload = await readJson(response)
  return payload.jobs
}

export async function fetchRagCrawlJobResults(adminSession, jobId, { type = 'pages', page = 1, pageSize = 8 } = {}) {
  const params = new URLSearchParams()
  params.set('type', type)
  params.set('page', String(page))
  params.set('page_size', String(pageSize))
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/crawl-jobs/${encodeURIComponent(jobId)}/results?${params.toString()}`, {
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  const payload = await readJson(response)
  return payload.results
}

export async function createRagCrawlJob(adminSession, payload) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/crawl-jobs`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...buildAdminSessionHeaders(adminSession),
    },
    body: JSON.stringify(payload),
  })
  const result = await readJson(response)
  return result.job
}

export async function cancelRagCrawlJob(adminSession, jobId) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/crawl-jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  const result = await readJson(response)
  return result.job
}

export async function deleteRagCrawlJob(adminSession, jobId) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/crawl-jobs/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  const result = await readJson(response)
  return result.job
}

export async function reloadRagAdminIndex(adminSession) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/index/rebuild`, {
    method: 'POST',
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  return readJson(response)
}

export async function rebuildRagEmbeddings(adminSession, { onlyMissing = false } = {}) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/embeddings/rebuild`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...buildAdminSessionHeaders(adminSession),
    },
    body: JSON.stringify({ onlyMissing }),
  })
  return readJson(response)
}

export async function fetchRagEmbeddingDetails(
  adminSession,
  { municipalityId = '', query = '', state = 'all', page = 1, pageSize = 20 } = {},
) {
  const params = new URLSearchParams()
  if (municipalityId) params.set('municipality_id', String(municipalityId))
  if (query) params.set('q', query)
  if (state) params.set('state', state)
  params.set('page', String(page))
  params.set('page_size', String(pageSize))
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/embeddings?${params.toString()}`, {
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  const payload = await readJson(response)
  return payload.details
}

export async function clearRagEmbeddings(
  adminSession,
  { municipalityId = '', connectedOnly = true } = {},
) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/embeddings`, {
    method: 'DELETE',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...buildAdminSessionHeaders(adminSession),
    },
    body: JSON.stringify({ municipalityId, connectedOnly }),
  })
  return readJson(response)
}

export async function fetchRagAdminCatalog(adminSession, { municipalityId = '', sourceType = '', visibility = '', query = '', limit = 50 } = {}) {
  const params = new URLSearchParams()
  if (municipalityId) params.set('municipality_id', municipalityId)
  if (sourceType) params.set('source_type', sourceType)
  if (visibility) params.set('visibility', visibility)
  if (query) params.set('q', query)
  params.set('limit', String(limit))
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/catalog?${params.toString()}`, {
    credentials: 'include',
    headers: buildAdminSessionHeaders(adminSession),
  })
  const payload = await readJson(response)
  return payload.catalog
}

export async function updateRagInfoPublication({ adminSession, itemId, visible, notes = '' }) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/info-publication/${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...buildAdminSessionHeaders(adminSession),
    },
    body: JSON.stringify({ visible, notes }),
  })
  const payload = await readJson(response)
  return payload.item
}

export async function bulkUpdateRagInfoPublication({
  adminSession,
  municipalityId,
  visible,
  sourceType = '',
  notes = '',
}) {
  const response = await fetch(`${API_BASE_URL}/api/admin/rag/info-publication/bulk`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...buildAdminSessionHeaders(adminSession),
    },
    body: JSON.stringify({ municipalityId, visible, sourceType, notes }),
  })
  const payload = await readJson(response)
  return payload.result
}

export async function fetchPotholesMap({ municipalityId = '', municipalitySlug = '' } = {}) {
  const params = new URLSearchParams()
  if (municipalityId) params.set('municipality_id', String(municipalityId))
  if (municipalitySlug) params.set('municipality_slug', String(municipalitySlug))
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(`${API_BASE_URL}/api/potholes/map${suffix}`, {
    cache: 'no-store',
    ...APP_SESSION_FETCH_OPTIONS,
  })
  const payload = await readJson(response)
  return payload.map
}

export async function fetchPotholeReports({ status = '', priorityBand = '', barrioSlug = '', municipalityId = '', municipalitySlug = '' } = {}) {
  const params = new URLSearchParams()
  if (municipalityId) params.set('municipality_id', String(municipalityId))
  if (municipalitySlug) params.set('municipality_slug', String(municipalitySlug))
  if (status) params.set('status', status)
  if (priorityBand) params.set('priority', priorityBand)
  if (barrioSlug) params.set('barrio', barrioSlug)

  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(`${API_BASE_URL}/api/potholes/reports${suffix}`)
  const payload = await readJson(response)
  return payload.reports
}

export async function fetchPotholeReportById(reportId) {
  const response = await fetch(`${API_BASE_URL}/api/potholes/reports/${encodeURIComponent(reportId)}`, {
    ...APP_SESSION_FETCH_OPTIONS,
  })
  const payload = await readJson(response)
  return payload.report
}

export async function createPotholeReport({
  municipalityId = '',
  municipalitySlug = '',
  lat,
  lon,
  potholeType,
  referenceText,
  description,
  reportedSeverity,
  files = [],
}) {
  const formData = new FormData()
  if (municipalityId) formData.set('municipalityId', String(municipalityId))
  if (municipalitySlug) formData.set('municipalitySlug', String(municipalitySlug))
  formData.set('lat', String(lat))
  formData.set('lon', String(lon))
  formData.set('potholeType', potholeType || '')
  formData.set('referenceText', referenceText || '')
  formData.set('description', description || '')
  formData.set('reportedSeverity', reportedSeverity || '')

  for (const file of files) {
    formData.append('images', file)
  }

  const response = await fetch(`${API_BASE_URL}/api/potholes/reports`, {
    method: 'POST',
    ...APP_SESSION_FETCH_OPTIONS,
    body: formData,
  })

  const payload = await readJson(response)
  return payload.report
}

export async function createPotholeConfirmation({
  reportId,
  note = '',
}) {
  const response = await fetch(`${API_BASE_URL}/api/potholes/reports/${encodeURIComponent(reportId)}/confirmations`, {
    method: 'POST',
    ...APP_SESSION_FETCH_OPTIONS,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      note,
    }),
  })

  const payload = await readJson(response)
  return payload.report
}

export async function fetchPotholeAdminDashboard(adminSession, { municipalityId = '', municipalitySlug = '' } = {}) {
  const params = new URLSearchParams()
  if (municipalityId) params.set('municipality_id', String(municipalityId))
  if (municipalitySlug) params.set('municipality_slug', String(municipalitySlug))
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(`${API_BASE_URL}/api/admin/potholes/dashboard${suffix}`, {
    ...ADMIN_SESSION_FETCH_OPTIONS,
    headers: buildAdminSessionHeaders(adminSession),
  })
  const payload = await readJson(response)
  return payload.dashboard
}

export async function fetchPotholeAdminReports(
  adminSession,
  { status = '', priorityBand = '', barrioSlug = '', municipalityId = '', municipalitySlug = '' } = {},
) {
  const params = new URLSearchParams()
  if (municipalityId) params.set('municipality_id', String(municipalityId))
  if (municipalitySlug) params.set('municipality_slug', String(municipalitySlug))
  if (status) params.set('status', status)
  if (priorityBand) params.set('priority', priorityBand)
  if (barrioSlug) params.set('barrio', barrioSlug)

  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(`${API_BASE_URL}/api/admin/potholes/reports${suffix}`, {
    ...ADMIN_SESSION_FETCH_OPTIONS,
    headers: buildAdminSessionHeaders(adminSession),
  })
  const payload = await readJson(response)
  return payload.reports
}

export async function updatePotholeAdminReport({
  adminSession,
  reportId,
  status,
  priorityBand,
  note = '',
  changedBy = 'admin-panel',
}) {
  const response = await fetch(`${API_BASE_URL}/api/admin/potholes/reports/${encodeURIComponent(reportId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...buildAdminSessionHeaders(adminSession),
    },
    body: JSON.stringify({
      status,
      priorityBand,
      note,
      changedBy,
    }),
  })
  const payload = await readJson(response)
  return payload.report
}

export { API_BASE_URL }
