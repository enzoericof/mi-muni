import fs from 'node:fs/promises'
import path from 'node:path'
import { getPool, query } from '../db/index.js'
import { embedTexts, hasOpenAIAccess, openAIModels } from './openai.js'
import { compactWhitespace, normalizeText, stripSpiderBoilerplate } from './text.js'

export const DEFAULT_CRAWL_LIMITS = Object.freeze({
  maxDepth: 3,
  maxPages: 500,
  maxPdfs: 200,
  maxImages: 500,
  maxFileBytes: 26_214_400,
  concurrency: 2,
  pageTimeoutMs: 30_000,
})

const DEFAULT_RAG_ASSISTANT_RUNTIME = Object.freeze({
  assistantUseEmbeddings: true,
  assistantChunkLimit: 10,
  assistantMinRelevanceScore: 5,
  assistantStrictMunicipalityScope: true,
})

const JOB_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled'])
const SEED_STATUSES = new Set(['active', 'paused'])
const SOURCE_TYPES = new Set(['html', 'pdf', 'image', 'manual'])

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

function clampFloat(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function normalizeUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return null
  }
}

function truncate(value, maxLength = 500) {
  const normalized = compactWhitespace(String(value || ''))
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`
}

function hostnameFromUrl(value) {
  const normalized = normalizeUrl(value)
  if (!normalized) return ''
  return new URL(normalized).hostname.toLowerCase()
}

function pathnameFromUrl(value) {
  const normalized = normalizeUrl(value)
  if (!normalized) return ''
  return new URL(normalized).pathname.replace(/\/+$/, '') || '/'
}

function isSpiderListingPath(pathname = '') {
  const normalized = String(pathname || '').trim().toLowerCase()
  if (!normalized || normalized === '/') return true
  return (
    normalized === '/archivo' ||
    normalized.startsWith('/archivo/') ||
    normalized.startsWith('/category/') ||
    normalized.startsWith('/categoria/') ||
    normalized.startsWith('/tag/') ||
    normalized.startsWith('/etiqueta/') ||
    normalized.startsWith('/author/') ||
    normalized.startsWith('/autor/') ||
    normalized.startsWith('/page/')
  )
}

function shouldSkipSpiderIndexItem(item) {
  if (!item || item.source_type !== 'html') return false
  const pathname = pathnameFromUrl(item.source_url || '')
  const title = compactWhitespace(item.title || '').toLowerCase()
  if (isSpiderListingPath(pathname)) return true
  return title.startsWith('archivos - ') || /^municipalidad de [a-z0-9 .-]+$/i.test(title)
}

function isNoisySpiderChunkBlock(block, { listingLike = false } = {}) {
  const normalized = compactWhitespace(block)
  if (!normalized) return true

  const wordCount = normalized.split(/\s+/).filter(Boolean).length
  const comparable = normalizeText(normalized)
  if (
    comparable.includes('leer mas')
    || comparable.includes('etiquetas de la entrada')
    || comparable.includes('navegacion de entradas')
    || comparable.includes('facebook twitter whatsapp')
  ) {
    return true
  }
  if (listingLike && wordCount < 80 && !/[.!?]/.test(normalized)) return true
  return false
}

function embeddingToVectorLiteral(embedding) {
  if (!Array.isArray(embedding) || embedding.length !== 1536) return null
  return `[${embedding.map((value) => Number(value) || 0).join(',')}]`
}

function resolveArtifactDir() {
  const configured = process.env.RAG_ARTIFACT_DIR || 'server/data/rag-artifacts'
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured)
}

async function hasPgVector() {
  try {
    const { rows } = await query(`SELECT to_regtype('vector') AS vector_type`)
    return Boolean(rows[0]?.vector_type)
  } catch {
    return false
  }
}

function rowToMunicipality(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    primaryDomain: row.primary_domain || '',
    department: row.department || '',
    ineCode: row.ine_code || '',
    centerLat: row.center_lat === null || row.center_lat === undefined ? null : Number(row.center_lat),
    centerLon: row.center_lon === null || row.center_lon === undefined ? null : Number(row.center_lon),
    sourceName: row.source_name || '',
    sourceUrl: row.source_url || '',
    geoSourceName: row.geo_source_name || '',
    geoSourceUrl: row.geo_source_url || '',
    geoImportedAt: row.geo_imported_at ? new Date(row.geo_imported_at).toISOString() : null,
    active: row.active === true,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    barrioCount: Number(row.barrio_count || 0),
    geoReady: Number(row.barrio_count || 0) > 0,
    seedCount: Number(row.seed_count || 0),
    itemCount: Number(row.item_count || 0),
    visibleItemCount: Number(row.visible_item_count || 0),
    chunkCount: Number(row.chunk_count || 0),
    embeddedChunkCount: Number(row.embedded_chunk_count || 0),
    spiderItemCount: Number(row.spider_item_count || 0),
    spiderVisibleItemCount: Number(row.spider_visible_item_count || 0),
    spiderChunkCount: Number(row.spider_chunk_count || 0),
    spiderEmbeddedChunkCount: Number(row.spider_embedded_chunk_count || 0),
  }
}

function rowToRagAssistantRuntime(row = {}) {
  return {
    assistantUseEmbeddings: parseBoolean(
      row.assistant_use_embeddings,
      DEFAULT_RAG_ASSISTANT_RUNTIME.assistantUseEmbeddings,
    ),
    assistantChunkLimit: clampInt(
      row.assistant_chunk_limit,
      DEFAULT_RAG_ASSISTANT_RUNTIME.assistantChunkLimit,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    assistantMinRelevanceScore: clampFloat(
      row.assistant_min_relevance_score,
      DEFAULT_RAG_ASSISTANT_RUNTIME.assistantMinRelevanceScore,
      0,
      50,
    ),
    assistantStrictMunicipalityScope: parseBoolean(
      row.assistant_strict_municipality_scope,
      DEFAULT_RAG_ASSISTANT_RUNTIME.assistantStrictMunicipalityScope,
    ),
  }
}

async function getRuntimeChunkLimitCap() {
  const { rows } = await query(`SELECT COUNT(*) AS total_count FROM rag_chunks`)
  const chunkCount = Number(rows[0]?.total_count || 0)
  return Number.isFinite(chunkCount) && chunkCount > 0 ? Math.trunc(chunkCount) : null
}

function rowToSeedUrl(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    municipalityId: Number(row.municipality_id),
    municipalityName: row.municipality_name || null,
    url: row.url,
    allowedHostname: row.allowed_hostname,
    maxDepth: Number(row.max_depth),
    maxPages: Number(row.max_pages),
    maxPdfs: Number(row.max_pdfs),
    maxImages: Number(row.max_images),
    maxFileBytes: Number(row.max_file_bytes),
    concurrency: Number(row.concurrency),
    pageTimeoutMs: Number(row.page_timeout_ms),
    status: row.status,
    createdBy: row.created_by || null,
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    lastChangedAt: row.last_changed_at ? new Date(row.last_changed_at).toISOString() : null,
    staleAfterDays: Number(row.stale_after_days || 30),
    changeStatus: row.change_status || 'unknown',
    lastContentHash: row.last_content_hash || null,
    checkError: row.check_error || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }
}

export function rowToCrawlJob(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    municipalityId: Number(row.municipality_id),
    municipalityName: row.municipality_name || null,
    seedUrlIds: Array.isArray(row.seed_url_ids) ? row.seed_url_ids.map(Number) : [],
    status: row.status,
    requestedBy: row.requested_by || null,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    stats: row.stats || {},
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }
}

function rowToCatalogItem(row) {
  if (!row) return null
  const resolvedCategory = resolveIndexItemCategory(row)
  const resolvedType = resolveIndexItemType(row)
  const connectedChunkCount = Number(row.connected_chunk_count || 0)
  const statusCode = Number(row?.metadata?.statusCode || 0) || null
  return {
    id: Number(row.id),
    municipalityId: Number(row.municipality_id),
    municipalityName: row.municipality_name || null,
    sourceType: row.source_type,
    sourceId: row.source_id ? Number(row.source_id) : null,
    title: row.title || 'Sin titulo',
    sourceUrl: row.source_url || null,
    text: stripSpiderBoilerplate(row.text || ''),
    summary: stripSpiderBoilerplate(row.summary || ''),
    contentHash: row.content_hash || null,
    version: Number(row.version || 1),
    previousContentHash: row.previous_content_hash || null,
    previousText: row.previous_text || '',
    changedAt: row.changed_at ? new Date(row.changed_at).toISOString() : null,
    metadata: row.metadata || {},
    indexedAt: row.indexed_at ? new Date(row.indexed_at).toISOString() : null,
    publicationId: row.publication_id ? Number(row.publication_id) : null,
    visible: row.visible === true,
    selectedBy: row.selected_by || null,
    selectedAt: row.selected_at ? new Date(row.selected_at).toISOString() : null,
    notes: row.notes || '',
    resolvedCategory,
    resolvedType,
    statusCode,
    connectedChunkCount,
    connectedToMunita: connectedChunkCount > 0,
  }
}

function rowToEmbeddingChunk(row) {
  if (!row) return null
  const hasJsonEmbedding = row.has_json_embedding === true
  const hasVectorEmbedding = row.has_vector_embedding === true
  return {
    id: row.id,
    municipalityId: Number(row.municipality_id),
    sourceItemId: row.source_item_id ? Number(row.source_item_id) : null,
    sourceType: row.source_type || null,
    sourceTitle: row.source_title || row.fuente_titulo || 'Sin fuente',
    sourceUrl: row.source_url || row.fuente_url || null,
    chunkTitle: row.titulo || 'Sin titulo',
    textPreview: truncate(stripSpiderBoilerplate(row.text || ''), 220),
    categoria: row.categoria || 'institucional',
    tipo: row.tipo || 'informacion',
    indexedAt: row.indexed_at ? new Date(row.indexed_at).toISOString() : null,
    embeddingModel: row.embedding_model || null,
    hasJsonEmbedding,
    hasVectorEmbedding,
    hasEmbedding: hasJsonEmbedding || hasVectorEmbedding,
  }
}

function extractCategorySegments(sourceUrl = '', metadata = {}) {
  const candidates = [
    sourceUrl,
    metadata?.canonicalUrl,
    metadata?.pageUrl,
  ].filter(Boolean)

  for (const candidate of candidates) {
    const normalized = normalizeUrl(candidate)
    if (!normalized) continue
    try {
      const pathname = new URL(normalized).pathname.toLowerCase()
      const categoryMatch = pathname.match(/\/category\/(.+?)\/?$/)
      if (categoryMatch?.[1]) {
        return categoryMatch[1].split('/').filter(Boolean)
      }
      const segments = pathname.split('/').filter(Boolean)
      if (segments.length) return segments
    } catch {
      // ignore malformed URLs and keep trying other candidates
    }
  }

  return []
}

function deriveCategorySlug(value = '') {
  return normalizeSlug(value).replace(/^category-/, '')
}

function resolveIndexItemCategory(row = {}) {
  const metadata = row.metadata || {}
  const categorySegments = extractCategorySegments(row.source_url || '', metadata)
  const preferred = categorySegments[categorySegments.length - 1] || categorySegments[0] || ''
  const slug = deriveCategorySlug(preferred || row.title || row.source_type || 'institucional')

  const aliases = new Map([
    ['admin-y-finanzas', 'admin-y-finanzas'],
    ['administracion-y-finanzas', 'admin-y-finanzas'],
    ['recaudaciones', 'patente'],
    ['reclamos-y-tramites', 'reclamos'],
    ['centros-municipales', 'centros'],
    ['licencias-de-conducir', 'licencia'],
    ['licencias', 'licencia'],
    ['habilitacion', 'habilitacion'],
    ['habilitaciones', 'habilitacion'],
  ])

  return aliases.get(slug) || slug || 'institucional'
}

function resolveIndexItemType(row = {}) {
  const sourceType = String(row.source_type || '').toLowerCase()
  const normalizedText = compactWhitespace(`${row.title || ''} ${row.summary || ''} ${row.text || ''}`).toLowerCase()
  const normalizedUrl = normalizeUrl(row.source_url || row?.metadata?.canonicalUrl || '')

  if ((normalizedUrl && new URL(normalizedUrl).pathname.toLowerCase().includes('/category/')) || /\barchives\b/.test(normalizedText)) {
    return 'informacion'
  }

  if (/\b(tramite|trámite|requisito|requisitos|formulario|habilitacion|habilitación|licencia|patente)\b/.test(normalizedText)) {
    return 'tramite'
  }
  if (/\b(servicio|reclamo|reclamos|centro municipal|atencion|atención|turno|recoleccion|recolección)\b/.test(normalizedText)) {
    return 'servicio'
  }
  if (sourceType === 'pdf') return 'documento'
  if (sourceType === 'image') return 'recurso'
  return 'informacion'
}

function rowToCrawledPage(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    jobId: Number(row.job_id),
    municipalityId: Number(row.municipality_id),
    seedUrlId: Number(row.seed_url_id),
    seedUrl: row.seed_url || null,
    url: row.url,
    canonicalUrl: row.canonical_url || null,
    title: row.title || 'Sin titulo',
    statusCode: row.status_code ? Number(row.status_code) : null,
    depth: Number(row.depth || 0),
    contentHash: row.content_hash || null,
    rawPath: row.raw_path || null,
    textPath: row.text_path || null,
    metadata: row.metadata || {},
    fetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : null,
  }
}

function rowToAsset(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    jobId: Number(row.job_id),
    municipalityId: Number(row.municipality_id),
    pageId: row.page_id ? Number(row.page_id) : null,
    pageUrl: row.page_url || null,
    url: row.url,
    assetType: row.asset_type,
    contentType: row.content_type || null,
    filePath: row.file_path || null,
    sha256: row.sha256 || null,
    sizeBytes: Number(row.size_bytes || 0),
    textStatus: row.text_status || null,
    extractedTextPreview: truncate(row.extracted_text || '', 320),
    textExtractedAt: row.text_extracted_at ? new Date(row.text_extracted_at).toISOString() : null,
    metadata: row.metadata || {},
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }
}

async function getJobById(id) {
  const { rows } = await query(
    `
      SELECT j.*, m.name AS municipality_name
      FROM rag_crawl_jobs j
      JOIN rag_municipalities m ON m.id = j.municipality_id
      WHERE j.id = $1
      LIMIT 1
    `,
    [id],
  )
  return rowToCrawlJob(rows[0])
}

async function deleteDirectoryIfExists(targetPath) {
  if (!targetPath) return
  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => null)
}

async function deleteSpiderIndexItemsByIds(indexItemIds, db = query) {
  const normalizedIds = [...new Set((Array.isArray(indexItemIds) ? indexItemIds : []).map(Number).filter(Number.isFinite))]
  if (!normalizedIds.length) return

  await db(`DELETE FROM rag_chunks WHERE source_item_id = ANY($1::bigint[])`, [normalizedIds])
  await db(`DELETE FROM rag_index_items WHERE id = ANY($1::bigint[])`, [normalizedIds])
}

async function listIndexItemIdsForJob(jobId) {
  const { rows } = await query(
    `
      SELECT i.id
      FROM rag_index_items i
      WHERE (
        i.source_type = 'html'
        AND EXISTS (
          SELECT 1 FROM rag_crawled_pages p
          WHERE p.job_id = $1 AND p.id = i.source_id
        )
      ) OR (
        i.source_type IN ('pdf', 'image')
        AND EXISTS (
          SELECT 1 FROM rag_assets a
          WHERE a.job_id = $1 AND a.id = i.source_id
        )
      )
    `,
    [jobId],
  )
  return rows.map((row) => Number(row.id)).filter(Number.isFinite)
}

async function listSeedRelatedEntityIds(seedId) {
  const { rows: pageRows } = await query(`SELECT id FROM rag_crawled_pages WHERE seed_url_id = $1`, [seedId])
  const pageIds = pageRows.map((row) => Number(row.id)).filter(Number.isFinite)

  if (!pageIds.length) {
    return { pageIds: [], assetIds: [], indexItemIds: [] }
  }

  const { rows: assetRows } = await query(`SELECT id FROM rag_assets WHERE page_id = ANY($1::bigint[])`, [pageIds])
  const assetIds = assetRows.map((row) => Number(row.id)).filter(Number.isFinite)

  const { rows: itemRows } = await query(
    `
      SELECT i.id
      FROM rag_index_items i
      WHERE (
        i.source_type = 'html'
        AND i.source_id = ANY($1::bigint[])
      ) OR (
        i.source_type IN ('pdf', 'image')
        AND i.source_id = ANY($2::bigint[])
      )
    `,
    [pageIds, assetIds.length ? assetIds : [0]],
  )

  return {
    pageIds,
    assetIds,
    indexItemIds: itemRows.map((row) => Number(row.id)).filter(Number.isFinite),
  }
}

async function updateJobFailure(jobId, code, message) {
  const { rows } = await query(
    `
      UPDATE rag_crawl_jobs
      SET status = 'failed',
          finished_at = NOW(),
          updated_at = NOW(),
          error_code = $2,
          error_message = $3
      WHERE id = $1
      RETURNING *
    `,
    [jobId, code, message],
  )
  return getJobById(rows[0]?.id)
}

async function checkSpiderHealth(internalUrl) {
  const normalized = String(internalUrl || '').trim().replace(/\/+$/, '')
  if (!normalized) {
    return { ok: false, status: 'not-configured', url: '' }
  }

  try {
    const response = await fetch(`${normalized}/internal/health`, {
      signal: AbortSignal.timeout(2500),
    })
    if (!response.ok) {
      return { ok: false, status: `http-${response.status}`, url: normalized }
    }
    const payload = await response.json().catch(() => ({}))
    return { ok: true, status: 'online', url: normalized, payload }
  } catch (error) {
    return { ok: false, status: 'offline', url: normalized, error: error.message }
  }
}

export async function getRagRuntime({ includeSpiderHealth = true } = {}) {
  const { rows } = await query(`SELECT * FROM rag_runtime_settings WHERE settings_id = 1 LIMIT 1`)
  const settings = rows[0] || {}
  const spiderEnabled = parseBoolean(process.env.RAG_SPIDER_ENABLED, false)
  const spiderInternalUrl = String(process.env.RAG_SPIDER_INTERNAL_URL || '').trim()

  const [
    { rows: municipalityRows },
    { rows: seedRows },
    { rows: jobRows },
    { rows: itemRows },
    { rows: chunkRows },
    spiderHealth,
  ] = await Promise.all([
    query(`SELECT COUNT(*) AS count FROM rag_municipalities WHERE active = TRUE`),
    query(`SELECT COUNT(*) AS count FROM rag_seed_urls WHERE status = 'active'`),
    query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('queued', 'running')) AS active_count,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
      FROM rag_crawl_jobs
    `),
    query(`
      SELECT
        COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE p.visible = TRUE) AS visible_count,
        COUNT(*) FILTER (WHERE i.source_type IN ('html', 'pdf', 'image')) AS spider_total_count,
        COUNT(*) FILTER (WHERE i.source_type IN ('html', 'pdf', 'image') AND p.visible = TRUE) AS spider_visible_count
      FROM rag_index_items i
      LEFT JOIN rag_info_publication p ON p.index_item_id = i.id
    `),
    query(`
      SELECT
        COUNT(*) AS total_count,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS json_embedding_count,
        COUNT(*) FILTER (WHERE embedding_vector IS NOT NULL) AS vector_embedding_count,
        COUNT(*) FILTER (WHERE source_item_id IS NOT NULL) AS spider_chunk_count,
        COUNT(*) FILTER (WHERE source_item_id IS NOT NULL AND (embedding IS NOT NULL OR embedding_vector IS NOT NULL)) AS spider_embedded_chunk_count
      FROM rag_chunks
    `).catch(() => ({ rows: [{ total_count: 0, json_embedding_count: 0, vector_embedding_count: 0, spider_chunk_count: 0, spider_embedded_chunk_count: 0 }] })),
    includeSpiderHealth && spiderEnabled
      ? checkSpiderHealth(spiderInternalUrl)
      : Promise.resolve({ ok: false, status: spiderEnabled ? 'not-checked' : 'disabled', url: spiderInternalUrl }),
  ])

  return {
    spiderEnabled,
    spiderOperationsEnabled: parseBoolean(settings.spider_operations_enabled, false),
    spiderReadyForJobs: spiderEnabled && parseBoolean(settings.spider_operations_enabled, false),
    spiderInternalUrl,
    spiderHealth,
    publicIndexEnabled: parseBoolean(settings.public_index_enabled, false),
    ...rowToRagAssistantRuntime(settings),
    openAIEnabled: hasOpenAIAccess(),
    embeddingModel: hasOpenAIAccess() ? openAIModels.embedding : null,
    chatModel: hasOpenAIAccess() ? openAIModels.chat : null,
    updatedAt: settings.updated_at ? new Date(settings.updated_at).toISOString() : null,
    updatedBy: settings.updated_by || null,
    artifactDir: process.env.RAG_ARTIFACT_DIR || 'server/data/rag-artifacts',
    counts: {
      municipalities: Number(municipalityRows[0]?.count || 0),
      seeds: Number(seedRows[0]?.count || 0),
      activeJobs: Number(jobRows[0]?.active_count || 0),
      completedJobs: Number(jobRows[0]?.completed_count || 0),
      failedJobs: Number(jobRows[0]?.failed_count || 0),
      indexItems: Number(itemRows[0]?.total_count || 0),
      visibleItems: Number(itemRows[0]?.visible_count || 0),
      spiderIndexItems: Number(itemRows[0]?.spider_total_count || 0),
      spiderVisibleItems: Number(itemRows[0]?.spider_visible_count || 0),
      chunks: Number(chunkRows[0]?.total_count || 0),
      spiderChunks: Number(chunkRows[0]?.spider_chunk_count || 0),
      jsonEmbeddings: Number(chunkRows[0]?.json_embedding_count || 0),
      vectorEmbeddings: Number(chunkRows[0]?.vector_embedding_count || 0),
      spiderEmbeddedChunks: Number(chunkRows[0]?.spider_embedded_chunk_count || 0),
    },
  }
}

