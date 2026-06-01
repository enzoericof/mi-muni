import JSZip from 'jszip'
import { getPool, query } from '../db/index.js'
import { geometryBounds, geometryCenter, slugify } from './collectionCore.js'
import { compactWhitespace, normalizeText, repairMojibake } from './text.js'

export const MUNICIPAL_GEOGRAPHY_SOURCES = {
  asuncionLocal: {
    name: 'Mi Muni - barrios de Asuncion',
    url: 'local://server/data/barrios-asu.geojson',
  },
  ineCartography2012: {
    name: 'INE - Cartografia Digital 2012',
    pageUrl: 'https://www.ine.gov.py/microdatos/cartografia-digital-2012.php',
  },
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value

  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function rowToMunicipality(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    slug: row.slug,
    name: repairMojibake(row.name || ''),
    department: repairMojibake(row.department || ''),
    ineCode: String(row.ine_code || '').trim(),
    centerLat: Number(row.center_lat || 0) || null,
    centerLon: Number(row.center_lon || 0) || null,
    bbox: parseJson(row.bbox, {}),
    geometry: parseJson(row.geometry, {}),
    geoSourceName: row.geo_source_name || '',
    geoSourceUrl: row.geo_source_url || '',
  }
}

function rowToMunicipalBarrio(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    municipalityId: Number(row.municipality_id),
    barrioSlug: row.barrio_slug,
    barrioLabel: repairMojibake(row.barrio_label || ''),
    barrioCode: row.barrio_code || '',
    centerLat: Number(row.center_lat || 0),
    centerLon: Number(row.center_lon || 0),
    bbox: parseJson(row.bbox, {}),
    geometry: parseJson(row.geometry, {}),
    metadata: parseJson(row.metadata, {}),
    sourceName: row.source_name || '',
    sourceUrl: row.source_url || '',
    importedAt: row.imported_at ? new Date(row.imported_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    hasGeometry: Boolean(parseJson(row.geometry, {})?.type),
  }
}

function normalizeDepartmentSegment(value) {
  return repairMojibake(String(value || ''))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
}

function buildIneDepartmentZipUrl(municipality) {
  const ineCode = String(municipality?.ineCode || '').replace(/\D/g, '')
  const departmentCode = municipality?.slug === 'asuncion' ? '00' : ineCode.slice(0, 2)
  if (!departmentCode || !municipality?.department) {
    const error = new Error('municipality-ine-code-missing')
    error.code = 'municipality-ine-code-missing'
    throw error
  }

  const departmentSegment = normalizeDepartmentSegment(municipality.department)
  return `https://www.ine.gov.py/microdatos/register/CARTOGRAFIA%20DIGITAL%202012%20ZIP/GEOJSON/${encodeURIComponent(`${departmentCode} ${departmentSegment}.ZIP`)}`
}

function buildDistrictCode(municipality) {
  const digits = String(municipality?.ineCode || '').replace(/\D/g, '')
  if (municipality?.slug === 'asuncion') return '00'
  return digits.slice(-2).padStart(2, '0')
}

function combineBounds(boundsList = []) {
  const validBounds = boundsList.filter(Boolean)
  if (!validBounds.length) return null

  return {
    minLat: Math.min(...validBounds.map((bounds) => Number(bounds.minLat))),
    maxLat: Math.max(...validBounds.map((bounds) => Number(bounds.maxLat))),
    minLon: Math.min(...validBounds.map((bounds) => Number(bounds.minLon))),
    maxLon: Math.max(...validBounds.map((bounds) => Number(bounds.maxLon))),
  }
}

function computeCenterFromBounds(bounds) {
  if (!bounds) return null
  return {
    lat: Number(((Number(bounds.minLat) + Number(bounds.maxLat)) / 2).toFixed(6)),
    lon: Number(((Number(bounds.minLon) + Number(bounds.maxLon)) / 2).toFixed(6)),
  }
}

function buildBoundsFromCenter(center) {
  if (!center || !Number.isFinite(Number(center.lat)) || !Number.isFinite(Number(center.lon))) return null
  return {
    minLat: Number(center.lat),
    maxLat: Number(center.lat),
    minLon: Number(center.lon),
    maxLon: Number(center.lon),
  }
}

