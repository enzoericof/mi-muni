const municipalities = [
  {
    key: 'asuncion',
    label: 'Asunci\u00f3n',
    enabled: true,
    geoReady: true,
    centerLat: -25.2867,
    centerLon: -57.61,
    bbox: { minLat: -25.38, maxLat: -25.19, minLon: -57.69, maxLon: -57.52 },
  },
  {
    key: 'lambare',
    label: 'Lambar\u00e9',
    enabled: false,
    geoReady: true,
    centerLat: -25.3464,
    centerLon: -57.6062,
    bbox: { minLat: -25.39, maxLat: -25.31, minLon: -57.64, maxLon: -57.56 },
  },
  {
    key: 'luque',
    label: 'Luque',
    enabled: false,
    geoReady: true,
    centerLat: -25.2686,
    centerLon: -57.4879,
    bbox: { minLat: -25.33, maxLat: -25.2, minLon: -57.56, maxLon: -57.42 },
  },
  {
    key: 'san-lorenzo',
    label: 'San Lorenzo',
    enabled: false,
    geoReady: true,
    centerLat: -25.3396,
    centerLon: -57.5088,
    bbox: { minLat: -25.39, maxLat: -25.29, minLon: -57.56, maxLon: -57.46 },
  },
]

export const defaultMunicipality = municipalities[0]

export function makeMunicipalityRecord(value = {}) {
  const key = String(value.key || '').trim().toLowerCase()
  if (!key) return defaultMunicipality

  return {
    key,
    label: String(value.label || key).trim() || key,
    enabled: value.enabled !== false,
    geoReady: value.geoReady === true,
    centerLat: value.centerLat === null || value.centerLat === undefined ? null : Number(value.centerLat),
    centerLon: value.centerLon === null || value.centerLon === undefined ? null : Number(value.centerLon),
    bbox: value.bbox && typeof value.bbox === 'object' ? value.bbox : {},
  }
}

export function findMunicipality(key, fallback = null) {
  const normalizedKey = String(key || '').trim().toLowerCase()
  if (!normalizedKey) return fallback ? makeMunicipalityRecord(fallback) : defaultMunicipality

  return municipalities.find((item) => item.key === normalizedKey) ?? (
    fallback
      ? makeMunicipalityRecord({ key: normalizedKey, ...fallback })
      : makeMunicipalityRecord({ key: normalizedKey, label: normalizedKey, enabled: false })
  )
}

export default municipalities