export async function updateRagRuntimeSettings({
  publicIndexEnabled,
  spiderOperationsEnabled,
  assistantUseEmbeddings,
  assistantChunkLimit,
  assistantMinRelevanceScore,
  assistantStrictMunicipalityScope,
  updatedBy,
}) {
  if (publicIndexEnabled !== undefined && typeof publicIndexEnabled !== 'boolean') {
    const error = new Error('rag-public-index-boolean-required')
    error.code = 'rag-public-index-boolean-required'
    throw error
  }
  if (spiderOperationsEnabled !== undefined && typeof spiderOperationsEnabled !== 'boolean') {
    const error = new Error('rag-spider-operations-boolean-required')
    error.code = 'rag-spider-operations-boolean-required'
    throw error
  }
  if (assistantUseEmbeddings !== undefined && typeof assistantUseEmbeddings !== 'boolean') {
    const error = new Error('rag-assistant-use-embeddings-boolean-required')
    error.code = 'rag-assistant-use-embeddings-boolean-required'
    throw error
  }
  if (
    assistantChunkLimit !== undefined
    && (!Number.isFinite(Number(assistantChunkLimit)) || Number(assistantChunkLimit) < 1)
  ) {
    const error = new Error('rag-assistant-chunk-limit-invalid')
    error.code = 'rag-assistant-chunk-limit-invalid'
    throw error
  }
  const chunkLimitCap = assistantChunkLimit !== undefined ? await getRuntimeChunkLimitCap() : null
  if (assistantChunkLimit !== undefined && !chunkLimitCap) {
    const error = new Error('rag-assistant-chunk-limit-max-unavailable')
    error.code = 'rag-assistant-chunk-limit-max-unavailable'
    throw error
  }
  if (assistantChunkLimit !== undefined && Number(assistantChunkLimit) > chunkLimitCap) {
    const error = new Error('rag-assistant-chunk-limit-invalid')
    error.code = 'rag-assistant-chunk-limit-invalid'
    throw error
  }
  if (
    assistantMinRelevanceScore !== undefined
    && (!Number.isFinite(Number(assistantMinRelevanceScore)) || Number(assistantMinRelevanceScore) < 0 || Number(assistantMinRelevanceScore) > 50)
  ) {
    const error = new Error('rag-assistant-min-relevance-score-invalid')
    error.code = 'rag-assistant-min-relevance-score-invalid'
    throw error
  }
  if (assistantStrictMunicipalityScope !== undefined && typeof assistantStrictMunicipalityScope !== 'boolean') {
    const error = new Error('rag-assistant-strict-municipality-scope-boolean-required')
    error.code = 'rag-assistant-strict-municipality-scope-boolean-required'
    throw error
  }
  if (
    publicIndexEnabled === undefined
    && spiderOperationsEnabled === undefined
    && assistantUseEmbeddings === undefined
    && assistantChunkLimit === undefined
    && assistantMinRelevanceScore === undefined
    && assistantStrictMunicipalityScope === undefined
  ) {
    const error = new Error('rag-runtime-update-required')
    error.code = 'rag-runtime-update-required'
    throw error
  }

  const { rows } = await query(
    `
      INSERT INTO rag_runtime_settings (
        settings_id,
        public_index_enabled,
        spider_operations_enabled,
        assistant_use_embeddings,
        assistant_chunk_limit,
        assistant_min_relevance_score,
        assistant_strict_municipality_scope,
        updated_by,
        updated_at
      )
      VALUES (1, COALESCE($1, FALSE), COALESCE($2, FALSE), COALESCE($3, TRUE), COALESCE($4, 10), COALESCE($5, 5), COALESCE($6, TRUE), $7, NOW())
      ON CONFLICT (settings_id) DO UPDATE
        SET public_index_enabled = COALESCE($1, rag_runtime_settings.public_index_enabled),
            spider_operations_enabled = COALESCE($2, rag_runtime_settings.spider_operations_enabled),
            assistant_use_embeddings = COALESCE($3, rag_runtime_settings.assistant_use_embeddings),
            assistant_chunk_limit = COALESCE($4, rag_runtime_settings.assistant_chunk_limit),
            assistant_min_relevance_score = COALESCE($5, rag_runtime_settings.assistant_min_relevance_score),
            assistant_strict_municipality_scope = COALESCE($6, rag_runtime_settings.assistant_strict_municipality_scope),
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
      RETURNING *
    `,
    [
      publicIndexEnabled === undefined ? null : publicIndexEnabled,
      spiderOperationsEnabled === undefined ? null : spiderOperationsEnabled,
      assistantUseEmbeddings === undefined ? null : assistantUseEmbeddings,
      assistantChunkLimit === undefined ? null : clampInt(assistantChunkLimit, DEFAULT_RAG_ASSISTANT_RUNTIME.assistantChunkLimit, 1, chunkLimitCap || Number.MAX_SAFE_INTEGER),
      assistantMinRelevanceScore === undefined ? null : clampFloat(assistantMinRelevanceScore, DEFAULT_RAG_ASSISTANT_RUNTIME.assistantMinRelevanceScore, 0, 50),
      assistantStrictMunicipalityScope === undefined ? null : assistantStrictMunicipalityScope,
      updatedBy || 'desarrollador',
    ],
  )

  return {
    publicIndexEnabled: parseBoolean(rows[0]?.public_index_enabled, false),
    spiderOperationsEnabled: parseBoolean(rows[0]?.spider_operations_enabled, false),
    ...rowToRagAssistantRuntime(rows[0]),
    updatedAt: rows[0]?.updated_at ? new Date(rows[0].updated_at).toISOString() : null,
    updatedBy: rows[0]?.updated_by || null,
  }
}