function buildUniqueBarrioSlug(label, code, usedSlugs) {
  const baseSlug = slugify(label) || `barrio-${String(code || '').trim() || 'sin-codigo'}`
  if (!usedSlugs.has(baseSlug)) {
    usedSlugs.add(baseSlug)
    return baseSlug
  }

  const codeSlug = slugify(code) || 'dup'
  const candidate = `${baseSlug}-${codeSlug}`
  if (!usedSlugs.has(candidate)) {
    usedSlugs.add(candidate)
    return candidate
  }

  let index = 2
  while (usedSlugs.has(`${candidate}-${index}`)) {
    index += 1
  }
  const finalSlug = `${candidate}-${index}`
  usedSlugs.add(finalSlug)
  return finalSlug
}

function matchesMunicipalityFeature(feature, municipality) {
  const districtCode = buildDistrictCode(municipality)
  const featureDistrictCode = String(feature?.properties?.DISTRITO || '').padStart(2, '0')
  const normalizedMunicipalityName = normalizeText(municipality?.name || '')
  const normalizedFeatureDistrictName = normalizeText(feature?.properties?.DIST_DESC || '')
  const clave = String(feature?.properties?.CLAVE || '').replace(/\D/g, '')
  const ineCode = String(municipality?.ineCode || '').replace(/\D/g, '')

  return (
    featureDistrictCode === districtCode ||
    (ineCode && clave.startsWith(ineCode)) ||
    normalizedFeatureDistrictName === normalizedMunicipalityName
  )
}

function buildBarrioRow(feature, municipalityId, source, usedSlugs) {
  const properties = feature?.properties || {}
  const rawLabel = compactWhitespace(
    properties.BARLO_DESC ||
    properties.barlo_desc ||
    properties.nombre ||
    properties.label ||
    properties.name ||
    '',
  )
  const barrioLabel = repairMojibake(rawLabel) || 'Barrio sin nombre'
  const barrioCode = String(
    properties.CLAVE ||
    properties.BAR_LOC ||
    properties.bar_loc ||
    properties.id ||
    properties.code ||
    '',
  ).trim() || null
  const bounds = geometryBounds(feature?.geometry)
  const center = geometryCenter(feature?.geometry) || computeCenterFromBounds(bounds)

  if (!center) return null

  return {
    municipalityId,
    barrioSlug: buildUniqueBarrioSlug(barrioLabel, barrioCode, usedSlugs),
    barrioLabel,
    barrioCode,
    centerLat: Number(center.lat.toFixed(6)),
    centerLon: Number(center.lon.toFixed(6)),
    bbox: bounds || {},
    geometry: feature?.geometry || {},
    metadata: {
      districtCode: String(properties.DISTRITO || '').padStart(2, '0'),
      districtName: repairMojibake(String(properties.DIST_DESC || '')),
      areaCode: String(properties.AREA || '').trim() || null,
      ineBarrioCode: String(properties.BAR_LOC || '').trim() || null,
    },
    sourceName: source.name,
    sourceUrl: source.url,
  }
}

async function getMunicipalityRecord({ municipalityId = '', municipalitySlug = '' } = {}) {
  const params = []
  const filters = []

  if (municipalityId) {
    params.push(Number(municipalityId))
    filters.push(`id = $${params.length}`)
  }

  if (municipalitySlug) {
    params.push(String(municipalitySlug).trim().toLowerCase())
    filters.push(`slug = $${params.length}`)
  }

  if (!filters.length) return null

  const { rows } = await query(
    `
      SELECT *
      FROM rag_municipalities
      WHERE ${filters.join(' OR ')}
      ORDER BY id ASC
      LIMIT 1
    `,
    params,
  )

  return rowToMunicipality(rows[0])
}

async function fetchDepartmentZip(url) {
  const response = await fetch(url)
  if (!response.ok) {
    const error = new Error('municipal-barrios-source-unavailable')
    error.code = 'municipal-barrios-source-unavailable'
    throw error
  }

  return JSZip.loadAsync(Buffer.from(await response.arrayBuffer()))
}

