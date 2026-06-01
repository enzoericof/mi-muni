import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import asuncionManualDocs from '../data/manual/asuncionManualDocs.js'
import { query } from './index.js'
import { embedTexts, hasOpenAIAccess, openAIModels } from '../lib/openai.js'
import { compactWhitespace } from '../lib/text.js'

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SNAPSHOTS_PATH = path.join(serverRoot, 'data', 'raw', 'asuncion-snapshots.json')

const DEFAULT_SECTION_ORDER = [
  'descripcion',
  'requisitos',
  'pasos',
  'costos',
  'plazos',
  'lugar_canal',
  'horarios',
  'resultado',
  'observaciones',
]

let cachedAsuncionMunicipalityId = null

function readSectionItems(value) {
  if (!value) return []
  return Array.isArray(value)
    ? value.map((item) => compactWhitespace(String(item)))
    : [compactWhitespace(String(value))]
}

function embeddingToVectorLiteral(embedding) {
  if (!Array.isArray(embedding) || embedding.length !== 1536) return null
  return `[${embedding.map((value) => Number(value) || 0).join(',')}]`
}

async function hasPgVector() {
  try {
    const { rows } = await query(`SELECT to_regtype('vector') AS vector_type`)
    return Boolean(rows[0]?.vector_type)
  } catch {
    return false
  }
}

async function getAsuncionMunicipalityId() {
  if (cachedAsuncionMunicipalityId) return cachedAsuncionMunicipalityId
  const { rows } = await query(`SELECT id FROM rag_municipalities WHERE slug = 'asuncion' LIMIT 1`)
  const municipalityId = Number(rows[0]?.id)
  if (!Number.isFinite(municipalityId)) return null
  cachedAsuncionMunicipalityId = municipalityId
  return municipalityId
}

export async function ensureLegacyRagMunicipalityBindings() {
  const asuncionMunicipalityId = await getAsuncionMunicipalityId()
  if (!asuncionMunicipalityId) return

  await query(
    `
      UPDATE rag_chunks
      SET municipality_id = $1,
          source_type = COALESCE(source_type, 'manual'),
          indexed_at = NOW()
      WHERE municipality_id IS NULL
        AND (
          procedure_id IS NOT NULL
          OR fuente_url ILIKE '%asuncion.gov.py%'
          OR id LIKE '%-snapshot-%'
        )
    `,
    [asuncionMunicipalityId],
  )
}

function buildChunksForProcedure(procedure) {
  const chunks = []

  // Chunk de descripción general (el más importante para búsqueda)
  chunks.push({
    id: `${procedure.id}-descripcion`,
    procedure_id: procedure.id,
    titulo: procedure.titulo,
    text: compactWhitespace(`${procedure.titulo}. ${procedure.descripcion} ${procedure.resumen ?? ''}`),
    seccion: 'descripcion',
    categoria: procedure.categoria,
    tipo: procedure.tipo,
    fuente_titulo: procedure.fuente?.titulo ?? null,
    fuente_url: procedure.fuente?.url ?? null,
    fecha: procedure.fecha ?? null,
  })

  // Un chunk por cada item de cada sección
  for (const [sectionKey, rawValue] of Object.entries(procedure.secciones ?? {})) {
    if (sectionKey === 'descripcion') continue // ya lo incluimos arriba
    const values = readSectionItems(rawValue)
    values.forEach((value, index) => {
      chunks.push({
        id: `${procedure.id}-${sectionKey}-${index}`,
        procedure_id: procedure.id,
        titulo: procedure.titulo,
        text: value,
        seccion: sectionKey,
        categoria: procedure.categoria,
        tipo: procedure.tipo,
        fuente_titulo: procedure.fuente?.titulo ?? null,
        fuente_url: procedure.fuente?.url ?? null,
        fecha: procedure.fecha ?? null,
      })
    })
  }

  return chunks
}