export async function isRagPublicIndexEnabled() {
  const runtime = await getRagRuntime({ includeSpiderHealth: false })
  return runtime.publicIndexEnabled
}

export async function getRagAssistantRuntime() {
  const { rows } = await query(`SELECT * FROM rag_runtime_settings WHERE settings_id = 1 LIMIT 1`)
  return rowToRagAssistantRuntime(rows[0] || {})
}

export async function listRagMunicipalities() {
  const { rows } = await query(`
    SELECT m.*,
           COALESCE(barrio_counts.barrio_count, 0) AS barrio_count,
           COALESCE(seed_counts.seed_count, 0) AS seed_count,
           COALESCE(item_counts.item_count, 0) AS item_count,
           COALESCE(item_counts.visible_item_count, 0) AS visible_item_count,
           COALESCE(chunk_counts.chunk_count, 0) AS chunk_count,
           COALESCE(chunk_counts.embedded_chunk_count, 0) AS embedded_chunk_count,
           COALESCE(item_counts.spider_item_count, 0) AS spider_item_count,
           COALESCE(item_counts.spider_visible_item_count, 0) AS spider_visible_item_count,
           COALESCE(chunk_counts.spider_chunk_count, 0) AS spider_chunk_count,
           COALESCE(chunk_counts.spider_embedded_chunk_count, 0) AS spider_embedded_chunk_count
    FROM rag_municipalities m
    LEFT JOIN (
      SELECT municipality_id, COUNT(*) AS barrio_count
      FROM municipal_barrios
      GROUP BY municipality_id
    ) AS barrio_counts ON barrio_counts.municipality_id = m.id
    LEFT JOIN (
      SELECT municipality_id, COUNT(*) AS seed_count
      FROM rag_seed_urls
      GROUP BY municipality_id
    ) AS seed_counts ON seed_counts.municipality_id = m.id
    LEFT JOIN (
      SELECT
        i.municipality_id,
        COUNT(*) AS item_count,
        COUNT(*) FILTER (WHERE p.visible = TRUE) AS visible_item_count,
        COUNT(*) FILTER (WHERE i.source_type IN ('html', 'pdf', 'image')) AS spider_item_count,
        COUNT(*) FILTER (WHERE i.source_type IN ('html', 'pdf', 'image') AND p.visible = TRUE) AS spider_visible_item_count
      FROM rag_index_items i
      LEFT JOIN rag_info_publication p ON p.index_item_id = i.id
      GROUP BY i.municipality_id
    ) AS item_counts ON item_counts.municipality_id = m.id
    LEFT JOIN (
      SELECT
        municipality_id,
        COUNT(*) AS chunk_count,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL OR embedding_vector IS NOT NULL) AS embedded_chunk_count,
        COUNT(*) FILTER (WHERE source_item_id IS NOT NULL) AS spider_chunk_count,
        COUNT(*) FILTER (
          WHERE source_item_id IS NOT NULL
            AND (embedding IS NOT NULL OR embedding_vector IS NOT NULL)
        ) AS spider_embedded_chunk_count
      FROM rag_chunks
      GROUP BY municipality_id
    ) AS chunk_counts ON chunk_counts.municipality_id = m.id
    ORDER BY m.active DESC, m.department ASC NULLS LAST, m.name ASC
  `)
  return rows.map(rowToMunicipality)
}