function findZipEntry(zip, segment) {
  const normalizedSegment = String(segment || '').toLowerCase()
  return Object.keys(zip.files).find((fileName) => fileName.toLowerCase().includes(normalizedSegment))
}

async function parseGeoJsonEntry(zip, fileName) {
  if (!fileName) return null
  const entry = zip.file(fileName)
  if (!entry) return null
  return JSON.parse(await entry.async('string'))
}

async function replaceMunicipalBarrios(client, municipality, barrioRows, geoUpdate) {
  await client.query(`DELETE FROM municipal_barrios WHERE municipality_id = $1`, [municipality.id])

  for (const row of barrioRows) {
    await client.query(
      `
        INSERT INTO municipal_barrios (
          municipality_id,
          barrio_slug,
          barrio_label,
          barrio_code,
          center_lat,
          center_lon,
          bbox,
          geometry,
          metadata,
          source_name,
          source_url,
          imported_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, NOW(), NOW())
      `,
      [
        row.municipalityId,
        row.barrioSlug,
        row.barrioLabel,
        row.barrioCode,
        row.centerLat,
        row.centerLon,
        JSON.stringify(row.bbox || {}),
        JSON.stringify(row.geometry || {}),
        JSON.stringify(row.metadata || {}),
        row.sourceName,
        row.sourceUrl,
      ],
    )
  }

  await client.query(
    `
      UPDATE rag_municipalities
      SET
        center_lat = $2,
        center_lon = $3,
        bbox = $4::jsonb,
        geometry = $5::jsonb,
        geo_source_name = $6,
        geo_source_url = $7,
        geo_imported_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `,
    [
      municipality.id,
      geoUpdate.centerLat,
      geoUpdate.centerLon,
      JSON.stringify(geoUpdate.bbox || {}),
      JSON.stringify(geoUpdate.geometry || {}),
      geoUpdate.sourceName,
      geoUpdate.sourceUrl,
    ],
  )
}

async function listMunicipalBarrioRows(client, municipalityId) {
  const { rows } = await client.query(
    `
      SELECT *
      FROM municipal_barrios
      WHERE municipality_id = $1
      ORDER BY barrio_label ASC, id ASC
    `,
    [municipalityId],
  )

  return rows.map(rowToMunicipalBarrio)
}

async function refreshMunicipalityGeoSummary(client, municipalityId, options = {}) {
  const municipality = await getMunicipalityRecord({ municipalityId })
  if (!municipality) {
    const error = new Error('municipality-not-found')
    error.code = 'municipality-not-found'
    throw error
  }

  const barrioRows = await listMunicipalBarrioRows(client, municipality.id)
  if (!barrioRows.length) return municipality

  const geoUpdate = buildGeoUpdate({
    districtGeometry: municipality.geometry || null,
    barrioRows: barrioRows.map((row) => ({
      ...row,
      bbox: row.bbox && Object.keys(row.bbox || {}).length ? row.bbox : buildBoundsFromCenter({
        lat: row.centerLat,
        lon: row.centerLon,
      }),
      geometry: row.geometry || {},
    })),
    source: {
      name: compactWhitespace(options.sourceName) || municipality.geoSourceName || 'Edición manual desde panel',
      url: compactWhitespace(options.sourceUrl) || municipality.geoSourceUrl || 'manual://developer-panel',
    },
  })

  await client.query(
    `
      UPDATE rag_municipalities
      SET
        center_lat = $2,
        center_lon = $3,
        bbox = $4::jsonb,
        geo_source_name = $5,
        geo_source_url = $6,
        updated_at = NOW()
      WHERE id = $1
    `,
    [
      municipality.id,
      geoUpdate.centerLat,
      geoUpdate.centerLon,
      JSON.stringify(geoUpdate.bbox || {}),
      geoUpdate.sourceName,
      geoUpdate.sourceUrl,
    ],
  )

  return municipality
}