export async function seedRagIfEmpty() {
  const asuncionMunicipalityId = await getAsuncionMunicipalityId()
  const { rows } = await query('SELECT COUNT(*) AS count FROM rag_procedures')
  if (Number(rows[0].count) > 0) {
    console.log('[rag-seed] Procedures already in DB, skipping.')
    await ensureLegacyRagMunicipalityBindings()
    return
  }

  console.log('[rag-seed] Seeding RAG procedures into PostgreSQL...')

  // 1. Insertar procedimientos
  for (const procedure of asuncionManualDocs) {
    await query(
      `INSERT INTO rag_procedures
         (id, titulo, descripcion, resumen, categoria, tipo, fuente_titulo, fuente_url, fecha, secciones, section_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [
        procedure.id,
        procedure.titulo,
        procedure.descripcion ?? null,
        procedure.resumen ?? null,
        procedure.categoria ?? null,
        procedure.tipo ?? null,
        procedure.fuente?.titulo ?? null,
        procedure.fuente?.url ?? null,
        procedure.fecha ?? null,
        JSON.stringify(procedure.secciones ?? {}),
        JSON.stringify(procedure.sectionOrder ?? DEFAULT_SECTION_ORDER),
      ],
    )
  }

  // 2. Construir todos los chunks
  const allChunks = asuncionManualDocs.flatMap(buildChunksForProcedure)

  // 3. Generar embeddings si hay API key de OpenAI disponible
  let embeddings = null
  if (hasOpenAIAccess()) {
    console.log(`[rag-seed] Generando embeddings para ${allChunks.length} chunks via OpenAI...`)
    const texts = allChunks.map((chunk) => `${chunk.titulo}\n${chunk.text}`)
    embeddings = await embedTexts(texts)
    if (embeddings) {
      console.log(`[rag-seed] ${embeddings.length} embeddings generados correctamente.`)
    } else {
      console.warn('[rag-seed] No se pudieron generar embeddings (cuota o error). Se continúa sin ellos.')
    }
  } else {
    console.log('[rag-seed] Sin OPENAI_API_KEY — chunks guardados sin embeddings (solo búsqueda léxica).')
  }

  // 4. Insertar chunks con sus embeddings
  const pgVectorAvailable = await hasPgVector()
  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i]
    const embeddingJson = embeddings?.[i] ? JSON.stringify(embeddings[i]) : null
    const embeddingVector = pgVectorAvailable ? embeddingToVectorLiteral(embeddings?.[i]) : null
    if (pgVectorAvailable) {
      await query(
        `INSERT INTO rag_chunks
           (id, procedure_id, titulo, text, seccion, categoria, tipo, fuente_titulo, fuente_url, fecha,
            embedding, embedding_model, embedding_vector, municipality_id, source_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::vector,$14,$15)
         ON CONFLICT (id) DO NOTHING`,
        [
          chunk.id,
          chunk.procedure_id,
          chunk.titulo,
          chunk.text,
          chunk.seccion,
          chunk.categoria,
          chunk.tipo,
          chunk.fuente_titulo,
          chunk.fuente_url,
          chunk.fecha,
          embeddingJson,
          embeddingJson ? openAIModels.embedding : null,
          embeddingVector,
          asuncionMunicipalityId,
          'manual',
        ],
      )
    } else {
      await query(
        `INSERT INTO rag_chunks
           (id, procedure_id, titulo, text, seccion, categoria, tipo, fuente_titulo, fuente_url, fecha,
            embedding, embedding_model, municipality_id, source_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO NOTHING`,
        [
          chunk.id,
          chunk.procedure_id,
          chunk.titulo,
          chunk.text,
          chunk.seccion,
          chunk.categoria,
          chunk.tipo,
          chunk.fuente_titulo,
          chunk.fuente_url,
          chunk.fecha,
          embeddingJson,
          embeddingJson ? openAIModels.embedding : null,
          asuncionMunicipalityId,
          'manual',
        ],
      )
    }
  }

  await ensureLegacyRagMunicipalityBindings()

  console.log(
    `[rag-seed] Listo: ${asuncionManualDocs.length} procedures, ${allChunks.length} chunks` +
    `${embeddings ? ' con embeddings' : ' sin embeddings'}.`,
  )
}

// Regenera embeddings para todos los chunks que no los tienen aún.
// Útil para correr después de agregar OPENAI_API_KEY en un contenedor ya levantado.
export async function regenerateEmbeddings() {
  if (!hasOpenAIAccess()) {
    console.warn('[rag-seed] OPENAI_API_KEY no disponible. No se pueden generar embeddings.')
    return
  }

  const { rows } = await query('SELECT id, titulo, text FROM rag_chunks WHERE embedding IS NULL')
  if (!rows.length) {
    console.log('[rag-seed] Todos los chunks ya tienen embeddings.')
    return
  }

  console.log(`[rag-seed] Generando embeddings para ${rows.length} chunks sin embedding...`)
  const texts = rows.map((row) => `${row.titulo}\n${row.text}`)
  const embeddings = await embedTexts(texts)
  if (!embeddings) {
    console.error('[rag-seed] Error al generar embeddings.')
    return
  }

  const pgVectorAvailable = await hasPgVector()
  for (let i = 0; i < rows.length; i++) {
    const embeddingJson = JSON.stringify(embeddings[i])
    const embeddingVector = pgVectorAvailable ? embeddingToVectorLiteral(embeddings[i]) : null
    if (pgVectorAvailable) {
      await query(
        `UPDATE rag_chunks
         SET embedding = $1,
             embedding_model = $2,
             embedding_vector = $3::vector,
             indexed_at = NOW()
         WHERE id = $4`,
        [embeddingJson, openAIModels.embedding, embeddingVector, rows[i].id],
      )
    } else {
      await query(
        `UPDATE rag_chunks
         SET embedding = $1,
             embedding_model = $2,
             indexed_at = NOW()
         WHERE id = $3`,
        [embeddingJson, openAIModels.embedding, rows[i].id],
      )
    }
  }

  console.log(`[rag-seed] ${embeddings.length} embeddings actualizados en DB.`)
}

// Siembra los chunks del scraping web (snapshots) en rag_chunks.
// Se corre en cada arranque del servidor para mantener el contenido actualizado.
// Los chunks de snapshot se identifican por procedure_id IS NULL.
export async function seedSnapshotChunks() {
  const asuncionMunicipalityId = await getAsuncionMunicipalityId()
  let snapshots = []
  try {
    const file = await fs.readFile(SNAPSHOTS_PATH, 'utf8')
    snapshots = JSON.parse(file)
  } catch {
    console.log('[rag-seed] Sin archivo de snapshots, saltando seed de snapshots.')
    return
  }

  const valid = snapshots.filter((s) => s.ok && s.blocks?.length)
  if (!valid.length) {
    console.log('[rag-seed] Snapshots vacíos o sin bloques de texto.')
    return
  }

  // Eliminar snapshots viejos y reemplazar con los frescos del scraping
  await query('DELETE FROM rag_chunks WHERE procedure_id IS NULL AND source_item_id IS NULL')

  // Construir chunks desde los bloques de texto de cada snapshot
  const allChunks = []
  for (const snapshot of valid) {
    for (let i = 0; i < snapshot.blocks.length; i++) {
      const block = compactWhitespace(snapshot.blocks[i])
      if (!block || block.length < 30) continue // ignorar bloques muy cortos
      allChunks.push({
        id: `${snapshot.id}-snapshot-${i}`,
        procedure_id: null,
        titulo: snapshot.title || snapshot.titulo || snapshot.id,
        text: block,
        seccion: 'fuente',
        categoria: snapshot.categoria ?? 'institucional',
        tipo: snapshot.tipo ?? 'informacion',
        fuente_titulo: snapshot.title || snapshot.titulo || null,
        fuente_url: snapshot.url || null,
        fecha: snapshot.fetchedAt || null,
      })
    }
  }

  if (!allChunks.length) {
    console.log('[rag-seed] No se encontraron bloques válidos en los snapshots.')
    return
  }

  // Generar embeddings para los chunks del scraping
  let embeddings = null
  if (hasOpenAIAccess()) {
    console.log(`[rag-seed] Generando embeddings para ${allChunks.length} chunks de snapshots...`)
    const texts = allChunks.map((c) => `${c.titulo}\n${c.text}`)
    embeddings = await embedTexts(texts)
  }

  // Insertar con upsert (por si el mismo snapshot se procesa dos veces)
  const pgVectorAvailable = await hasPgVector()
  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i]
    const embeddingJson = embeddings?.[i] ? JSON.stringify(embeddings[i]) : null
    const embeddingVector = pgVectorAvailable ? embeddingToVectorLiteral(embeddings?.[i]) : null
    if (pgVectorAvailable) {
      await query(
        `INSERT INTO rag_chunks
           (id, procedure_id, titulo, text, seccion, categoria, tipo, fuente_titulo, fuente_url, fecha,
            embedding, embedding_model, embedding_vector, municipality_id, source_type, indexed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::vector,$14,$15,NOW())
         ON CONFLICT (id) DO UPDATE
           SET text = EXCLUDED.text,
               embedding = EXCLUDED.embedding,
               embedding_model = EXCLUDED.embedding_model,
               embedding_vector = EXCLUDED.embedding_vector,
               municipality_id = EXCLUDED.municipality_id,
               source_type = EXCLUDED.source_type,
               fecha = EXCLUDED.fecha,
               indexed_at = NOW()`,
        [chunk.id, chunk.procedure_id, chunk.titulo, chunk.text, chunk.seccion,
         chunk.categoria, chunk.tipo, chunk.fuente_titulo, chunk.fuente_url, chunk.fecha,
         embeddingJson, embeddingJson ? openAIModels.embedding : null, embeddingVector,
         asuncionMunicipalityId, 'manual'],
      )
    } else {
      await query(
        `INSERT INTO rag_chunks
           (id, procedure_id, titulo, text, seccion, categoria, tipo, fuente_titulo, fuente_url, fecha,
            embedding, embedding_model, municipality_id, source_type, indexed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
         ON CONFLICT (id) DO UPDATE
           SET text = EXCLUDED.text,
               embedding = EXCLUDED.embedding,
               embedding_model = EXCLUDED.embedding_model,
               municipality_id = EXCLUDED.municipality_id,
               source_type = EXCLUDED.source_type,
               fecha = EXCLUDED.fecha,
               indexed_at = NOW()`,
        [chunk.id, chunk.procedure_id, chunk.titulo, chunk.text, chunk.seccion,
         chunk.categoria, chunk.tipo, chunk.fuente_titulo, chunk.fuente_url, chunk.fecha,
         embeddingJson, embeddingJson ? openAIModels.embedding : null,
         asuncionMunicipalityId, 'manual'],
      )
    }
  }

  await ensureLegacyRagMunicipalityBindings()

  console.log(
    `[rag-seed] Snapshots: ${allChunks.length} chunks de ${valid.length} fuentes` +
    `${embeddings ? ' con embeddings' : ' sin embeddings'}.`,
  )
}