export async function listActiveRagMunicipalities() {
  const { rows } = await query(`
    SELECT
      m.slug,
      m.name,
      m.center_lat,
      m.center_lon,
      m.bbox,
      COALESCE(seed_counts.seed_count, 0) AS seed_count,
      COALESCE(barrio_counts.barrio_count, 0) AS barrio_count,
      CASE
        WHEN m.center_lat IS NOT NULL
         AND m.center_lon IS NOT NULL
         AND COALESCE(barrio_counts.barrio_count, 0) > 0
        THEN TRUE
        ELSE FALSE
      END AS geo_ready
    FROM rag_municipalities m
    LEFT JOIN (
      SELECT municipality_id, COUNT(*) AS seed_count
      FROM rag_seed_urls
      GROUP BY municipality_id
    ) seed_counts ON seed_counts.municipality_id = m.id
    LEFT JOIN (
      SELECT municipality_id, COUNT(*) AS barrio_count
      FROM municipal_barrios
      GROUP BY municipality_id
    ) barrio_counts ON barrio_counts.municipality_id = m.id
    WHERE m.active = TRUE
      AND (
        COALESCE(seed_counts.seed_count, 0) > 0
        OR COALESCE(barrio_counts.barrio_count, 0) > 0
      )
    ORDER BY m.name ASC
  `)

  return rows.map((row) => ({
    key: row.slug,
    label: rowToMunicipality(row)?.name || row.slug,
    centerLat: row.center_lat === null || row.center_lat === undefined ? null : Number(row.center_lat),
    centerLon: row.center_lon === null || row.center_lon === undefined ? null : Number(row.center_lon),
    bbox: row.bbox || {},
    seedCount: Number(row.seed_count || 0),
    barrioCount: Number(row.barrio_count || 0),
    geoReady: row.geo_ready === true,
  }))
}

export async function createRagMunicipality({ slug, name, primaryDomain = '', department = '', ineCode = '', active = true }) {
  const normalizedSlug = normalizeSlug(slug || name)
  const normalizedName = compactWhitespace(String(name || ''))
  if (!normalizedSlug || !normalizedName) {
    const error = new Error('rag-municipality-required-fields')
    error.code = 'rag-municipality-required-fields'
    throw error
  }

  const { rows } = await query(
    `
      INSERT INTO rag_municipalities (slug, name, primary_domain, department, ine_code, active)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (slug) DO UPDATE
        SET name = EXCLUDED.name,
            primary_domain = EXCLUDED.primary_domain,
            department = COALESCE(EXCLUDED.department, rag_municipalities.department),
            ine_code = COALESCE(EXCLUDED.ine_code, rag_municipalities.ine_code),
            active = EXCLUDED.active,
            updated_at = NOW()
      RETURNING *
    `,
    [
      normalizedSlug,
      normalizedName,
      compactWhitespace(String(primaryDomain || '')) || null,
      compactWhitespace(String(department || '')) || null,
      compactWhitespace(String(ineCode || '')) || null,
      active === true,
    ],
  )
  return rowToMunicipality(rows[0])
}

export async function updateRagMunicipality(id, payload = {}) {
  const currentRows = await query(`SELECT * FROM rag_municipalities WHERE id = $1 LIMIT 1`, [id])
  const current = currentRows.rows[0]
  if (!current) return null

  const nextSlug = payload.slug === undefined ? current.slug : normalizeSlug(payload.slug)
  const nextName = payload.name === undefined ? current.name : compactWhitespace(String(payload.name || ''))
  if (!nextSlug || !nextName) {
    const error = new Error('rag-municipality-required-fields')
    error.code = 'rag-municipality-required-fields'
    throw error
  }

  const { rows } = await query(
    `
      UPDATE rag_municipalities
      SET slug = $2,
          name = $3,
          primary_domain = $4,
          department = $5,
          ine_code = $6,
          active = $7,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      id,
      nextSlug,
      nextName,
      payload.primaryDomain === undefined
        ? current.primary_domain
        : compactWhitespace(String(payload.primaryDomain || '')) || null,
      payload.department === undefined ? current.department : compactWhitespace(String(payload.department || '')) || null,
      payload.ineCode === undefined ? current.ine_code : compactWhitespace(String(payload.ineCode || '')) || null,
      payload.active === undefined ? current.active : payload.active === true,
    ],
  )
  return rowToMunicipality(rows[0])
}

export async function listRagSeedUrls({ municipalityId = '' } = {}) {
  const params = []
  const filters = []
  if (municipalityId) {
    params.push(Number(municipalityId))
    filters.push(`s.municipality_id = $${params.length}`)
  }

  const { rows } = await query(
    `
      SELECT s.*, m.name AS municipality_name
      FROM rag_seed_urls s
      JOIN rag_municipalities m ON m.id = s.municipality_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY s.updated_at DESC, s.id DESC
    `,
    params,
  )
  return rows.map(rowToSeedUrl)
}

function buildSeedValues(payload, current = {}) {
  const normalizedUrl = normalizeUrl(payload.url === undefined ? current.url : payload.url)
  if (!normalizedUrl) {
    const error = new Error('rag-seed-url-invalid')
    error.code = 'rag-seed-url-invalid'
    throw error
  }

  const allowedHostname = compactWhitespace(
    String(payload.allowedHostname === undefined ? current.allowed_hostname || '' : payload.allowedHostname || ''),
  ).toLowerCase() || hostnameFromUrl(normalizedUrl)

  return {
    url: normalizedUrl,
    allowedHostname,
    maxDepth: clampInt(payload.maxDepth, current.max_depth ?? DEFAULT_CRAWL_LIMITS.maxDepth, 0, 8),
    maxPages: clampInt(payload.maxPages, current.max_pages ?? DEFAULT_CRAWL_LIMITS.maxPages, 1, 2_000),
    maxPdfs: clampInt(payload.maxPdfs, current.max_pdfs ?? DEFAULT_CRAWL_LIMITS.maxPdfs, 0, 1_000),
    maxImages: clampInt(payload.maxImages, current.max_images ?? DEFAULT_CRAWL_LIMITS.maxImages, 0, 2_000),
    maxFileBytes: clampInt(payload.maxFileBytes, current.max_file_bytes ?? DEFAULT_CRAWL_LIMITS.maxFileBytes, 1_048_576, 104_857_600),
    concurrency: clampInt(payload.concurrency, current.concurrency ?? DEFAULT_CRAWL_LIMITS.concurrency, 1, 6),
    pageTimeoutMs: clampInt(payload.pageTimeoutMs, current.page_timeout_ms ?? DEFAULT_CRAWL_LIMITS.pageTimeoutMs, 5_000, 120_000),
    staleAfterDays: clampInt(payload.staleAfterDays, current.stale_after_days ?? 30, 1, 365),
    status: SEED_STATUSES.has(payload.status) ? payload.status : current.status || 'active',
  }
}

export async function createRagSeedUrl(payload = {}, user) {
  const municipalityId = Number(payload.municipalityId)
  if (!Number.isFinite(municipalityId)) {
    const error = new Error('rag-municipality-required')
    error.code = 'rag-municipality-required'
    throw error
  }

  const values = buildSeedValues(payload)
  const { rows } = await query(
    `
      INSERT INTO rag_seed_urls
        (municipality_id, url, allowed_hostname, max_depth, max_pages, max_pdfs, max_images,
         max_file_bytes, concurrency, page_timeout_ms, status, created_by, stale_after_days)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (municipality_id, url) DO UPDATE
        SET allowed_hostname = EXCLUDED.allowed_hostname,
            max_depth = EXCLUDED.max_depth,
            max_pages = EXCLUDED.max_pages,
            max_pdfs = EXCLUDED.max_pdfs,
            max_images = EXCLUDED.max_images,
            max_file_bytes = EXCLUDED.max_file_bytes,
            concurrency = EXCLUDED.concurrency,
            page_timeout_ms = EXCLUDED.page_timeout_ms,
            status = EXCLUDED.status,
            stale_after_days = EXCLUDED.stale_after_days,
            updated_at = NOW()
      RETURNING *
    `,
    [
      municipalityId,
      values.url,
      values.allowedHostname,
      values.maxDepth,
      values.maxPages,
      values.maxPdfs,
      values.maxImages,
      values.maxFileBytes,
      values.concurrency,
      values.pageTimeoutMs,
      values.status,
      user?.email || 'desarrollador',
      values.staleAfterDays,
    ],
  )
  return rowToSeedUrl(rows[0])
}

export async function updateRagSeedUrl(id, payload = {}, user) {
  const currentRows = await query(`SELECT * FROM rag_seed_urls WHERE id = $1 LIMIT 1`, [id])
  const current = currentRows.rows[0]
  if (!current) return null

  const values = buildSeedValues(payload, current)
  const municipalityId = payload.municipalityId === undefined ? current.municipality_id : Number(payload.municipalityId)
  const { rows } = await query(
    `
      UPDATE rag_seed_urls
      SET municipality_id = $2,
          url = $3,
          allowed_hostname = $4,
          max_depth = $5,
          max_pages = $6,
          max_pdfs = $7,
          max_images = $8,
          max_file_bytes = $9,
          concurrency = $10,
          page_timeout_ms = $11,
          status = $12,
          created_by = COALESCE(created_by, $13),
          stale_after_days = $14,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      id,
      municipalityId,
      values.url,
      values.allowedHostname,
      values.maxDepth,
      values.maxPages,
      values.maxPdfs,
      values.maxImages,
      values.maxFileBytes,
      values.concurrency,
      values.pageTimeoutMs,
      values.status,
      user?.email || 'desarrollador',
      values.staleAfterDays,
    ],
  )
  return rowToSeedUrl(rows[0])
}