function buildGeoUpdate({ districtGeometry = null, barrioRows = [], source }) {
  const districtBounds = geometryBounds(districtGeometry)
  const rowBounds = barrioRows.map((row) => row.bbox)
  const combinedBounds = districtBounds || combineBounds(rowBounds)
  const center =
    geometryCenter(districtGeometry) ||
    computeCenterFromBounds(combinedBounds) ||
    (barrioRows.length
      ? {
          lat: barrioRows.reduce((total, row) => total + Number(row.centerLat || 0), 0) / barrioRows.length,
          lon: barrioRows.reduce((total, row) => total + Number(row.centerLon || 0), 0) / barrioRows.length,
        }
      : null)

  return {
    centerLat: center ? Number(center.lat.toFixed(6)) : null,
    centerLon: center ? Number(center.lon.toFixed(6)) : null,
    bbox: combinedBounds || {},
    geometry: districtGeometry || {},
    sourceName: source.name,
    sourceUrl: source.url,
  }
}

function parseCsvRows(text = '') {
  const rows = []
  let currentRow = []
  let currentValue = ''
  let insideQuotes = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const nextChar = text[index + 1]

    if (insideQuotes) {
      if (char === '"' && nextChar === '"') {
        currentValue += '"'
        index += 1
        continue
      }
      if (char === '"') {
        insideQuotes = false
        continue
      }
      currentValue += char
      continue
    }

    if (char === '"') {
      insideQuotes = true
      continue
    }

    if (char === ',') {
      currentRow.push(currentValue)
      currentValue = ''
      continue
    }

    if (char === '\n') {
      currentRow.push(currentValue)
      rows.push(currentRow)
      currentRow = []
      currentValue = ''
      continue
    }

    if (char !== '\r') {
      currentValue += char
    }
  }

  if (currentValue.length || currentRow.length) {
    currentRow.push(currentValue)
    rows.push(currentRow)
  }

  return rows
}

function csvToObjects(text = '') {
  const rows = parseCsvRows(text).filter((row) => row.some((value) => String(value || '').trim()))
  if (!rows.length) return []

  const [headers, ...records] = rows
  const normalizedHeaders = headers.map((header, index) =>
    slugify(String(header || '').replace(/_/g, '-')) || `column-${index + 1}`,
  )

  return records.map((record) => Object.fromEntries(
    normalizedHeaders.map((header, index) => [header, String(record[index] || '').trim()]),
  ))
}

function parseGeometryValue(value) {
  const raw = String(value || '').trim()
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    if (parsed?.type === 'Feature') return parsed.geometry || null
    if (parsed?.type === 'FeatureCollection') return parsed.features?.[0]?.geometry || null
    if (parsed?.type && Array.isArray(parsed?.coordinates)) return parsed
  } catch {
    return null
  }

  return null
}

function parseNumberValue(...values) {
  for (const value of values) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
  }
  return null
}

function requireBarrioLabel(value) {
  const normalized = compactWhitespace(String(value || ''))
  if (!normalized) {
    const error = new Error('municipal-barrio-required-fields')
    error.code = 'municipal-barrio-required-fields'
    throw error
  }
  return repairMojibake(normalized)
}

function requireCoordinate(value, field = 'coordinate') {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    const error = new Error('municipal-barrio-required-fields')
    error.code = 'municipal-barrio-required-fields'
    error.field = field
    throw error
  }
  return Number(numeric.toFixed(6))
}

async function ensureUniqueBarrioSlug(client, municipalityId, rawSlug, { excludeId = null } = {}) {
  const baseSlug = slugify(rawSlug) || 'barrio'
  let nextSlug = baseSlug
  let index = 2

  while (true) {
    const params = [municipalityId, nextSlug]
    let clause = ''
    if (excludeId) {
      params.push(Number(excludeId))
      clause = ` AND id <> $3`
    }

    const { rows } = await client.query(
      `
        SELECT id
        FROM municipal_barrios
        WHERE municipality_id = $1
          AND barrio_slug = $2
          ${clause}
        LIMIT 1
      `,
      params,
    )

    if (!rows.length) return nextSlug
    nextSlug = `${baseSlug}-${index}`
    index += 1
  }
}

