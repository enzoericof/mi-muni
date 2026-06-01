const DEFAULT_TIMEOUT_MS = 8_000

export function getUserLocation({ timeoutMs = DEFAULT_TIMEOUT_MS, enableHighAccuracy = false, maximumAge = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('Geolocation API no disponible'))
      return
    }

    const timer = window.setTimeout(() => {
      reject(new Error('Tiempo de espera agotado para obtener la ubicación'))
    }, timeoutMs + 500)

    navigator.geolocation.getCurrentPosition(
      (position) => {
        window.clearTimeout(timer)
        resolve({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy,
        })
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
      { enableHighAccuracy, timeout: timeoutMs, maximumAge },
    )
  })
}