export async function deleteRagSeedUrl(id, { deletedBy = 'desarrollador' } = {}) {
  const { rows } = await query(
    `
      SELECT s.*, m.name AS municipality_name
      FROM rag_seed_urls s
      JOIN rag_municipalities m ON m.id = s.municipality_id
      WHERE s.id = $1
      LIMIT 1
    `,
    [id],
  )
  const seed = rows[0]
  if (!seed) return null

  const { rows: activeJobRows } = await query(
    `
      SELECT id
      FROM rag_crawl_jobs
      WHERE status IN ('queued', 'running')
        AND seed_url_ids @> jsonb_build_array($1::bigint)
      LIMIT 1
    `,
    [id],
  )
  if (activeJobRows.length) {
    const error = new Error('rag-seed-url-job-active')
    error.code = 'rag-seed-url-job-active'
    throw error
  }

  const { assetIds, indexItemIds } = await listSeedRelatedEntityIds(id)

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await deleteSpiderIndexItemsByIds(indexItemIds, client.query.bind(client))
    if (assetIds.length) {
      await client.query(`DELETE FROM rag_assets WHERE id = ANY($1::bigint[])`, [assetIds])
    }
    await client.query(
      `
        UPDATE rag_crawl_jobs
        SET seed_url_ids = COALESCE((
              SELECT jsonb_agg(value::bigint)
              FROM jsonb_array_elements_text(seed_url_ids) value
              WHERE value::bigint <> $1
            ), '[]'::jsonb),
            updated_at = NOW(),
            stats = jsonb_set(
              COALESCE(stats, '{}'::jsonb),
              '{lastEventMessage}',
              to_jsonb($2::text),
              true
            )
        WHERE seed_url_ids @> jsonb_build_array($1::bigint)
      `,
      [id, `Seed ${id} eliminada por ${deletedBy}`],
    )
    await client.query(`DELETE FROM rag_seed_urls WHERE id = $1`, [id])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null)
    throw error
  } finally {
    client.release()
  }

  return rowToSeedUrl(seed)
}

export async function listRagCrawlJobs({ municipalityId = '', limit = 20 } = {}) {
  const params = [Math.max(1, Math.min(100, Number(limit) || 20))]
  const filters = []
  if (municipalityId) {
    params.push(Number(municipalityId))
    filters.push(`j.municipality_id = $${params.length}`)
  }

  const { rows } = await query(
    `
      SELECT j.*, m.name AS municipality_name
      FROM rag_crawl_jobs j
      JOIN rag_municipalities m ON m.id = j.municipality_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY j.created_at DESC
      LIMIT $1
    `,
    params,
  )
  return rows.map(rowToCrawlJob)
}

function normalizeJobResultType(value) {
  return ['pages', 'assets', 'items'].includes(value) ? value : 'pages'
}

function normalizePage(value) {
  const page = Number(value)
  if (!Number.isFinite(page)) return 1
  return Math.max(1, Math.trunc(page))
}

function normalizePageSize(value) {
  const pageSize = Number(value)
  if (!Number.isFinite(pageSize)) return 8
  return Math.max(1, Math.min(50, Math.trunc(pageSize)))
}

export async function listRagCrawlJobResults(jobId, { type = 'pages', page = 1, pageSize = 8 } = {}) {
  const job = await getJobById(jobId)
  if (!job) return null

  const resultType = normalizeJobResultType(type)
  const currentPage = normalizePage(page)
  const currentPageSize = normalizePageSize(pageSize)
  const offset = (currentPage - 1) * currentPageSize

  const [
    { rows: pageCountRows },
    { rows: assetCountRows },
    { rows: itemCountRows },
  ] = await Promise.all([
    query(`SELECT COUNT(*) AS count FROM rag_crawled_pages WHERE job_id = $1`, [jobId]),
    query(`
      SELECT
        COUNT(*) AS count,
        COUNT(*) FILTER (WHERE asset_type = 'pdf') AS pdf_count,
        COUNT(*) FILTER (WHERE asset_type = 'image') AS image_count
      FROM rag_assets
      WHERE job_id = $1
    `, [jobId]),
    query(`
      SELECT COUNT(*) AS count
      FROM rag_index_items i
      WHERE (
        i.source_type = 'html'
        AND EXISTS (
          SELECT 1 FROM rag_crawled_pages p
          WHERE p.job_id = $1 AND p.id = i.source_id
        )
      ) OR (
        i.source_type IN ('pdf', 'image')
        AND EXISTS (
          SELECT 1 FROM rag_assets a
          WHERE a.job_id = $1 AND a.id = i.source_id
        )
      )
    `, [jobId]),
  ])

  const summary = {
    pages: Number(pageCountRows[0]?.count || 0),
    assets: Number(assetCountRows[0]?.count || 0),
    pdfs: Number(assetCountRows[0]?.pdf_count || 0),
    images: Number(assetCountRows[0]?.image_count || 0),
    items: Number(itemCountRows[0]?.count || 0),
  }

  let total = summary[resultType] || 0
  let items = []

  if (resultType === 'pages') {
    const { rows } = await query(
      `
        SELECT p.*, s.url AS seed_url
        FROM rag_crawled_pages p
        LEFT JOIN rag_seed_urls s ON s.id = p.seed_url_id
        WHERE p.job_id = $1
        ORDER BY p.fetched_at DESC, p.id DESC
        LIMIT $2 OFFSET $3
      `,
      [jobId, currentPageSize, offset],
    )
    items = rows.map(rowToCrawledPage)
  } else if (resultType === 'assets') {
    const { rows } = await query(
      `
        SELECT a.*, p.url AS page_url
        FROM rag_assets a
        LEFT JOIN rag_crawled_pages p ON p.id = a.page_id
        WHERE a.job_id = $1
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $2 OFFSET $3
      `,
      [jobId, currentPageSize, offset],
    )
    items = rows.map(rowToAsset)
  } else {
    const { rows } = await query(
      `
        SELECT i.*, m.name AS municipality_name
        FROM rag_index_items i
        JOIN rag_municipalities m ON m.id = i.municipality_id
        WHERE (
          i.source_type = 'html'
          AND EXISTS (
            SELECT 1 FROM rag_crawled_pages p
            WHERE p.job_id = $1 AND p.id = i.source_id
          )
        ) OR (
          i.source_type IN ('pdf', 'image')
          AND EXISTS (
            SELECT 1 FROM rag_assets a
            WHERE a.job_id = $1 AND a.id = i.source_id
          )
        )
        ORDER BY i.indexed_at DESC, i.id DESC
        LIMIT $2 OFFSET $3
      `,
      [jobId, currentPageSize, offset],
    )
    items = rows.map((row) => {
      const item = rowToCatalogItem(row)
      return {
        ...item,
        textPreview: truncate(item.text || item.summary || '', 420),
      }
    })
  }

  return {
    job,
    summary,
    result: {
      type: resultType,
      page: currentPage,
      pageSize: currentPageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / currentPageSize)),
      items,
    },
  }
}

