const GOOGLE_TILE_SESSION_URL = 'https://tile.googleapis.com/v1/createSession'
const GOOGLE_TILE_URL = 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}'
const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'

const googleTileSessionCache = new Map()

function canAttachLayer(map) {
  return Boolean(map && map._container && map._panes?.tilePane)
}

export function getGoogleMapsApiKey() {
  return String(import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim()
}

export function getGoogleMapsTileStatus() {
  return {
    configured: Boolean(getGoogleMapsApiKey()),
    service: 'Google Map Tiles API',
  }
}

async function createGoogleTileSession(apiKey, options = {}) {
  const mapType = options.mapType || 'roadmap'
  const language = options.language || 'es-419'
  const region = options.region || 'PY'
  const cacheKey = `${mapType}:${language}:${region}`
  const cachedSession = googleTileSessionCache.get(cacheKey)
  const nowSeconds = Math.floor(Date.now() / 1000)

  if (cachedSession?.session && Number(cachedSession.expiry || 0) > nowSeconds + 60) {
    return cachedSession
  }

  const response = await fetch(`${GOOGLE_TILE_SESSION_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      mapType,
      language,
      region,
    }),
  })

  if (!response.ok) {
    throw new Error(`google-map-tiles-session-${response.status}`)
  }

  const session = await response.json()
  if (!session?.session) {
    throw new Error('google-map-tiles-session-empty')
  }

  googleTileSessionCache.set(cacheKey, session)
  return session
}

export function addOpenStreetMapFallbackLayer(L, map, options = {}) {
  const layer = L.tileLayer(OSM_TILE_URL, {
    attribution: options.attribution || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: options.maxZoom || 19,
  })

  if (canAttachLayer(map)) {
    layer.addTo(map)
  }

  return layer
}

export async function addGoogleMapTilesLayer(L, map, options = {}) {
  const fallbackLayer = addOpenStreetMapFallbackLayer(L, map, options)
  const apiKey = getGoogleMapsApiKey()
  if (!apiKey) {
    return {
      provider: 'osm',
      layer: fallbackLayer,
      reason: 'missing-google-maps-api-key',
    }
  }

  try {
    const session = await createGoogleTileSession(apiKey, options)
    const params = new URLSearchParams({
      session: session.session,
      key: apiKey,
    })

    const tileUrl = `${GOOGLE_TILE_URL}?${params.toString()}`
    const googleLayer = L.tileLayer(tileUrl, {
      attribution: options.attribution || 'Map data &copy; Google',
      maxZoom: options.maxZoom || 22,
      tileSize: session.tileWidth || 256,
    })

    if (!canAttachLayer(map)) {
      return {
        provider: 'osm',
        layer: fallbackLayer,
        reason: 'map-unavailable',
      }
    }

    let promotedGoogleLayer = false
    const keepFallback = () => {
      if (!canAttachLayer(map)) return
      if (!map.hasLayer(fallbackLayer)) {
        fallbackLayer.addTo(map)
      }
      if (map.hasLayer(googleLayer)) {
        googleLayer.remove()
      }
    }

    googleLayer.on('load', () => {
      if (!canAttachLayer(map) || promotedGoogleLayer) return
      promotedGoogleLayer = true
      fallbackLayer.remove()
    })

    googleLayer.on('tileerror', () => {
      promotedGoogleLayer = false
      keepFallback()
    })

    googleLayer.addTo(map)

    return {
      provider: 'google',
      layer: googleLayer,
      session,
    }
  } catch (error) {
    return {
      provider: 'osm',
      layer: fallbackLayer,
      reason: error?.message || 'google-map-tiles-unavailable',
    }
  }
}