function firstNonEmptyValue(record, keys = []) {
  for (const key of keys) {
    const value = record?.[key]
    if (String(value || '').trim()) return String(value).trim()
  }
  return ''
}

function buildBarrioRowFromRecord(record, municipalityId, source, usedSlugs, rowIndex) {
  const geometry = parseGeometryValue(
    firstNonEmptyValue(record, ['geometry-geojson', 'geometry', 'geojson', 'polygon', 'multipolygon']),
  ) || {}
  const bboxFromColumns = {
    minLat: parseNumberValue(record['bbox-min-lat'], record.minlat, record.min_lat),
    maxLat: parseNumberValue(record['bbox-max-lat'], record.maxlat, record.max_lat),
    minLon: parseNumberValue(record['bbox-min-lon'], record.minlon, record.min_lon),
    maxLon: parseNumberValue(record['bbox-max-lon'], record.maxlon, record.max_lon),
  }
  const hasBBoxFromColumns = Object.values(bboxFromColumns).every((value) => Number.isFinite(value))
  const bounds = geometryBounds(geometry) || (hasBBoxFromColumns ? bboxFromColumns : null)
  const center =
    geometryCenter(geometry) ||
    (() => {
      const lat = parseNumberValue(record['center-lat'], record.centerlat, record.lat, record.latitude)
      const lon = parseNumberValue(record['center-lon'], record.centerlon, record.lon, record.longitude)
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return { lat, lon }
      }
      return computeCenterFromBounds(bounds)
    })()

  if (!center) return null

  const rawLabel = firstNonEmptyValue(record, ['barrio-label', 'label', 'nombre', 'barrio', 'name'])
  const barrioLabel = repairMojibake(rawLabel || `Barrio ${rowIndex + 1}`)
  const barrioCode = firstNonEmptyValue(record, ['barrio-code', 'code', 'id', 'codigo']) || null
  const metadata = Object.fromEntries(
    Object.entries(record).filter(([key]) => ![
      'barrio-label', 'label', 'nombre', 'barrio', 'name',
      'barrio-code', 'code', 'id', 'codigo',
      'center-lat', 'centerlon', 'center-lon', 'centerlat',
      'lat', 'lon', 'latitude', 'longitude',
      'bbox-min-lat', 'bbox-max-lat', 'bbox-min-lon', 'bbox-max-lon',
      'minlat', 'maxlat', 'minlon', 'maxlon', 'min_lat', 'max_lat', 'min_lon', 'max_lon',
      'geometry-geojson', 'geometry', 'geojson', 'polygon', 'multipolygon',
    ].includes(key)),
  )

  return {
    municipalityId,
    barrioSlug: buildUniqueBarrioSlug(barrioLabel, barrioCode || rowIndex + 1, usedSlugs),
    barrioLabel,
    barrioCode,
    centerLat: Number(center.lat.toFixed(6)),
    centerLon: Number(center.lon.toFixed(6)),
    bbox: bounds || {},
    geometry: geometry || {},
    metadata,
    sourceName: source.name,
    sourceUrl: source.url,
  }
}