export async function listRagSourceHealth({ municipalityId = '' } = {}) {
  const params = []
  const filters = []
  if (municipalityId) {
    params.push(Number(municipalityId))
    filters.push(`s.municipality_id = $${params.length}`)
  }

  const { rows } = await query(
    `
      SELECT s.*, m.name AS municipality_name,
             CASE
               WHEN s.last_checked_at IS NULL THEN 'never_checked'
               WHEN s.change_status = 'error' THEN 'error'
               WHEN s.last_checked_at < NOW() - (s.stale_after_days::text || ' days')::interval THEN 'stale'
               ELSE s.change_status
             END AS computed_health
      FROM rag_seed_urls s
      JOIN rag_municipalities m ON m.id = s.municipality_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY s.last_checked_at ASC NULLS FIRST, s.updated_at DESC
    `,
    params,
  )

  return rows.map((row) => ({
    ...rowToSeedUrl(row),
    health: row.computed_health || row.change_status || 'unknown',
  }))
}

export async function checkRagSeedUrl(seedId, { checkedBy = 'desarrollador' } = {}) {
  const { rows } = await query(
    `
      SELECT s.*, m.name AS municipality_name
      FROM rag_seed_urls s
      JOIN rag_municipalities m ON m.id = s.municipality_id
      WHERE s.id = $1
      LIMIT 1
    `,
    [seedId],
  )
  const seed = rows[0]
  if (!seed) return null

  let nextStatus = 'unchanged'
  let nextHash = seed.last_content_hash || null
  let errorMessage = null

  try {
    const response = await fetch(seed.url, {
      signal: AbortSignal.timeout(Math.max(5000, Number(seed.page_timeout_ms || 30000))),
      headers: { 'user-agent': 'MiMuni-RAG-SourceCheck/1.0' },
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const text = compactWhitespace(await response.text())
    nextHash = normalizeUrl(seed.url) ? await cryptoDigest(text) : null
    nextStatus = seed.last_content_hash && seed.last_content_hash !== nextHash ? 'changed' : 'unchanged'
    if (!seed.last_content_hash) nextStatus = 'changed'
  } catch (error) {
    nextStatus = 'error'
    errorMessage = error.message
  }

  const { rows: updatedRows } = await query(
    `
      UPDATE rag_seed_urls
      SET last_checked_at = NOW(),
          last_changed_at = CASE WHEN $2 = 'changed' THEN NOW() ELSE last_changed_at END,
          change_status = $2,
          last_content_hash = COALESCE($3, last_content_hash),
          check_error = $4,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [seedId, nextStatus, nextHash, errorMessage],
  )

  return {
    ...rowToSeedUrl({ ...updatedRows[0], municipality_name: seed.municipality_name }),
    checkedBy,
  }
}

async function cryptoDigest(value) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(String(value || '')).digest('hex')
}

async function startSpiderJob(jobId) {
  const runtime = await getRagRuntime({ includeSpiderHealth: false })
  if (!runtime.spiderEnabled) {
    return updateJobFailure(jobId, 'spider-disabled', 'La integracion con rag-spider esta deshabilitada.')
  }
  if (!runtime.spiderOperationsEnabled) {
    return updateJobFailure(jobId, 'spider-operation-disabled', 'El spider esta apagado desde el panel desarrollador.')
  }

  if (!runtime.spiderInternalUrl) {
    return updateJobFailure(jobId, 'spider-url-missing', 'RAG_SPIDER_INTERNAL_URL no esta configurada.')
  }

  const internalUrl = runtime.spiderInternalUrl.replace(/\/+$/, '')
  try {
    const response = await fetch(`${internalUrl}/internal/rag/jobs/${jobId}/start`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      return updateJobFailure(jobId, payload.error || 'spider-offline', payload.message || 'rag-spider no pudo iniciar el job.')
    }
  } catch (error) {
    return updateJobFailure(jobId, 'spider-offline', error.message || 'rag-spider no responde.')
  }

  return getJobById(jobId)
}

export async function createRagCrawlJob({ municipalityId, seedUrlIds, requestedBy }) {
  const normalizedSeedIds = [...new Set((Array.isArray(seedUrlIds) ? seedUrlIds : []).map(Number).filter(Number.isFinite))]
  if (!normalizedSeedIds.length) {
    const error = new Error('rag-seed-url-required')
    error.code = 'rag-seed-url-required'
    throw error
  }

  const { rows: seedRows } = await query(
    `
      SELECT *
      FROM rag_seed_urls
      WHERE id = ANY($1::bigint[])
        AND status = 'active'
    `,
    [normalizedSeedIds],
  )
  if (seedRows.length !== normalizedSeedIds.length) {
    const error = new Error('rag-seed-url-not-found')
    error.code = 'rag-seed-url-not-found'
    throw error
  }

  const selectedMunicipalityId = Number(municipalityId || seedRows[0].municipality_id)
  if (seedRows.some((row) => Number(row.municipality_id) !== selectedMunicipalityId)) {
    const error = new Error('rag-seed-url-municipality-mismatch')
    error.code = 'rag-seed-url-municipality-mismatch'
    throw error
  }

  const { rows } = await query(
    `
      INSERT INTO rag_crawl_jobs (municipality_id, seed_url_ids, status, requested_by)
      VALUES ($1, $2, 'queued', $3)
      RETURNING *
    `,
    [selectedMunicipalityId, JSON.stringify(normalizedSeedIds), requestedBy || 'desarrollador'],
  )

  return startSpiderJob(rows[0].id)
}

export async function cancelRagCrawlJob(jobId, { requestedBy = 'desarrollador' } = {}) {
  const job = await getJobById(jobId)
  if (!job) return null
  if (!['queued', 'running'].includes(job.status)) return job

  const runtime = await getRagRuntime({ includeSpiderHealth: false })
  if (runtime.spiderEnabled && runtime.spiderInternalUrl) {
    const internalUrl = runtime.spiderInternalUrl.replace(/\/+$/, '')
    await fetch(`${internalUrl}/internal/rag/jobs/${jobId}/cancel`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    }).catch(() => null)
  }

  const { rows } = await query(
    `
      UPDATE rag_crawl_jobs
      SET status = 'cancelled',
          finished_at = COALESCE(finished_at, NOW()),
          updated_at = NOW(),
          error_code = NULL,
          error_message = $2
      WHERE id = $1
      RETURNING *
    `,
    [jobId, `Cancelado por ${requestedBy}`],
  )
  return rowToCrawlJob(rows[0])
}

export async function deleteRagCrawlJob(jobId, { deletedBy = 'desarrollador' } = {}) {
  const job = await getJobById(jobId)
  if (!job) return null
  if (['queued', 'running'].includes(job.status)) {
    const error = new Error('rag-crawl-job-active')
    error.code = 'rag-crawl-job-active'
    throw error
  }

  const indexItemIds = await listIndexItemIdsForJob(jobId)

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await deleteSpiderIndexItemsByIds(indexItemIds, client.query.bind(client))
    await client.query(`DELETE FROM rag_crawl_jobs WHERE id = $1`, [jobId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null)
    throw error
  } finally {
    client.release()
  }

  const artifactDir = path.join(resolveArtifactDir(), `job-${jobId}`)
  await deleteDirectoryIfExists(artifactDir)

  return {
    ...job,
    deletedBy,
  }
}

export async function listRagAdminCatalog({ municipalityId = '', sourceType = '', visibility = '', query: search = '', limit = 50 } = {}) {
  const params = []
  const filters = []
  if (municipalityId) {
    params.push(Number(municipalityId))
    filters.push(`i.municipality_id = $${params.length}`)
  }
  if (sourceType && SOURCE_TYPES.has(sourceType)) {
    params.push(sourceType)
    filters.push(`i.source_type = $${params.length}`)
  }
  if (visibility === 'visible') {
    filters.push(`p.visible = TRUE`)
  } else if (visibility === 'hidden') {
    filters.push(`COALESCE(p.visible, FALSE) = FALSE`)
  }
  if (search) {
    params.push(`%${String(search).trim()}%`)
    filters.push(`(i.title ILIKE $${params.length} OR i.summary ILIKE $${params.length} OR i.source_url ILIKE $${params.length})`)
  }

  params.push(Math.max(1, Math.min(200, Number(limit) || 50)))
  const limitIndex = params.length

  const { rows } = await query(
    `
      SELECT i.*, m.name AS municipality_name,
             p.id AS publication_id, p.visible, p.selected_by, p.selected_at, p.notes,
             rc.connected_chunk_count
      FROM rag_index_items i
      JOIN rag_municipalities m ON m.id = i.municipality_id
      LEFT JOIN rag_info_publication p ON p.index_item_id = i.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS connected_chunk_count
        FROM rag_chunks c
        WHERE c.source_item_id = i.id
      ) rc ON TRUE
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY i.indexed_at DESC, i.id DESC
      LIMIT $${limitIndex}
    `,
    params,
  )
  return rows.map(rowToCatalogItem)
}

export async function getRagCatalogItem(id) {
  const { rows } = await query(
    `
      SELECT i.*, m.name AS municipality_name,
             p.id AS publication_id, p.visible, p.selected_by, p.selected_at, p.notes,
             rc.connected_chunk_count
      FROM rag_index_items i
      JOIN rag_municipalities m ON m.id = i.municipality_id
      LEFT JOIN rag_info_publication p ON p.index_item_id = i.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS connected_chunk_count
        FROM rag_chunks c
        WHERE c.source_item_id = i.id
      ) rc ON TRUE
      WHERE i.id = $1
      LIMIT 1
    `,
    [id],
  )
  return rowToCatalogItem(rows[0])
}

export async function updateRagInfoPublication(id, { visible, selectedBy, notes = '' }) {
  if (typeof visible !== 'boolean') {
    const error = new Error('rag-publication-visible-required')
    error.code = 'rag-publication-visible-required'
    throw error
  }

  const item = await getRagCatalogItem(id)
  if (!item) return null

  await query(
    `
      INSERT INTO rag_info_publication (municipality_id, index_item_id, visible, selected_by, selected_at, notes)
      VALUES ($1, $2, $3, $4, NOW(), $5)
      ON CONFLICT (index_item_id) DO UPDATE
        SET visible = EXCLUDED.visible,
            selected_by = EXCLUDED.selected_by,
            selected_at = NOW(),
            notes = EXCLUDED.notes
    `,
    [item.municipalityId, item.id, visible, selectedBy || 'admin-muni', compactWhitespace(String(notes || '')) || null],
  )

  return getRagCatalogItem(id)
}

export async function bulkUpdateRagInfoPublication({
  municipalityId,
  visible,
  selectedBy,
  sourceType = '',
  notes = '',
} = {}) {
  if (!Number.isFinite(Number(municipalityId))) {
    const error = new Error('rag-municipality-required')
    error.code = 'rag-municipality-required'
    throw error
  }
  if (typeof visible !== 'boolean') {
    const error = new Error('rag-publication-visible-required')
    error.code = 'rag-publication-visible-required'
    throw error
  }

  const params = [Number(municipalityId)]
  const filters = [
    `i.municipality_id = $1`,
    `i.source_type IN ('html', 'pdf', 'image')`,
    `NULLIF(TRIM(COALESCE(i.text, '')), '') IS NOT NULL`,
    `NOT (i.source_type = 'html' AND COALESCE((i.metadata->>'statusCode')::int, 200) >= 400)`,
  ]

  if (sourceType && SOURCE_TYPES.has(sourceType)) {
    params.push(sourceType)
    filters.push(`i.source_type = $${params.length}`)
  }

  params.push(visible)
  params.push(selectedBy || 'desarrollador')
  params.push(compactWhitespace(String(notes || '')) || null)

  const { rows } = await query(
    `
      INSERT INTO rag_info_publication (municipality_id, index_item_id, visible, selected_by, selected_at, notes)
      SELECT i.municipality_id, i.id, $${params.length - 2}, $${params.length - 1}, NOW(), $${params.length}
      FROM rag_index_items i
      WHERE ${filters.join(' AND ')}
      ON CONFLICT (index_item_id) DO UPDATE
        SET visible = EXCLUDED.visible,
            selected_by = EXCLUDED.selected_by,
            selected_at = NOW(),
            notes = EXCLUDED.notes
      RETURNING index_item_id
    `,
    params,
  )

  return {
    municipalityId: Number(municipalityId),
    visible,
    updated: rows.length,
  }
}

export async function listRagEmbeddingDetails({
  municipalityId = '',
  query: search = '',
  state = 'all',
  page = 1,
  pageSize = 20,
} = {}) {
  const baseParams = []
  const baseFilters = [`c.source_item_id IS NOT NULL`]

  if (municipalityId) {
    baseParams.push(Number(municipalityId))
    baseFilters.push(`c.municipality_id = $${baseParams.length}`)
  }

  if (search) {
    baseParams.push(`%${String(search).trim()}%`)
    baseFilters.push(
      `(c.titulo ILIKE $${baseParams.length}
        OR c.text ILIKE $${baseParams.length}
        OR c.fuente_url ILIKE $${baseParams.length}
        OR COALESCE(i.title, '') ILIKE $${baseParams.length}
        OR COALESCE(i.source_url, '') ILIKE $${baseParams.length})`,
    )
  }

  const stateFilters = []
  if (state === 'embedded') {
    stateFilters.push(`(c.embedding IS NOT NULL OR c.embedding_vector IS NOT NULL)`)
  } else if (state === 'missing') {
    stateFilters.push(`(c.embedding IS NULL AND c.embedding_vector IS NULL)`)
  }

  const summaryParams = [...baseParams]
  const summaryWhere = [...baseFilters].join(' AND ')
  const { rows: summaryRows } = await query(
    `
      SELECT
        COUNT(*)::int AS total_chunks,
        COUNT(DISTINCT c.source_item_id)::int AS total_sources,
        COUNT(*) FILTER (WHERE c.embedding IS NOT NULL OR c.embedding_vector IS NOT NULL)::int AS embedded_chunks,
        COUNT(*) FILTER (WHERE c.embedding IS NULL AND c.embedding_vector IS NULL)::int AS missing_chunks,
        COUNT(*) FILTER (WHERE c.embedding IS NOT NULL)::int AS json_chunks,
        COUNT(*) FILTER (WHERE c.embedding_vector IS NOT NULL)::int AS vector_chunks
      FROM rag_chunks c
      LEFT JOIN rag_index_items i ON i.id = c.source_item_id
      WHERE ${summaryWhere}
    `,
    summaryParams,
  )

  const normalizedPageSize = Math.max(5, Math.min(50, Number(pageSize) || 20))
  const normalizedPage = Math.max(1, Number(page) || 1)
  const offset = (normalizedPage - 1) * normalizedPageSize
  const detailWhere = [...baseFilters, ...stateFilters].join(' AND ')
  const { rows: countRows } = await query(
    `
      SELECT COUNT(*)::int AS total_items
      FROM rag_chunks c
      LEFT JOIN rag_index_items i ON i.id = c.source_item_id
      WHERE ${detailWhere}
    `,
    baseParams,
  )
  const detailParams = [...baseParams]
  detailParams.push(normalizedPageSize)
  const limitIndex = detailParams.length
  detailParams.push(offset)
  const offsetIndex = detailParams.length
  const { rows } = await query(
    `
      SELECT
        c.id,
        c.municipality_id,
        c.source_item_id,
        c.source_type,
        c.titulo,
        c.text,
        c.categoria,
        c.tipo,
        c.fuente_titulo,
        c.fuente_url,
        c.indexed_at,
        c.embedding_model,
        (c.embedding IS NOT NULL) AS has_json_embedding,
        (c.embedding_vector IS NOT NULL) AS has_vector_embedding,
        i.title AS source_title,
        i.source_url
      FROM rag_chunks c
      LEFT JOIN rag_index_items i ON i.id = c.source_item_id
      WHERE ${detailWhere}
      ORDER BY
        (c.embedding_vector IS NOT NULL) DESC,
        (c.embedding IS NOT NULL) DESC,
        c.indexed_at DESC,
        c.id
      LIMIT $${limitIndex}
      OFFSET $${offsetIndex}
    `,
    detailParams,
  )

  const summary = summaryRows[0] || {}
  const totalItems = Number(countRows[0]?.total_items || 0)
  const totalPages = Math.max(1, Math.ceil(totalItems / normalizedPageSize))
  return {
    summary: {
      municipalityId: municipalityId ? Number(municipalityId) : null,
      totalChunks: Number(summary.total_chunks || 0),
      totalSources: Number(summary.total_sources || 0),
      embeddedChunks: Number(summary.embedded_chunks || 0),
      missingChunks: Number(summary.missing_chunks || 0),
      jsonChunks: Number(summary.json_chunks || 0),
      vectorChunks: Number(summary.vector_chunks || 0),
    },
    result: {
      page: normalizedPage,
      pageSize: normalizedPageSize,
      totalPages,
      totalItems,
    },
    chunks: rows.map(rowToEmbeddingChunk),
  }
}

export async function clearRagEmbeddings({
  municipalityId = '',
  connectedOnly = true,
} = {}) {
  const params = []
  const filters = [`(embedding IS NOT NULL OR embedding_vector IS NOT NULL)`]

  if (connectedOnly) {
    filters.push(`source_item_id IS NOT NULL`)
  }

  if (municipalityId) {
    params.push(Number(municipalityId))
    filters.push(`municipality_id = $${params.length}`)
  }

  const { rows } = await query(
    `
      UPDATE rag_chunks
      SET embedding = NULL,
          embedding_model = NULL,
          embedding_vector = NULL,
          indexed_at = NOW()
      WHERE ${filters.join(' AND ')}
      RETURNING id
    `,
    params,
  )

  return {
    municipalityId: municipalityId ? Number(municipalityId) : null,
    connectedOnly,
    cleared: rows.length,
  }
}

function splitLongBlock(block, maxLength) {
  const sentences = compactWhitespace(block).split(/(?<=[.!?;:])\s+/)
  const chunks = []
  let current = ''

  for (const sentence of sentences) {
    if (!sentence) continue
    if (!current) {
      current = sentence
      continue
    }
    if (`${current} ${sentence}`.length > maxLength) {
      chunks.push(current)
      current = sentence
    } else {
      current = `${current} ${sentence}`
    }
  }

  if (current) chunks.push(current)
  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxLength) return [chunk]
    const pieces = []
    for (let start = 0; start < chunk.length; start += maxLength) {
      pieces.push(compactWhitespace(chunk.slice(start, start + maxLength)))
    }
    return pieces.filter(Boolean)
  })
}

function splitIndexItemText(text, maxLength = 1400, options = {}) {
  const raw = stripSpiderBoilerplate(String(text || '')).replace(/\r/g, '\n')
  const listingLike = options.listingLike === true
  const structuralBlocks = raw
    .split(/\n{2,}|(?=\n\s*(?:[-*]|\d+[.)])\s+)/g)
    .map((block) => compactWhitespace(block))
    .filter((block) => block.length >= 30)
    .filter((block) => !isNoisySpiderChunkBlock(block, { listingLike }))

  const blocks = structuralBlocks.length ? structuralBlocks : splitLongBlock(text, maxLength)
  const chunks = []
  let current = ''

  for (const block of blocks) {
    const pieces = block.length > maxLength ? splitLongBlock(block, maxLength) : [block]
    for (const piece of pieces) {
      if (!current) {
        current = piece
        continue
      }
      if (`${current}\n${piece}`.length > maxLength) {
        chunks.push(compactWhitespace(current))
        current = piece
      } else {
        current = `${current}\n${piece}`
      }
    }
  }

  if (current) chunks.push(compactWhitespace(current))
  return chunks.filter((chunk) => chunk && !isNoisySpiderChunkBlock(chunk, { listingLike }))
}

export async function rebuildApprovedSpiderChunks() {
  const { rows: itemRows } = await query(`
    SELECT i.*, m.name AS municipality_name
    FROM rag_index_items i
    JOIN rag_info_publication p ON p.index_item_id = i.id AND p.visible = TRUE
    JOIN rag_municipalities m ON m.id = i.municipality_id
    WHERE i.source_type IN ('html', 'pdf', 'image')
    ORDER BY i.indexed_at DESC
  `)

  await query(`DELETE FROM rag_chunks WHERE source_item_id IS NOT NULL`)

  const chunks = []
  for (const item of itemRows) {
    if (shouldSkipSpiderIndexItem(item)) continue
    const textChunks = splitIndexItemText(item.text || item.summary || item.title, 1400, {
      listingLike: isSpiderListingPath(pathnameFromUrl(item.source_url || '')),
    })
    const resolvedCategory = resolveIndexItemCategory(item)
    const resolvedType = resolveIndexItemType(item)
    textChunks.forEach((text, index) => {
      chunks.push({
        id: `spider-${item.id}-${index}`,
        municipalityId: Number(item.municipality_id),
        sourceType: item.source_type,
        sourceItemId: Number(item.id),
        contentHash: item.content_hash || null,
        categoria: resolvedCategory,
        tipo: resolvedType,
        titulo: item.title || item.source_url || `Fuente ${item.id}`,
        text,
        fuenteTitulo: item.title || `${item.municipality_name} - ${item.source_type.toUpperCase()}`,
        fuenteUrl: item.source_url || null,
      })
    })
  }

  let embeddings = null
  if (chunks.length && hasOpenAIAccess()) {
    try {
      embeddings = await embedTexts(chunks.map((chunk) => `${chunk.titulo}\n${chunk.text}`))
    } catch (error) {
      console.warn(`[rag] No se pudieron generar embeddings durante el rebuild spider. Se continua en modo lexical. ${error?.message || ''}`.trim())
      embeddings = null
    }
  }
  const pgVectorAvailable = await hasPgVector()

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]
    const embeddingJson = embeddings?.[index] ? JSON.stringify(embeddings[index]) : null
    const embeddingVector = pgVectorAvailable ? embeddingToVectorLiteral(embeddings?.[index]) : null
    if (pgVectorAvailable) {
      await query(
        `
          INSERT INTO rag_chunks
            (id, procedure_id, titulo, text, seccion, categoria, tipo, fuente_titulo, fuente_url, fecha,
             embedding, embedding_model, embedding_vector, municipality_id, source_type, source_item_id, content_hash, indexed_at)
          VALUES ($1, NULL, $2, $3, 'fuente', $4, $5, $6, $7, $8,
                  $9, $10, $11::vector, $12, $13, $14, $15, NOW())
          ON CONFLICT (id) DO UPDATE
            SET titulo = EXCLUDED.titulo,
                text = EXCLUDED.text,
                categoria = EXCLUDED.categoria,
                tipo = EXCLUDED.tipo,
                fuente_titulo = EXCLUDED.fuente_titulo,
                fuente_url = EXCLUDED.fuente_url,
                fecha = EXCLUDED.fecha,
                embedding = EXCLUDED.embedding,
                embedding_model = EXCLUDED.embedding_model,
                embedding_vector = EXCLUDED.embedding_vector,
                municipality_id = EXCLUDED.municipality_id,
                source_type = EXCLUDED.source_type,
                source_item_id = EXCLUDED.source_item_id,
                content_hash = EXCLUDED.content_hash,
                indexed_at = NOW()
        `,
        [
          chunk.id,
          chunk.titulo,
          chunk.text,
          chunk.categoria,
          chunk.tipo,
          chunk.fuenteTitulo,
          chunk.fuenteUrl,
          new Date().toISOString(),
          embeddingJson,
          embeddingJson ? openAIModels.embedding : null,
          embeddingVector,
          chunk.municipalityId,
          chunk.sourceType,
          chunk.sourceItemId,
          chunk.contentHash,
        ],
      )
    } else {
      await query(
        `
          INSERT INTO rag_chunks
            (id, procedure_id, titulo, text, seccion, categoria, tipo, fuente_titulo, fuente_url, fecha,
             embedding, embedding_model, municipality_id, source_type, source_item_id, content_hash, indexed_at)
          VALUES ($1, NULL, $2, $3, 'fuente', $4, $5, $6, $7, $8,
                  $9, $10, $11, $12, $13, $14, NOW())
          ON CONFLICT (id) DO UPDATE
            SET titulo = EXCLUDED.titulo,
                text = EXCLUDED.text,
                categoria = EXCLUDED.categoria,
                tipo = EXCLUDED.tipo,
                fuente_titulo = EXCLUDED.fuente_titulo,
                fuente_url = EXCLUDED.fuente_url,
                fecha = EXCLUDED.fecha,
                embedding = EXCLUDED.embedding,
                embedding_model = EXCLUDED.embedding_model,
                municipality_id = EXCLUDED.municipality_id,
                source_type = EXCLUDED.source_type,
                source_item_id = EXCLUDED.source_item_id,
                content_hash = EXCLUDED.content_hash,
                indexed_at = NOW()
        `,
        [
          chunk.id,
          chunk.titulo,
          chunk.text,
          chunk.categoria,
          chunk.tipo,
          chunk.fuenteTitulo,
          chunk.fuenteUrl,
          new Date().toISOString(),
          embeddingJson,
          embeddingJson ? openAIModels.embedding : null,
          chunk.municipalityId,
          chunk.sourceType,
          chunk.sourceItemId,
          chunk.contentHash,
        ],
      )
    }
  }

  return {
    items: itemRows.length,
    chunks: chunks.length,
    embeddings: embeddings?.length || 0,
  }
}

export async function rebuildRagEmbeddings({ onlyMissing = false } = {}) {
  if (!hasOpenAIAccess()) {
    return {
      ok: false,
      error: 'openai-disabled',
      updated: 0,
      model: openAIModels.embedding,
    }
  }

  const { rows } = await query(
    `
      SELECT id, titulo, text, embedding_model, embedding
      FROM rag_chunks
      WHERE $1::boolean = FALSE
         OR embedding IS NULL
         OR embedding_model IS DISTINCT FROM $2
      ORDER BY indexed_at DESC, id
    `,
    [onlyMissing, openAIModels.embedding],
  )

  const pgVectorAvailable = await hasPgVector()
  let updated = 0
  const batchSize = 40
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize)
    const embeddings = await embedTexts(batch.map((row) => `${row.titulo || ''}\n${row.text || ''}`))
    if (!embeddings) break

    for (let index = 0; index < batch.length; index += 1) {
      const embedding = embeddings[index]
      const embeddingJson = JSON.stringify(embedding)
      const embeddingVector = pgVectorAvailable ? embeddingToVectorLiteral(embedding) : null
      if (pgVectorAvailable) {
        await query(
          `
            UPDATE rag_chunks
            SET embedding = $2,
                embedding_model = $3,
                embedding_vector = $4::vector,
                indexed_at = NOW()
            WHERE id = $1
          `,
          [batch[index].id, embeddingJson, openAIModels.embedding, embeddingVector],
        )
      } else {
        await query(
          `
            UPDATE rag_chunks
            SET embedding = $2,
                embedding_model = $3,
                indexed_at = NOW()
            WHERE id = $1
          `,
          [batch[index].id, embeddingJson, openAIModels.embedding],
        )
      }
      updated += 1
    }
  }

  return {
    ok: true,
    updated,
    requested: rows.length,
    model: openAIModels.embedding,
    vectorStored: pgVectorAvailable,
  }
}

export { JOB_STATUSES, SOURCE_TYPES }
