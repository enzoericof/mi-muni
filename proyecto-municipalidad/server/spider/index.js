import '../lib/env.js'
import crypto from 'node:crypto'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectWithRetry, initSchema, query } from '../db/index.js'
import { compactWhitespace, stripSpiderBoilerplate } from '../lib/text.js'

const PORT = Number(process.env.RAG_SPIDER_PORT || 8790)
const currentDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(currentDir, '../..')
const activeJobs = new Map()
const bootTime = Date.now()

function resolveArtifactDir() {
  const configured = process.env.RAG_ARTIFACT_DIR || 'server/data/rag-artifacts'
  return path.isAbsolute(configured) ? configured : path.join(projectRoot, configured)
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function normalizeUrl(value, base = '') {
  try {
    const parsed = new URL(value, base || undefined)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|yclid|mc_)/i.test(key)) parsed.searchParams.delete(key)
    }
    parsed.searchParams.sort()
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    }
    return parsed.toString()
  } catch {
    return null
  }
}

function isSameHostname(url, allowedHostname) {
  try {
    return new URL(url).hostname.toLowerCase() === String(allowedHostname || '').toLowerCase()
  } catch {
    return false
  }
}

function isPdfUrl(url) {
  try {
    return /\.pdf($|[?#])/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function isImageUrl(url) {
  try {
    return /\.(png|jpe?g|webp|gif|avif|bmp|svg)($|[?#])/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function safeName(url, fallback = 'asset') {
  const parsed = new URL(url)
  const base = path.basename(parsed.pathname) || fallback
  return base.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 140) || fallback
}

function truncate(value, maxLength = 500) {
  const normalized = compactWhitespace(String(value || ''))
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`
}

function toIso(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function touchJobContext(context, updates = {}) {
  if (!context) return
  Object.assign(context, updates)
  context.lastEventAt = Date.now()
}

function buildPersistedStats(stats, context) {
  return {
    ...stats,
    phase: context?.phase || null,
    message: context?.message || null,
    currentSeedId: context?.currentSeedId ?? null,
    currentSeedUrl: context?.currentSeedUrl || null,
    currentSeedIndex: context?.currentSeedIndex ?? 0,
    totalSeeds: context?.totalSeeds ?? 0,
    currentUrl: context?.currentUrl || null,
    currentAssetUrl: context?.currentAssetUrl || null,
    queueSize: context?.queueSize ?? 0,
    visitedCount: context?.visitedCount ?? 0,
    lastEventAt: toIso(context?.lastEventAt),
  }
}

async function persistJobProgress(jobId, stats, context) {
  await updateJob(jobId, { stats: JSON.stringify(buildPersistedStats(stats, context)) })
}

function snapshotActiveJob(jobId, context) {
  return {
    jobId: Number(jobId),
    municipalityId: context?.municipalityId ?? null,
    municipalityName: context?.municipalityName || null,
    startedAt: toIso(context?.startedAt),
    lastEventAt: toIso(context?.lastEventAt),
    phase: context?.phase || 'queued',
    message: context?.message || 'Esperando ejecucion',
    currentSeedId: context?.currentSeedId ?? null,
    currentSeedUrl: context?.currentSeedUrl || null,
    currentSeedIndex: context?.currentSeedIndex ?? 0,
    totalSeeds: context?.totalSeeds ?? 0,
    currentUrl: context?.currentUrl || null,
    currentAssetUrl: context?.currentAssetUrl || null,
    queueSize: context?.queueSize ?? 0,
    visitedCount: context?.visitedCount ?? 0,
    stats: buildPersistedStats(context?.stats || {}, context),
    cancelled: context?.cancelled === true,
  }
}

async function loadChromium() {
  try {
    const { chromium } = await import('playwright')
    return chromium
  } catch (error) {
    const wrapped = new Error('playwright-missing')
    wrapped.code = 'playwright-missing'
    wrapped.cause = error
    throw wrapped
  }
}

async function getJobConfig(jobId) {
  const { rows } = await query(
    `
      SELECT j.*, m.slug AS municipality_slug, m.name AS municipality_name
      FROM rag_crawl_jobs j
      JOIN rag_municipalities m ON m.id = j.municipality_id
      WHERE j.id = $1
      LIMIT 1
    `,
    [jobId],
  )
  const job = rows[0]
  if (!job) return null

  const seedIds = Array.isArray(job.seed_url_ids) ? job.seed_url_ids.map(Number) : []
  const { rows: seedRows } = await query(
    `
      SELECT *
      FROM rag_seed_urls
      WHERE id = ANY($1::bigint[])
        AND municipality_id = $2
        AND status = 'active'
      ORDER BY id
    `,
    [seedIds, job.municipality_id],
  )

  return { job, seeds: seedRows }
}

async function updateJob(jobId, fields) {
  const assignments = []
  const params = [jobId]

  for (const [key, value] of Object.entries(fields)) {
    params.push(value)
    assignments.push(key === 'stats' ? `${key} = $${params.length}::jsonb` : `${key} = $${params.length}`)
  }

  if (!assignments.length) return
  await query(
    `
      UPDATE rag_crawl_jobs
      SET ${assignments.join(', ')},
          updated_at = NOW()
      WHERE id = $1
    `,
    params,
  )
}

async function insertIndexItem({ municipalityId, sourceType, sourceId, title, sourceUrl, text, contentHash, metadata }) {
  const normalizedText = stripSpiderBoilerplate(text || '') || compactWhitespace(title || sourceUrl || sourceType || '')
  const { rows: previousRows } = await query(
    `
      SELECT *
      FROM rag_index_items
      WHERE municipality_id = $1
        AND source_type = $2
        AND source_url = $3
      ORDER BY version DESC, indexed_at DESC
      LIMIT 1
    `,
    [municipalityId, sourceType, sourceUrl || null],
  )
  const previous = previousRows[0] || null
  if (previous?.content_hash && previous.content_hash === contentHash) {
    return { row: previous, changed: false, skipped: true }
  }

  const version = previous ? Number(previous.version || 1) + 1 : 1
  const { rows } = await query(
    `
      INSERT INTO rag_index_items
        (municipality_id, source_type, source_id, title, source_url, text, summary, content_hash,
         version, previous_content_hash, previous_text, changed_at, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `,
    [
      municipalityId,
      sourceType,
      sourceId,
      truncate(title || sourceUrl || sourceType, 240),
      sourceUrl || null,
      normalizedText,
      truncate(normalizedText, 420),
      contentHash || null,
      version,
      previous?.content_hash || null,
      previous?.text || null,
      previous ? new Date() : null,
      JSON.stringify(metadata || {}),
    ],
  )
  return { row: rows[0], changed: true, skipped: false }
}

async function extractPdfText(buffer) {
  const pdfParseModule = await import('pdf-parse')
  const parsePdf = pdfParseModule.default || pdfParseModule
  const parsed = await parsePdf(buffer)
  return stripSpiderBoilerplate(parsed?.text || '')
}

async function storeAsset({ job, pageId, asset, seed, stats, artifactDir }) {
  const normalizedUrl = normalizeUrl(asset.url)
  if (!normalizedUrl) return null
  if (!isSameHostname(normalizedUrl, seed.allowed_hostname)) {
    stats.externalSkipped += 1
    return null
  }

  const assetType = asset.type || (isPdfUrl(normalizedUrl) ? 'pdf' : isImageUrl(normalizedUrl) ? 'image' : '')
  if (!['pdf', 'image'].includes(assetType)) return null
  if (assetType === 'pdf' && stats.pdfs >= seed.max_pdfs) return null
  if (assetType === 'image' && stats.images >= seed.max_images) return null

  const response = await fetch(normalizedUrl, {
    signal: AbortSignal.timeout(Math.max(5000, Number(seed.page_timeout_ms || 30000))),
  }).catch((error) => {
    stats.errors += 1
    stats.lastError = error.message
    return null
  })
  if (!response?.ok) return null

  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > seed.max_file_bytes) {
    stats.assetsTooLarge += 1
    return null
  }

  const arrayBuffer = await response.arrayBuffer()
  if (arrayBuffer.byteLength > seed.max_file_bytes) {
    stats.assetsTooLarge += 1
    return null
  }

  const buffer = Buffer.from(arrayBuffer)
  const digest = sha256(buffer)
  const fileName = `${assetType}-${digest.slice(0, 12)}-${safeName(normalizedUrl, assetType)}`
  const filePath = path.join(artifactDir, fileName)
  await fs.writeFile(filePath, buffer)

  const contentType = response.headers.get('content-type') || ''
  let extractedText = ''
  let textStatus = assetType === 'pdf' ? 'pending' : 'metadata-only'
  let textExtractedAt = null
  let extractionError = null
  if (assetType === 'pdf') {
    try {
      extractedText = await extractPdfText(buffer)
      textStatus = extractedText ? 'extracted' : 'empty'
      textExtractedAt = new Date()
    } catch (error) {
      textStatus = 'extract-error'
      extractionError = error.message
      stats.errors += 1
      stats.lastError = error.message
    }
  }

  const { rows } = await query(
    `
      INSERT INTO rag_assets
        (job_id, municipality_id, page_id, url, asset_type, content_type, file_path, sha256,
         size_bytes, text_status, extracted_text, text_extracted_at, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `,
    [
      job.id,
      job.municipality_id,
      pageId,
      normalizedUrl,
      assetType,
      contentType,
      path.relative(projectRoot, filePath).replace(/\\/g, '/'),
      digest,
      buffer.byteLength,
      textStatus,
      extractedText || null,
      textExtractedAt,
      JSON.stringify({ alt: asset.alt || '', context: asset.context || '', extractionError }),
    ],
  )

  if (assetType === 'pdf') stats.pdfs += 1
  if (assetType === 'image') stats.images += 1

  const catalogText = assetType === 'pdf'
    ? extractedText || `${asset.title || safeName(normalizedUrl, 'PDF')}. Documento PDF descargado desde ${asset.pageUrl || 'pagina permitida'}.`
    : `${asset.alt || asset.title || safeName(normalizedUrl, 'imagen')}. ${asset.context || ''}`

  const indexResult = await insertIndexItem({
    municipalityId: job.municipality_id,
    sourceType: assetType,
    sourceId: rows[0].id,
    title: asset.title || asset.alt || safeName(normalizedUrl, assetType),
    sourceUrl: normalizedUrl,
    text: catalogText,
    contentHash: digest,
    metadata: {
      filePath: rows[0].file_path,
      contentType,
      sizeBytes: buffer.byteLength,
      pageId,
    },
  })
  if (indexResult.changed) stats.changedItems += 1
  if (indexResult.skipped) stats.unchangedItems += 1

  return rows[0]
}

async function crawlSeed({ browser, job, seed, context, stats, artifactDir }) {
  const queue = [{ url: normalizeUrl(seed.url), depth: 0 }]
  const visited = new Set()
  const queued = new Set(queue.map((item) => item.url))
  const page = await browser.newPage()
  page.setDefaultTimeout(Number(seed.page_timeout_ms || 30000))
  const seedHashes = []
  const startChangedItems = stats.changedItems
  const startPages = stats.pages
  const startErrors = stats.errors

  try {
    while (queue.length && stats.pages < seed.max_pages && !context.cancelled) {
      const next = queue.shift()
      if (!next?.url || visited.has(next.url)) continue
      visited.add(next.url)
      touchJobContext(context, {
        phase: 'crawling-page',
        message: `Crawling ${next.url}`,
        currentSeedId: Number(seed.id),
        currentSeedUrl: seed.url,
        currentUrl: next.url,
        currentAssetUrl: null,
        queueSize: queue.length,
        visitedCount: visited.size,
        stats,
      })
      await persistJobProgress(job.id, stats, context)

      if (!isSameHostname(next.url, seed.allowed_hostname)) {
        stats.externalSkipped += 1
        touchJobContext(context, {
          message: `Saltando dominio externo ${next.url}`,
          queueSize: queue.length,
          visitedCount: visited.size,
          stats,
        })
        await persistJobProgress(job.id, stats, context)
        continue
      }

      let response = null
      try {
        response = await page.goto(next.url, {
          waitUntil: 'domcontentloaded',
          timeout: Number(seed.page_timeout_ms || 30000),
        })
      } catch (error) {
        stats.errors += 1
        stats.lastError = error.message
        touchJobContext(context, {
          phase: 'page-error',
          message: `Error al abrir ${next.url}: ${error.message}`,
          queueSize: queue.length,
          visitedCount: visited.size,
          stats,
        })
        await persistJobProgress(job.id, stats, context)
        continue
      }

      const payload = await page.evaluate(() => {
        const canonical = document.querySelector('link[rel="canonical"]')?.href || window.location.href
        const bodyText = document.body?.innerText || ''
        const links = Array.from(document.querySelectorAll('a[href]')).map((anchor) => ({
          url: anchor.href,
          title: anchor.textContent || anchor.getAttribute('title') || '',
        }))
        const images = Array.from(document.querySelectorAll('img[src]')).map((image) => ({
          url: image.currentSrc || image.src,
          alt: image.alt || image.getAttribute('aria-label') || '',
          title: image.getAttribute('title') || '',
          context: image.closest('figure')?.innerText || image.parentElement?.innerText || '',
        }))
        return {
          title: document.title || '',
          canonical,
          text: bodyText,
          links,
          images,
        }
      })

      const rawHtml = await page.content()
      const text = stripSpiderBoilerplate(payload.text || '')
      const textBuffer = Buffer.from(text, 'utf8')
      const contentHash = sha256(textBuffer)
      seedHashes.push(contentHash)
      const rawBuffer = Buffer.from(rawHtml || '', 'utf8')
      const rawPath = path.join(artifactDir, `page-${job.id}-${contentHash.slice(0, 14)}.html`)
      const pageTextName = `page-${job.id}-${contentHash.slice(0, 14)}.txt`
      const textPath = path.join(artifactDir, pageTextName)
      await fs.writeFile(rawPath, rawBuffer)
      await fs.writeFile(textPath, textBuffer)

      const { rows } = await query(
        `
          INSERT INTO rag_crawled_pages
            (job_id, municipality_id, seed_url_id, url, canonical_url, title, status_code,
             depth, content_hash, raw_path, text_path, metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          RETURNING *
        `,
        [
          job.id,
          job.municipality_id,
          seed.id,
          next.url,
          normalizeUrl(payload.canonical, next.url),
          truncate(payload.title, 240),
          response?.status() || null,
          next.depth,
          contentHash,
          path.relative(projectRoot, rawPath).replace(/\\/g, '/'),
          path.relative(projectRoot, textPath).replace(/\\/g, '/'),
          JSON.stringify({
            seedUrl: seed.url,
            allowedHostname: seed.allowed_hostname,
            linkCount: payload.links.length,
            imageCount: payload.images.length,
          }),
        ],
      )

      stats.pages += 1
      const indexResult = await insertIndexItem({
        municipalityId: job.municipality_id,
        sourceType: 'html',
        sourceId: rows[0].id,
        title: payload.title || next.url,
        sourceUrl: next.url,
        text,
        contentHash,
        metadata: {
          canonicalUrl: normalizeUrl(payload.canonical, next.url),
          depth: next.depth,
          statusCode: response?.status() || null,
        },
      })
      if (indexResult.changed) stats.changedItems += 1
      if (indexResult.skipped) stats.unchangedItems += 1
      touchJobContext(context, {
        phase: 'page-indexed',
        message: payload.title ? `Pagina indexada: ${payload.title}` : `Pagina indexada: ${next.url}`,
        queueSize: queue.length,
        visitedCount: visited.size,
        stats,
      })
      await persistJobProgress(job.id, stats, context)

      const pdfLinks = payload.links
        .map((link) => ({ ...link, url: normalizeUrl(link.url, next.url), type: 'pdf', pageUrl: next.url }))
        .filter((link) => link.url && isPdfUrl(link.url))
      for (const pdf of pdfLinks) {
        if (context.cancelled) break
        touchJobContext(context, {
          phase: 'downloading-asset',
          message: `Descargando PDF ${pdf.url}`,
          currentAssetUrl: pdf.url,
          queueSize: queue.length,
          visitedCount: visited.size,
          stats,
        })
        await persistJobProgress(job.id, stats, context)
        await storeAsset({ job, pageId: rows[0].id, asset: pdf, seed, stats, artifactDir })
        touchJobContext(context, {
          phase: 'asset-indexed',
          message: `PDF procesado ${pdf.url}`,
          queueSize: queue.length,
          visitedCount: visited.size,
          stats,
        })
        await persistJobProgress(job.id, stats, context)
      }

      const images = payload.images
        .map((image) => ({ ...image, url: normalizeUrl(image.url, next.url), type: 'image', pageUrl: next.url }))
        .filter((image) => image.url && isImageUrl(image.url))
      for (const image of images) {
        if (context.cancelled) break
        touchJobContext(context, {
          phase: 'downloading-asset',
          message: `Descargando imagen ${image.url}`,
          currentAssetUrl: image.url,
          queueSize: queue.length,
          visitedCount: visited.size,
          stats,
        })
        await persistJobProgress(job.id, stats, context)
        await storeAsset({ job, pageId: rows[0].id, asset: image, seed, stats, artifactDir })
        touchJobContext(context, {
          phase: 'asset-indexed',
          message: `Imagen procesada ${image.url}`,
          queueSize: queue.length,
          visitedCount: visited.size,
          stats,
        })
        await persistJobProgress(job.id, stats, context)
      }

      if (next.depth >= seed.max_depth) continue
      for (const link of payload.links) {
        const normalized = normalizeUrl(link.url, next.url)
        if (!normalized) continue
        if (!isSameHostname(normalized, seed.allowed_hostname)) {
          stats.externalSkipped += 1
          continue
        }
        if (isPdfUrl(normalized) || isImageUrl(normalized)) continue
        if (visited.has(normalized) || queued.has(normalized)) continue
        queued.add(normalized)
        queue.push({ url: normalized, depth: next.depth + 1 })
      }
      touchJobContext(context, {
        phase: 'queueing-links',
        message: `Cola actualizada desde ${next.url}`,
        currentAssetUrl: null,
        queueSize: queue.length,
        visitedCount: visited.size,
        stats,
      })
      await persistJobProgress(job.id, stats, context)
    }

    const aggregateHash = seedHashes.length ? sha256(Buffer.from(seedHashes.join('|'), 'utf8')) : seed.last_content_hash
    const changed = Boolean(
      aggregateHash &&
      (!seed.last_content_hash || seed.last_content_hash !== aggregateHash || stats.changedItems > startChangedItems),
    )
    const seedStatus = stats.pages === startPages && stats.errors > startErrors ? 'error' : changed ? 'changed' : 'unchanged'
    await query(
      `
        UPDATE rag_seed_urls
        SET last_checked_at = NOW(),
            last_changed_at = CASE WHEN $2 = 'changed' THEN NOW() ELSE last_changed_at END,
            change_status = $2,
            last_content_hash = COALESCE($3, last_content_hash),
            check_error = CASE WHEN $2 = 'error' THEN $4 ELSE NULL END,
            updated_at = NOW()
        WHERE id = $1
      `,
      [seed.id, seedStatus, aggregateHash, stats.lastError],
    )
    touchJobContext(context, {
      phase: 'seed-completed',
      message: `Seed finalizada: ${seed.url}`,
      currentAssetUrl: null,
      queueSize: queue.length,
      visitedCount: visited.size,
      stats,
    })
    await persistJobProgress(job.id, stats, context)
  } finally {
    await page.close().catch(() => null)
  }
}

async function runCrawlJob(jobId) {
  const context = activeJobs.get(Number(jobId))
  const config = await getJobConfig(jobId)
  if (!config || !config.seeds.length) {
    await updateJob(jobId, {
      status: 'failed',
      finished_at: new Date(),
      error_code: 'rag-seed-url-not-found',
      error_message: 'No hay seeds activas para este job.',
    })
    activeJobs.delete(Number(jobId))
    return
  }

  const stats = {
    pages: 0,
    pdfs: 0,
    images: 0,
    changedItems: 0,
    unchangedItems: 0,
    externalSkipped: 0,
    assetsTooLarge: 0,
    errors: 0,
    lastError: null,
  }
  const artifactDir = path.join(resolveArtifactDir(), `job-${jobId}`)
  await fs.mkdir(artifactDir, { recursive: true })

  let browser = null
  try {
    touchJobContext(context, {
      municipalityId: Number(config.job.municipality_id),
      municipalityName: config.job.municipality_name,
      phase: 'starting',
      message: 'Preparando modulo Mi Muni',
      totalSeeds: config.seeds.length,
      stats,
    })
    await updateJob(jobId, { status: 'running', started_at: new Date(), stats: JSON.stringify(buildPersistedStats(stats, context)) })
    const chromium = await loadChromium()
    browser = await chromium.launch({ headless: true })

    for (const [seedIndex, seed] of config.seeds.entries()) {
      if (context?.cancelled) break
      touchJobContext(context, {
        phase: 'starting-seed',
        message: `Iniciando seed ${seed.url}`,
        currentSeedId: Number(seed.id),
        currentSeedUrl: seed.url,
        currentSeedIndex: seedIndex + 1,
        currentUrl: seed.url,
        currentAssetUrl: null,
        queueSize: 1,
        visitedCount: 0,
        stats,
      })
      await persistJobProgress(jobId, stats, context)
      await crawlSeed({ browser, job: config.job, seed, context, stats, artifactDir })
    }

    touchJobContext(context, {
      phase: context?.cancelled ? 'cancelled' : 'completed',
      message: context?.cancelled ? 'Job cancelado por el desarrollador.' : 'Proceso Mi Muni finalizado.',
      currentUrl: null,
      currentAssetUrl: null,
      queueSize: 0,
      stats,
    })
    await updateJob(jobId, {
      status: context?.cancelled ? 'cancelled' : 'completed',
      finished_at: new Date(),
      stats: JSON.stringify(buildPersistedStats(stats, context)),
      error_code: null,
      error_message: context?.cancelled ? 'Cancelado por el desarrollador.' : null,
    })
  } catch (error) {
    touchJobContext(context, {
      phase: 'failed',
      message: `Fallo el proceso Mi Muni: ${error.message}`,
      stats: { ...stats, lastError: error.message },
    })
    await updateJob(jobId, {
      status: 'failed',
      finished_at: new Date(),
      stats: JSON.stringify(buildPersistedStats({ ...stats, lastError: error.message }, context)),
      error_code: error.code || 'spider-error',
      error_message: error.message,
    })
  } finally {
    if (browser) await browser.close().catch(() => null)
    activeJobs.delete(Number(jobId))
  }
}

const app = express()
app.use(express.json())

app.get('/internal/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'mi-muni',
    activeJobs: activeJobs.size,
    activeJobDetails: [...activeJobs.entries()].map(([jobId, context]) => snapshotActiveJob(jobId, context)),
    polling: false,
    uptimeSeconds: Math.round((Date.now() - bootTime) / 1000),
  })
})

app.post('/internal/rag/jobs/:id/start', async (req, res) => {
  const jobId = Number(req.params.id)
  if (!Number.isFinite(jobId)) {
    return res.status(400).json({ ok: false, error: 'job-id-invalid' })
  }
  if (activeJobs.has(jobId)) {
    return res.status(409).json({ ok: false, error: 'job-already-running' })
  }

  activeJobs.set(jobId, {
    cancelled: false,
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    phase: 'queued',
    message: 'Job recibido por Mi Muni',
    queueSize: 0,
    visitedCount: 0,
    stats: {},
  })
  void runCrawlJob(jobId)
  res.status(202).json({ ok: true, jobId })
})

app.post('/internal/rag/jobs/:id/cancel', async (req, res) => {
  const jobId = Number(req.params.id)
  const context = activeJobs.get(jobId)
  if (context) {
    touchJobContext(context, {
      cancelled: true,
      phase: 'cancelled',
      message: 'Cancelacion solicitada internamente.',
    })
  }

  await updateJob(jobId, {
    status: 'cancelled',
    finished_at: new Date(),
    error_code: null,
    error_message: 'Cancelado por solicitud interna.',
    stats: JSON.stringify(buildPersistedStats(context?.stats || {}, context)),
  }).catch(() => null)
  res.json({ ok: true, jobId, active: Boolean(context) })
})

connectWithRetry()
  .then(() => initSchema())
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Mi Muni listo en 0.0.0.0:${PORT}`)
    })
  })
  .catch((error) => {
    console.error('Failed to start Mi Muni module:', error)
    process.exitCode = 1
  })
