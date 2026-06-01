import fs from 'node:fs/promises'
import path from 'node:path'
import * as cheerio from 'cheerio'
import '../lib/env.js'
import asuncionSources from '../data/sources/asuncionSources.js'
import { RAW_SNAPSHOTS_PATH } from '../lib/rag.js'
import { compactWhitespace, normalizeText, uniqueStrings } from '../lib/text.js'

function extractSnapshot(html, source) {
  const $ = cheerio.load(html)
  const title =
    compactWhitespace($('meta[property="og:title"]').attr('content') || '') ||
    compactWhitespace($('h1').first().text()) ||
    compactWhitespace($('title').text())

  const rawBlocks = uniqueStrings(
    $('main h1, main h2, main h3, main p, main li, article h1, article h2, article h3, article p, article li')
      .toArray()
      .map((node) => compactWhitespace($(node).text())),
  )

  const blocks = []
  for (const block of rawBlocks) {
    const normalized = normalizeText(block)
    if (!block || block.length <= 30) continue
    if (normalized.includes('leer mas') || normalized.includes('continuar')) break
    if (normalized.startsWith('yuyito') || normalized.startsWith('una calle de asuncion')) break
    blocks.push(block)
    if (blocks.length >= 18) break
  }

  const summary = blocks.slice(0, 2).join(' ')

  return {
    id: source.id,
    titulo: source.titulo,
    title: title || source.titulo,
    url: source.url,
    categoria: source.categoria,
    tipo: source.tipo,
    ok: true,
    fetchedAt: new Date().toISOString(),
    summary,
    blocks,
  }
}

async function fetchSource(source) {
  try {
    const response = await fetch(source.url, {
      headers: {
        'user-agent': 'Mozilla/5.0 municipal-rag-mvp/1.0',
        accept: 'text/html,application/xhtml+xml',
      },
    })

    if (!response.ok) {
      return {
        id: source.id,
        titulo: source.titulo,
        url: source.url,
        categoria: source.categoria,
        tipo: source.tipo,
        ok: false,
        fetchedAt: new Date().toISOString(),
        error: `http-${response.status}`,
        blocks: [],
      }
    }

    const html = await response.text()
    return extractSnapshot(html, source)
  } catch (error) {
    return {
      id: source.id,
      titulo: source.titulo,
      url: source.url,
      categoria: source.categoria,
      tipo: source.tipo,
      ok: false,
      fetchedAt: new Date().toISOString(),
      error: error.message,
      blocks: [],
    }
  }
}

async function main() {
  const snapshots = []

  for (const source of asuncionSources) {
    const snapshot = await fetchSource(source)
    snapshots.push(snapshot)
    console.log(`${snapshot.ok ? 'OK' : 'ERR'} ${source.id} -> ${snapshot.blocks.length} bloques`)
  }

  await fs.mkdir(path.dirname(RAW_SNAPSHOTS_PATH), { recursive: true })
  await fs.writeFile(RAW_SNAPSHOTS_PATH, JSON.stringify(snapshots, null, 2), 'utf8')

  console.log(`Snapshots guardados en ${RAW_SNAPSHOTS_PATH}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