function parseUploadedBarrioRows({ fileName = '', fileBuffer, source, municipalityId }) {
  const extension = fileName.toLowerCase().split('.').pop()
  const rawText = Buffer.isBuffer(fileBuffer) ? fileBuffer.toString('utf8') : String(fileBuffer || '')
  if (!rawText.trim()) {
    const error = new Error('municipal-barrios-import-empty')
    error.code = 'municipal-barrios-import-empty'
    throw error
  }

  const usedSlugs = new Set()

  if (extension === 'geojson' || extension === 'json') {
    let parsed = null
    try {
      parsed = JSON.parse(rawText)
    } catch {
      const error = new Error('municipal-barrios-import-format-invalid')
      error.code = 'municipal-barrios-import-format-invalid'
      throw error
    }
    const features = parsed?.type === 'FeatureCollection'
      ? parsed.features || []
      : parsed?.type === 'Feature'
        ? [parsed]
        : []

    const barrioRows = features
      .map((feature) => buildBarrioRow(feature, municipalityId, source, usedSlugs))
      .filter(Boolean)

    if (!barrioRows.length) {
      const error = new Error('municipal-barrios-import-empty')
      error.code = 'municipal-barrios-import-empty'
      throw error
    }

    return {
      barrioRows,
      geometryCount: barrioRows.filter((row) => row.geometry?.type).length,
    }
  }

  if (extension === 'csv') {
    const records = csvToObjects(rawText)
    const barrioRows = records
      .map((record, index) => buildBarrioRowFromRecord(record, municipalityId, source, usedSlugs, index))
      .filter(Boolean)

    if (!barrioRows.length) {
      const error = new Error('municipal-barrios-import-empty')
      error.code = 'municipal-barrios-import-empty'
      throw error
    }

    return {
      barrioRows,
      geometryCount: barrioRows.filter((row) => row.geometry?.type).length,
    }
  }

  const error = new Error('municipal-barrios-import-format-invalid')
  error.code = 'municipal-barrios-import-format-invalid'
  throw error
}

export async function syncAsuncionMunicipalCoverage() {
  const municipality = await getMunicipalityRecord({ municipalitySlug: 'asuncion' })
  if (!municipality) return null

  const { rows } = await query(`
    SELECT barrio_id, barrio_label, center_lat, center_lon, bbox, geometry
    FROM collection_barrios
    ORDER BY barrio_label ASC
  `)

  if (!rows.length) return null

  const barrioRows = rows.map((row) => ({
    municipalityId: municipality.id,
    barrioSlug: row.barrio_id,
    barrioLabel: repairMojibake(row.barrio_label || row.barrio_id),
    barrioCode: null,
    centerLat: Number(row.center_lat),
    centerLon: Number(row.center_lon),
    bbox: parseJson(row.bbox, {}),
    geometry: parseJson(row.geometry, {}),
    metadata: {},
    sourceName: MUNICIPAL_GEOGRAPHY_SOURCES.asuncionLocal.name,
    sourceUrl: MUNICIPAL_GEOGRAPHY_SOURCES.asuncionLocal.url,
  }))
  const geoUpdate = buildGeoUpdate({
    districtGeometry: null,
    barrioRows,
    source: {
      name: MUNICIPAL_GEOGRAPHY_SOURCES.asuncionLocal.name,
      url: MUNICIPAL_GEOGRAPHY_SOURCES.asuncionLocal.url,
    },
  })

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await replaceMunicipalBarrios(client, municipality, barrioRows, geoUpdate)
    await client.query(
      `
        UPDATE pothole_reports
        SET municipality_id = $1
        WHERE municipality_id IS NULL
      `,
      [municipality.id],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  return {
    municipalityId: municipality.id,
    municipalitySlug: municipality.slug,
    municipalityName: municipality.name,
    barrioCount: barrioRows.length,
    sourceName: MUNICIPAL_GEOGRAPHY_SOURCES.asuncionLocal.name,
    sourceUrl: MUNICIPAL_GEOGRAPHY_SOURCES.asuncionLocal.url,
  }
}

export async function bootstrapMunicipalityGeography({ municipalityId = '', municipalitySlug = '', requestedBy = 'desarrollador' } = {}) {
  const municipality = await getMunicipalityRecord({ municipalityId, municipalitySlug })
  if (!municipality) {
    const error = new Error('municipality-not-found')
    error.code = 'municipality-not-found'
    throw error
  }

  if (municipality.slug === 'asuncion') {
    return syncAsuncionMunicipalCoverage()
  }

  const zipUrl = buildIneDepartmentZipUrl(municipality)
  const zip = await fetchDepartmentZip(zipUrl)
  const barrioEntryName = findZipEntry(zip, 'barrios_localidades_')
  const districtEntryName = findZipEntry(zip, 'distritos_')
  const [barriosGeoJson, districtsGeoJson] = await Promise.all([
    parseGeoJsonEntry(zip, barrioEntryName),
    parseGeoJsonEntry(zip, districtEntryName),
  ])

  const barrioFeatures = (barriosGeoJson?.features || []).filter((feature) => matchesMunicipalityFeature(feature, municipality))
  if (!barrioFeatures.length) {
    const error = new Error('municipal-barrios-source-empty')
    error.code = 'municipal-barrios-source-empty'
    throw error
  }

  const districtFeature =
    (districtsGeoJson?.features || []).find((feature) => matchesMunicipalityFeature(feature, municipality)) || null
  const usedSlugs = new Set()
  const source = {
    name: MUNICIPAL_GEOGRAPHY_SOURCES.ineCartography2012.name,
    url: zipUrl,
  }
  const barrioRows = barrioFeatures
    .map((feature) => buildBarrioRow(feature, municipality.id, source, usedSlugs))
    .filter(Boolean)
  const geoUpdate = buildGeoUpdate({
    districtGeometry: districtFeature?.geometry || null,
    barrioRows,
    source,
  })

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await replaceMunicipalBarrios(client, municipality, barrioRows, geoUpdate)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  return {
    municipalityId: municipality.id,
    municipalitySlug: municipality.slug,
    municipalityName: municipality.name,
    barrioCount: barrioRows.length,
    requestedBy,
    sourceName: source.name,
    sourceUrl: source.url,
  }
}

export async function importMunicipalityBarriosFromFile({
  municipalityId = '',
  municipalitySlug = '',
  fileName = '',
  fileBuffer = null,
  sourceName = '',
  sourceUrl = '',
  requestedBy = 'desarrollador',
} = {}) {
  const municipality = await getMunicipalityRecord({ municipalityId, municipalitySlug })
  if (!municipality) {
    const error = new Error('municipality-not-found')
    error.code = 'municipality-not-found'
    throw error
  }

  if (!fileBuffer || !fileName) {
    const error = new Error('municipal-barrios-import-file-required')
    error.code = 'municipal-barrios-import-file-required'
    throw error
  }

  const normalizedSource = {
    name: compactWhitespace(sourceName) || `Archivo manual - ${repairMojibake(fileName)}`,
    url: compactWhitespace(sourceUrl) || `upload://${repairMojibake(fileName)}`,
  }
  const { barrioRows, geometryCount } = parseUploadedBarrioRows({
    fileName,
    fileBuffer,
    source: normalizedSource,
    municipalityId: municipality.id,
  })
  const geoUpdate = buildGeoUpdate({
    districtGeometry: null,
    barrioRows,
    source: normalizedSource,
  })

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await replaceMunicipalBarrios(client, municipality, barrioRows, geoUpdate)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  return {
    municipalityId: municipality.id,
    municipalitySlug: municipality.slug,
    municipalityName: municipality.name,
    barrioCount: barrioRows.length,
    geometryCount,
    requestedBy,
    sourceName: normalizedSource.name,
    sourceUrl: normalizedSource.url,
  }
}

export async function listMunicipalBarrios({ municipalityId = '' } = {}) {
  const municipality = await getMunicipalityRecord({ municipalityId })
  if (!municipality) {
    const error = new Error('municipality-not-found')
    error.code = 'municipality-not-found'
    throw error
  }

  const client = await getPool().connect()
  let released = false
  try {
    let barrioRows = await listMunicipalBarrioRows(client, municipality.id)
    if (!barrioRows.length && municipality.slug === 'asuncion') {
      client.release()
      released = true
      await syncAsuncionMunicipalCoverage()
      const retryClient = await getPool().connect()
      try {
        barrioRows = await listMunicipalBarrioRows(retryClient, municipality.id)
      } finally {
        retryClient.release()
      }
      return barrioRows
    }
    return barrioRows
  } finally {
    if (!released) client.release()
  }
}

export async function createMunicipalBarrio({
  municipalityId = '',
  barrioLabel = '',
  barrioCode = '',
  centerLat = null,
  centerLon = null,
  sourceName = '',
  sourceUrl = '',
  requestedBy = 'desarrollador',
} = {}) {
  const municipality = await getMunicipalityRecord({ municipalityId })
  if (!municipality) {
    const error = new Error('municipality-not-found')
    error.code = 'municipality-not-found'
    throw error
  }

  const nextLabel = requireBarrioLabel(barrioLabel)
  const nextCode = compactWhitespace(String(barrioCode || '')) || null
  const nextLat = requireCoordinate(centerLat, 'centerLat')
  const nextLon = requireCoordinate(centerLon, 'centerLon')
  const manualSourceName = compactWhitespace(sourceName) || 'Carga manual desde panel'
  const manualSourceUrl = compactWhitespace(sourceUrl) || `manual://${requestedBy}`

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const nextSlug = await ensureUniqueBarrioSlug(client, municipality.id, nextCode || nextLabel)
    const { rows } = await client.query(
      `
        INSERT INTO municipal_barrios (
          municipality_id,
          barrio_slug,
          barrio_label,
          barrio_code,
          center_lat,
          center_lon,
          bbox,
          geometry,
          metadata,
          source_name,
          source_url,
          imported_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, '{}'::jsonb, $7::jsonb, $8, $9, NOW(), NOW())
        RETURNING *
      `,
      [
        municipality.id,
        nextSlug,
        nextLabel,
        nextCode,
        nextLat,
        nextLon,
        JSON.stringify({
          manual: true,
          manuallyCreatedAt: new Date().toISOString(),
          requestedBy,
        }),
        manualSourceName,
        manualSourceUrl,
      ],
    )
    await refreshMunicipalityGeoSummary(client, municipality.id, {
      sourceName: municipality.geoSourceName || manualSourceName,
      sourceUrl: municipality.geoSourceUrl || manualSourceUrl,
    })
    await client.query('COMMIT')
    return rowToMunicipalBarrio(rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function updateMunicipalBarrio(
  barrioId,
  {
    municipalityId = '',
    barrioLabel,
    barrioCode,
    centerLat,
    centerLon,
    requestedBy = 'desarrollador',
  } = {},
) {
  const municipality = await getMunicipalityRecord({ municipalityId })
  if (!municipality) {
    const error = new Error('municipality-not-found')
    error.code = 'municipality-not-found'
    throw error
  }

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const { rows: currentRows } = await client.query(
      `
        SELECT *
        FROM municipal_barrios
        WHERE id = $1
        LIMIT 1
      `,
      [Number(barrioId)],
    )
    const current = currentRows[0]
    if (!current) {
      const error = new Error('municipal-barrio-not-found')
      error.code = 'municipal-barrio-not-found'
      throw error
    }
    if (Number(current.municipality_id) !== Number(municipality.id)) {
      const error = new Error('municipal-barrio-municipality-mismatch')
      error.code = 'municipal-barrio-municipality-mismatch'
      throw error
    }

    const nextLabel = barrioLabel === undefined ? current.barrio_label : requireBarrioLabel(barrioLabel)
    const nextCode = barrioCode === undefined ? current.barrio_code : compactWhitespace(String(barrioCode || '')) || null
    const nextLat = centerLat === undefined ? Number(current.center_lat) : requireCoordinate(centerLat, 'centerLat')
    const nextLon = centerLon === undefined ? Number(current.center_lon) : requireCoordinate(centerLon, 'centerLon')
    const nextSlug = await ensureUniqueBarrioSlug(client, municipality.id, nextCode || nextLabel, {
      excludeId: current.id,
    })
    const nextMetadata = {
      ...parseJson(current.metadata, {}),
      manual: true,
      manuallyUpdatedAt: new Date().toISOString(),
      updatedBy: requestedBy,
    }

    const { rows } = await client.query(
      `
        UPDATE municipal_barrios
        SET
          barrio_slug = $2,
          barrio_label = $3,
          barrio_code = $4,
          center_lat = $5,
          center_lon = $6,
          metadata = $7::jsonb,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        Number(barrioId),
        nextSlug,
        nextLabel,
        nextCode,
        nextLat,
        nextLon,
        JSON.stringify(nextMetadata),
      ],
    )
    await refreshMunicipalityGeoSummary(client, municipality.id)
    await client.query('COMMIT')
    return rowToMunicipalBarrio(rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
