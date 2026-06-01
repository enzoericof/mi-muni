import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import asuncionSources from '../data/sources/asuncionSources.js'
import { query } from '../db/index.js'
import { embedTexts, generateGroundedAnswer, hasOpenAIAccess, openAIModels } from './openai.js'
import { isRagPublicIndexEnabled } from './ragSpider.js'
import { compactWhitespace, normalizeText, tokenize } from './text.js'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const serverRoot = path.resolve(currentDir, '..')

// Todavía se usa por listSourceStatuses() para mostrar el estado del scraping
export const RAW_SNAPSHOTS_PATH = path.join(serverRoot, 'data', 'raw', 'asuncion-snapshots.json')

// Mantenido por compatibilidad con scripts/buildCorpus.js (ya no se escribe, referencia solamente)
export const GENERATED_CORPUS_PATH = path.join(serverRoot, 'data', 'generated', 'asuncion-corpus.json')

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

const SECTION_LABELS = {
  descripcion: 'Descripción',
  requisitos: 'Requisitos',
  pasos: 'Pasos',
  costos: 'Costos',
  plazos: 'Plazos',
  lugar_canal: 'Canales',
  horarios: 'Horarios',
  resultado: 'Resultado',
  observaciones: 'Observaciones',
}

const QUERY_STOPWORDS = new Set([
  'a',
  'al',
  'como',
  'con',
  'cual',
  'cuales',
  'cuanto',
  'cuantos',
  'de',
  'del',
  'donde',
  'el',
  'en',
  'es',
  'esta',
  'este',
  'hay',
  'la',
  'las',
  'lo',
  'los',
  'me',
  'mi',
  'necesito',
  'para',
  'por',
  'que',
  'quiero',
  'se',
  'si',
  'sin',
  'sobre',
  'su',
  'sus',
  'te',
  'tengo',
  'tramite',
  'tramites',
  'un',
  'una',
  'uno',
  'unos',
  'unas',
  'ver',
  'ya',
  'yo',
])

const SECTION_RELEVANCE_BOOST = Object.freeze({
  descripcion: 6,
  requisitos: 5,
  pasos: 4,
  lugar_canal: 4,
  costos: 3,
  resultado: 3,
  plazos: 2,
  horarios: 1,
  observaciones: 0,
  fuente: -1,
})

const STEM_SUFFIXES = [
  'aciones',
  'amiento',
  'amientos',
  'adoras',
  'adores',
  'adora',
  'ador',
  'idades',
  'idad',
  'mente',
  'ancias',
  'ancia',
  'logias',
  'logia',
  'ucion',
  'uciones',
  'siones',
  'sion',
  'ciones',
  'cion',
  'ario',
  'aria',
  'arios',
  'arias',
  'ados',
  'adas',
  'ado',
  'ada',
  'idos',
  'idas',
  'ido',
  'ida',
  'ico',
  'ica',
  'icos',
  'icas',
  'al',
  'es',
  'ar',
  'er',
  'ir',
  's',
]

// ---------------------------------------------------------------------------
// Helpers de mapeo DB → objeto en memoria
// ---------------------------------------------------------------------------

function rowToProcedure(row) {
  return {
    id: row.id,
    titulo: row.titulo,
    descripcion: row.descripcion ?? '',
    resumen: row.resumen ?? '',
    categoria: row.categoria ?? 'general',
    tipo: row.tipo ?? 'informacion',
    fuente: {
      titulo: row.fuente_titulo ?? '',
      url: row.fuente_url ?? null,
    },
    fecha: row.fecha ?? null,
    secciones: row.secciones ?? {},
    sectionOrder: Array.isArray(row.section_order) ? row.section_order : DEFAULT_SECTION_ORDER,
  }
}

function rowToChunk(row) {
  return {
    id: row.id,
    procedureId: row.procedure_id ?? null,
    titulo: row.titulo ?? '',
    text: row.text ?? '',
    seccion: row.seccion ?? 'descripcion',
    categoria: row.categoria ?? 'general',
    tipo: row.tipo ?? 'informacion',
    fuente: {
      titulo: row.fuente_titulo ?? '',
      url: row.fuente_url ?? null,
    },
    fecha: row.fecha ?? null,
    municipalityId: row.municipality_id ? Number(row.municipality_id) : null,
    municipalityName: row.municipality_name ?? null,
    sourceType: row.source_type ?? null,
    sourceItemId: row.source_item_id ? Number(row.source_item_id) : null,
    contentHash: row.content_hash ?? null,
    embeddingModel: row.embedding_model ?? null,
    indexedAt: row.indexed_at ? new Date(row.indexed_at).toISOString() : null,
    // embedding guardado como JSON string en TEXT, parseado aquí
    embedding: parseEmbedding(row.embedding),
  }
}

function rowToMunicipality(row) {
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    primaryDomain: row.primary_domain || '',
    sourceName: row.source_name || '',
    sourceUrl: row.source_url || '',
  }
}

// ---------------------------------------------------------------------------
// Utilidades de texto y scoring
// ---------------------------------------------------------------------------

function truncateText(value = '', maxLength = 240) {
  if (!value || value.length <= maxLength) return value
  return `${value.slice(0, maxLength - 3).trimEnd()}...`
}

function normalizeQueryTokens(queryTokens = []) {
  return [...new Set(
    queryTokens
      .map((token) => normalizeText(token))
      .filter((token) => token && token.length > 1 && !QUERY_STOPWORDS.has(token)),
  )]
}

function simplifyToken(token = '') {
  let normalized = normalizeText(token)
  if (normalized.length <= 4) return normalized

  for (const suffix of STEM_SUFFIXES) {
    if (normalized.endsWith(suffix) && normalized.length - suffix.length >= 5) {
      normalized = normalized.slice(0, -suffix.length)
      break
    }
  }

  return normalized
}

function scoreTokenAgainstWords(token, haystackWords = []) {
  if (!token || !haystackWords.length) return 0

  if (haystackWords.includes(token)) {
    return token.length >= 8 ? 10 : token.length >= 5 ? 8 : 5
  }

  const simplifiedToken = simplifyToken(token)
  for (const word of haystackWords) {
    if (!word) continue

    if ((token.length >= 5 && word.startsWith(token)) || (word.length >= 5 && token.startsWith(word))) {
      return 6
    }

    const simplifiedWord = simplifyToken(word)
    if (
      simplifiedToken.length >= 5
      && (
        simplifiedWord === simplifiedToken
        || simplifiedWord.startsWith(simplifiedToken)
        || simplifiedToken.startsWith(simplifiedWord)
      )
    ) {
      return 5
    }
  }

  return 0
}

function normalizeMunicipalitySlug(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function hostnameFromUrl(value = '') {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    return new URL(normalized).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function parseEmbedding(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
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

function cosineSimilarity(left = [], right = []) {
  if (!left.length || !right.length || left.length !== right.length) return 0

  let dot = 0
  let normLeft = 0
  let normRight = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    normLeft += left[index] * left[index]
    normRight += right[index] * right[index]
  }

  if (!normLeft || !normRight) return 0
  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight))
}

function scoreText(queryTokens, haystack, { exactBoost = 0 } = {}) {
  const normalizedTokens = normalizeQueryTokens(queryTokens)
  const normalizedHaystack = normalizeText(haystack)
  if (!normalizedHaystack || !normalizedTokens.length) return 0
  const normalizedQuery = normalizedTokens.join(' ')
  const haystackWords = [...new Set(tokenize(normalizedHaystack))]

  let score = 0
  if (normalizedQuery && normalizedHaystack.includes(normalizedQuery)) {
    score += exactBoost
  }

  for (const token of normalizedTokens) {
    score += scoreTokenAgainstWords(token, haystackWords)
  }

  return score
}

function readSectionItems(value) {
  if (!value) return []
  return Array.isArray(value) ? value.map((item) => compactWhitespace(String(item))) : [compactWhitespace(String(value))]
}

function filterProcedure(procedure, filters) {
  const { categoria = 'all', tipo = 'all', seccion = 'all', onlyOfficialSource = false } = filters

  if (categoria !== 'all' && procedure.categoria !== categoria) return false
  if (tipo !== 'all' && procedure.tipo !== tipo) return false
  if (seccion !== 'all' && !procedure.secciones?.[seccion] && seccion !== 'descripcion') return false
  if (onlyOfficialSource && !procedure.fuente?.url?.includes('asuncion.gov.py')) return false

  return true
}

function scoreProcedureLexical(procedure, queryTokens, sectionFilter) {
  const titleScore = scoreText(queryTokens, procedure.titulo, { exactBoost: 14 })
  const descriptionScore = scoreText(queryTokens, `${procedure.descripcion} ${procedure.resumen ?? ''}`, { exactBoost: 10 })

  let sectionScore = 0
  for (const [sectionKey, rawValue] of Object.entries(procedure.secciones ?? {})) {
    if (sectionFilter !== 'all' && sectionFilter !== sectionKey) continue
    const values = readSectionItems(rawValue)
    sectionScore += scoreText(queryTokens, values.join(' '), { exactBoost: 6 })
  }

  return titleScore + descriptionScore + sectionScore
}

function scoreChunkLexical(chunk, queryTokens) {
  let score = scoreText(queryTokens, `${chunk.titulo} ${chunk.text}`, { exactBoost: 8 })
  if (chunk.fuente?.url?.includes('asuncion.gov.py')) score += 2
  if (chunk.seccion === 'fuente') score += 1
  if (chunk.procedureId) score += 1
  score += SECTION_RELEVANCE_BOOST[chunk.seccion] ?? 0
  return score
}

function isSpiderChunk(chunk) {
  return Number.isFinite(Number(chunk?.sourceItemId))
}

function getStrongQueryTokens(queryTokens = []) {
  return normalizeQueryTokens(queryTokens).filter((token) => token.length >= 5)
}

function countChunkStrongTokenMatches(chunk, queryTokens = []) {
  const strongTokens = getStrongQueryTokens(queryTokens)
  if (!strongTokens.length) return 0

  const haystackWords = [...new Set(tokenize(normalizeText(`${chunk?.titulo || ''} ${chunk?.text || ''}`)))]
  let matches = 0
  for (const token of strongTokens) {
    if (scoreTokenAgainstWords(token, haystackWords) > 0) {
      matches += 1
    }
  }
  return matches
}

function rankProceduresForQuery(procedures, queryTokens, evidence = [], sectionFilter = 'all') {
  const bestChunkScoreByProcedure = new Map()
  for (const { chunk, score } of evidence) {
    if (!chunk?.procedureId) continue
    const current = bestChunkScoreByProcedure.get(chunk.procedureId) ?? 0
    if (score > current) bestChunkScoreByProcedure.set(chunk.procedureId, score)
  }

  return procedures
    .map((procedure) => {
      const lexicalScore = scoreProcedureLexical(procedure, queryTokens, sectionFilter)
      const chunkScore = bestChunkScoreByProcedure.get(procedure.id) ?? 0
      return {
        procedure,
        lexicalScore,
        chunkScore,
        score: lexicalScore + chunkScore,
      }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
}

function getProcedureSuggestedSection(procedure) {
  return (
    procedure?.sectionOrder?.find((sectionKey) => {
      if (sectionKey === 'descripcion') return true
      return Boolean(procedure.secciones?.[sectionKey])
    }) || null
  )
}

function buildProcedureFallbackReply(query_, procedure, municipality) {
  const suggestedSection = getProcedureSuggestedSection(procedure)
  const action =
    readSectionItems(procedure.secciones?.pasos)?.[0]
    || readSectionItems(procedure.secciones?.lugar_canal)?.[0]
    || readSectionItems(procedure.secciones?.requisitos)?.[0]
    || 'Abri la ficha del tramite para ver los requisitos, pasos y canales disponibles.'

  return {
    query: query_,
    title: procedure.titulo,
    summary: procedure.resumen || procedure.descripcion || 'Encontre una ficha municipal relacionada a tu consulta.',
    action,
    source: procedure.fuente?.titulo ?? getMunicipalitySourceLabel(municipality),
    sourceUrl: procedure.fuente?.url ?? getMunicipalitySourceUrl(municipality),
    suggestedSection,
    relatedProcedureId: procedure.id,
    citations: [],
    grounded: false,
    model: null,
  }
}

function getProcedureActionFallback(procedure) {
  return (
    readSectionItems(procedure?.secciones?.pasos)?.[0]
    || readSectionItems(procedure?.secciones?.lugar_canal)?.[0]
    || readSectionItems(procedure?.secciones?.resultado)?.[0]
    || readSectionItems(procedure?.secciones?.requisitos)?.[0]
    || null
  )
}

function getAssistantSummaryFallback(topChunk, topProcedure) {
  if (topChunk?.text && !['observaciones', 'horarios', 'fuente'].includes(topChunk.seccion)) {
    return topChunk.text
  }
  return topProcedure?.resumen || topProcedure?.descripcion || topChunk?.text || 'No se encontrÃ³ una coincidencia clara en el corpus actual.'
}

function sortAssistantEvidence(evidence = [], topProcedureId = null) {
  return [...evidence].sort((left, right) => {
    const leftScore =
      Number(left?.score || 0)
      + (left?.chunk?.procedureId === topProcedureId ? 12 : 0)
      + (SECTION_RELEVANCE_BOOST[left?.chunk?.seccion] ?? 0)
    const rightScore =
      Number(right?.score || 0)
      + (right?.chunk?.procedureId === topProcedureId ? 12 : 0)
      + (SECTION_RELEVANCE_BOOST[right?.chunk?.seccion] ?? 0)

    return rightScore - leftScore
  })
}

// ---------------------------------------------------------------------------
// Recuperación de chunks relevantes (léxica + semántica)
// ---------------------------------------------------------------------------

async function retrieveRelevantChunks(query_, procedures, chunks, limit = 5, { useEmbeddings = false } = {}) {
  const queryTokens = tokenize(query_)
  const dbCandidates = await retrieveDbChunkCandidates(query_, chunks, limit * 6, { useEmbeddings })
  const candidateChunks = dbCandidates.length ? dbCandidates : chunks
  let queryEmbedding = null
  if (useEmbeddings && hasOpenAIAccess() && candidateChunks.some((chunk) => chunk.embedding?.length)) {
    try {
      queryEmbedding = (await embedTexts([query_]))?.[0] ?? null
    } catch (error) {
      console.warn(`[rag] No se pudo generar el embedding de la consulta. Se continua en modo lexical. ${error?.message || ''}`.trim())
      queryEmbedding = null
    }
  }

  const ranked = candidateChunks
    .map((chunk) => {
      const lexicalScore = scoreChunkLexical(chunk, queryTokens)
      const embeddingScore = queryEmbedding && chunk.embedding?.length
        ? cosineSimilarity(queryEmbedding, chunk.embedding) * 20
        : 0
      const dbHybridScore = Number(chunk.hybridScore || 0)
      const procedureBoost = procedures.some((procedure) => procedure.id === chunk.procedureId) ? 1 : 0

      return {
        chunk,
        score: lexicalScore + embeddingScore + dbHybridScore + procedureBoost,
      }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)

  return ranked
}

async function retrieveDbChunkCandidates(query_, chunks, limit = 30, { useEmbeddings = false } = {}) {
  const normalizedQuery = compactWhitespace(query_)
  if (!normalizedQuery || !chunks.length) return []

  const allowedIds = chunks.map((chunk) => chunk.id).filter(Boolean)
  if (!allowedIds.length) return []

  const candidates = new Map()
  const candidateLimit = Math.max(limit, 10)
  const addRows = (rows = []) => {
    for (const row of rows) {
      const chunk = rowToChunk(row)
      const lexicalRank = Number(row.lexical_rank || 0)
      const vectorSimilarity = Number(row.vector_similarity || 0)
      const existing = candidates.get(chunk.id)
      const hybridScore = Math.max(existing?.hybridScore || 0, lexicalRank * 18 + vectorSimilarity * 16)
      candidates.set(chunk.id, {
        ...(existing || chunk),
        ...chunk,
        hybridScore,
      })
    }
  }

  try {
    const { rows } = await query(
      `
        SELECT c.*, m.name AS municipality_name,
               ts_rank_cd(c.search_vector, websearch_to_tsquery('spanish', $1)) AS lexical_rank,
               0::double precision AS vector_similarity
        FROM rag_chunks c
        LEFT JOIN rag_municipalities m ON m.id = c.municipality_id
        WHERE c.id = ANY($2::text[])
          AND c.search_vector @@ websearch_to_tsquery('spanish', $1)
        ORDER BY lexical_rank DESC, c.indexed_at DESC
        LIMIT $3
      `,
      [normalizedQuery, allowedIds, candidateLimit],
    )
    addRows(rows)
  } catch {
    // Older local DBs may not have search_vector yet. In-memory lexical scoring remains the fallback.
  }

  let queryEmbedding = null
  if (useEmbeddings && hasOpenAIAccess()) {
    try {
      queryEmbedding = (await embedTexts([normalizedQuery]))?.[0] ?? null
    } catch (error) {
      console.warn(`[rag] No se pudo generar el embedding de busqueda DB. Se continua en modo lexical. ${error?.message || ''}`.trim())
      queryEmbedding = null
    }
  }

  const vectorLiteral = embeddingToVectorLiteral(queryEmbedding)
  if (vectorLiteral) {
    try {
      const { rows } = await query(
        `
          SELECT c.*, m.name AS municipality_name,
                 0::double precision AS lexical_rank,
                 (1 - (c.embedding_vector <=> $1::vector))::double precision AS vector_similarity
          FROM rag_chunks c
          LEFT JOIN rag_municipalities m ON m.id = c.municipality_id
          WHERE c.id = ANY($2::text[])
            AND c.embedding_vector IS NOT NULL
          ORDER BY c.embedding_vector <=> $1::vector
          LIMIT $3
        `,
        [vectorLiteral, allowedIds, candidateLimit],
      )
      addRows(rows)
    } catch {
      // pgvector is optional. JSON embeddings or pure lexical scoring cover this case.
    }
  }

  return Array.from(candidates.values())
}

// ---------------------------------------------------------------------------
// Detección de intención conversacional
// ---------------------------------------------------------------------------

const GREETINGS = ['hola', 'buen dia', 'buenos dias', 'buenas tardes', 'buenas noches', 'buenas', 'hi', 'hello', 'hey', 'que tal', 'qué tal', 'como estas', 'cómo estás']
const THANKS = ['gracias', 'muchas gracias', 'ok gracias', 'perfecto gracias', 'thanks', 'te agradezco']
const FAREWELLS = ['chau', 'adios', 'adiós', 'hasta luego', 'bye', 'hasta pronto', 'nos vemos']
const CAPABILITIES = ['que podes hacer', 'qué podés hacer', 'para que sirves', 'para qué servís', 'que sos', 'qué sos', 'como funciona', 'cómo funciona', 'en que ayudas', 'en qué ayudás', 'que haces', 'qué hacés', 'ayuda', 'menu', 'menú', 'opciones']

function getMunicipalityDisplayName(municipality) {
  return municipality?.name || 'Asuncion'
}

function getMunicipalitySourceLabel(municipality) {
  if (municipality?.name) return `Municipalidad de ${municipality.name}`
  return municipality?.sourceName || 'Municipalidad'
}

function getMunicipalitySourceUrl(municipality) {
  return municipality?.primaryDomain || municipality?.sourceUrl || null
}

function buildMunicipalContext(municipality) {
  return `Soy Munita, la IA de Mi Muni. Estoy para orientarte sobre tramites, servicios, reclamos, centros municipales, licencias, patentes, habilitaciones y consultas frecuentes de ${getMunicipalityDisplayName(municipality)}.`
}
const OUT_OF_SCOPE_GOVERNMENT_TOPICS = [
  'cedula',
  'cedula de identidad',
  'identidad civil',
  'pasaporte',
  'registro civil',
  'certificado de nacimiento',
  'acta de nacimiento',
  'certificado de matrimonio',
  'antecedente policial',
  'antecedentes policiales',
  'antecedente judicial',
  'antecedentes judiciales',
]

function detectIntent(query) {
  const q = query.trim().toLowerCase().replace(/[¿?¡!.,]/g, '')
  if (GREETINGS.some((g) => q === g || q === `${g}!` || q === `${g}.`)) return 'greeting'
  if (THANKS.some((t) => q.includes(t))) return 'thanks'
  if (FAREWELLS.some((f) => q === f || q.startsWith(`${f} `))) return 'farewell'
  if (CAPABILITIES.some((c) => q.includes(c))) return 'capabilities'
  return null
}

function detectOutOfScopeGovernmentTopic(query) {
  const q = normalizeText(query)
  return OUT_OF_SCOPE_GOVERNMENT_TOPICS.find((topic) => q.includes(topic)) || null
}

function isOfficialMunicipalitySource(url, municipality) {
  const sourceHost = hostnameFromUrl(url)
  const officialHost = hostnameFromUrl(municipality?.primaryDomain || municipality?.sourceUrl || '')
  if (!sourceHost || !officialHost) return false
  return sourceHost === officialHost || sourceHost.endsWith(`.${officialHost}`) || officialHost.endsWith(`.${sourceHost}`)
}

function buildOutOfScopeReply(topic, municipality) {
  const topicLabel = topic.includes('cedula') ? 'la cedula de identidad' : `ese tramite (${topic})`
  return {
    title: 'Fuera del ambito municipal',
    summary: `Eso no parece corresponder a la Municipalidad de ${getMunicipalityDisplayName(municipality)}. Yo puedo ayudarte con tramites y servicios municipales, pero ${topicLabel} normalmente depende de otra institucion del gobierno nacional, asi que no quiero darte una indicacion incorrecta.`,
    action: 'Te conviene consultar la fuente oficial del organismo correspondiente del Gobierno de Paraguay o llamar a sus canales de atencion antes de iniciar el tramite.',
    source: null,
    sourceUrl: null,
    suggestedSection: null,
    relatedProcedureId: null,
    citations: [],
    grounded: false,
    model: null,
  }
}

function buildConversationalReply(intent, municipality) {
  const municipalContext = buildMunicipalContext(municipality)
  const sourceLabel = getMunicipalitySourceLabel(municipality)
  const sourceUrl = getMunicipalitySourceUrl(municipality)
  if (intent === 'greeting' || intent === 'capabilities') {
    return {
      title: 'Munita',
      summary: intent === 'greeting'
        ? `Hola. ${municipalContext} Preguntame como le preguntarias a una persona: puedo ayudarte a entender requisitos, pasos, canales, costos u horarios cuando esten disponibles en las fuentes.`
        : `${municipalContext} Puedo responder en lenguaje natural y ayudarte a convertir una duda medio desordenada en una orientacion concreta: que preparar, donde revisar, que paso sigue y que datos conviene confirmar en la fuente oficial.`,
      action: intent === 'greeting'
        ? 'Contame que queres hacer y te guio con el siguiente paso.'
        : 'Haceme una pregunta concreta, por ejemplo sobre licencia, patente, habilitacion, reclamos o centros municipales.',
      source: sourceLabel,
      sourceUrl,
      suggestedSection: null,
      relatedProcedureId: null,
      citations: [],
      grounded: false,
      model: null,
    }
  }

  const map = {
    greeting: {
      title: 'Munita',
      summary: 'Hola. Soy Munita, la asistente virtual de Mi Muni. Puedo ayudarte con información sobre trámites: licencia de conducir, habilitación comercial, patentes, reclamos, centros municipales y más.',
      action: 'Escribí tu consulta y te oriento. Por ejemplo: "¿Qué necesito para renovar la licencia?" o "¿Cómo habilito un negocio?"',
    },
    thanks: {
      title: 'Munita',
      summary: 'Con gusto. Si necesitás información sobre otro trámite municipal, estoy disponible.',
      action: 'Podés consultarme sobre licencias, habilitaciones, patentes, reclamos, centros y más.',
    },
    farewell: {
      title: 'Munita',
      summary: 'Hasta luego. Si en otro momento necesitás información sobre trámites municipales, podés volver cuando quieras.',
      action: '',
    },
    capabilities: {
      title: 'Munita',
      summary: 'Soy Munita, la asistente virtual de Mi Muni. Puedo orientarte sobre trámites municipales: requisitos, pasos, costos, horarios y canales de atención para licencias, habilitaciones comerciales, patentes e impuestos, reclamos y expedientes, y centros municipales.',
      action: 'Hacé tu consulta en lenguaje natural. Por ejemplo: "¿Cuánto cuesta renovar la licencia?" o "¿Dónde pago la patente?"',
    },
  }

  const r = map[intent]
  return {
    title: r.title,
    summary: r.summary,
    action: r.action,
    source: sourceLabel,
    sourceUrl,
    suggestedSection: null,
    relatedProcedureId: null,
    citations: [],
    grounded: false,
    model: null,
  }
}

function buildNoMunicipalityContextReply(query_, municipality) {
  const municipalityName = getMunicipalityDisplayName(municipality)
  return {
    query: query_,
    title: `Sin fuentes suficientes para ${municipalityName}`,
    summary: `Todavía no tengo fuentes aprobadas ni fragmentos indexados para ${municipalityName}. Para responder con precisión necesito contenido proveniente de sus seeds, ya procesado por el spider y reconstruido dentro del índice del asistente.`,
    action: 'Revisa las seeds de esa municipalidad, ejecuta el crawl manual y luego reconstruye el indice aprobado antes de volver a consultar.',
    source: getMunicipalitySourceLabel(municipality),
    sourceUrl: getMunicipalitySourceUrl(municipality),
    suggestedSection: null,
    relatedProcedureId: null,
    citations: [],
    grounded: false,
    model: null,
  }
}

// Generación de respuesta del asistente
// ---------------------------------------------------------------------------

async function createAssistantReply(query_, procedures, chunks, options = {}) {
  const municipality = options.municipality || null
  const runtimeConfig = options.runtimeConfig || {}
  const scope = options.scope || {}

  const intent = detectIntent(query_)
  if (intent) return buildConversationalReply(intent, municipality)

  const outOfScopeTopic = detectOutOfScopeGovernmentTopic(query_)
  if (outOfScopeTopic) return buildOutOfScopeReply(outOfScopeTopic, municipality)

  if (scope.strictMunicipalityScope && scope.municipality && !chunks.length) {
    return buildNoMunicipalityContextReply(query_, scope.municipality)
  }

  const queryTokens = normalizeQueryTokens(tokenize(query_))
  const lexicalProcedures = rankProceduresForQuery(procedures, queryTokens, [], 'all')
  const spiderChunks = chunks.filter(isSpiderChunk)
  const assistantChunkLimit = Math.max(1, Number(runtimeConfig.assistantChunkLimit || 10))
  const useEmbeddings = runtimeConfig.assistantUseEmbeddings !== false
  const minRelevanceScore = Number(runtimeConfig.assistantMinRelevanceScore || 5)

  // Prioriza evidencia publicada del spider; si no alcanza, recien cae al corpus manual.
  const spiderEvidence = spiderChunks.length
    ? await retrieveRelevantChunks(query_, [], spiderChunks, assistantChunkLimit, { useEmbeddings })
    : []
  const shouldPreferSpiderEvidence = spiderEvidence.length && spiderEvidence[0].score >= minRelevanceScore

  // Búsqueda híbrida (léxica + embeddings) para el asistente
  const evidence = shouldPreferSpiderEvidence
    ? spiderEvidence
    : await retrieveRelevantChunks(query_, procedures, chunks, assistantChunkLimit, { useEmbeddings })
  const rankedProcedures = rankProceduresForQuery(procedures, queryTokens, evidence, 'all')

  // Si el puntaje del mejor chunk es muy bajo, la consulta no tiene relación con temas municipales
  if (!evidence.length || evidence[0].score < minRelevanceScore) {
    const bestLexicalProcedure = lexicalProcedures[0]
    if (bestLexicalProcedure?.lexicalScore >= 10) {
      return buildProcedureFallbackReply(query_, bestLexicalProcedure.procedure, municipality)
    }
    return {
      query: query_,
      title: 'No encontré resultados',
      summary: `No tengo informacion suficiente sobre eso en el contexto municipal de ${getMunicipalityDisplayName(municipality)}. Solo puedo orientarte con base en las fuentes municipales y el contenido que ya fue indexado para esa municipalidad.`,
      action: 'Intenta con algo mas especifico, por ejemplo: "renovar licencia de conducir", "habilitar un negocio" o "pagar patente comercial".',
      source: getMunicipalitySourceLabel(municipality),
      sourceUrl: getMunicipalitySourceUrl(municipality),
      suggestedSection: null,
      relatedProcedureId: null,
      citations: [],
      grounded: false,
      model: null,
    }
  }

  const evidenceWithStrongMatches = evidence.map((item) => ({
    ...item,
    strongTokenMatches: countChunkStrongTokenMatches(item.chunk, queryTokens),
  }))
  const officialEvidence = evidenceWithStrongMatches.filter(({ chunk }) => isOfficialMunicipalitySource(chunk.fuente?.url, municipality))
  let topProcedure = shouldPreferSpiderEvidence ? null : rankedProcedures[0]?.procedure ?? lexicalProcedures[0]?.procedure ?? null
  const evidencePool = officialEvidence.length ? officialEvidence : evidenceWithStrongMatches
  const selectedEvidence = sortAssistantEvidence([
    ...evidencePool.filter(({ chunk }) => topProcedure && chunk.procedureId === topProcedure.id),
    ...evidencePool.filter(({ chunk }) => !topProcedure || chunk.procedureId !== topProcedure.id),
  ], topProcedure?.id)
    .filter((item, index, collection) => collection.findIndex((candidate) => candidate.chunk.id === item.chunk.id) === index)
    .slice(0, 4)

  const topEvidenceStrongMatches = Number(selectedEvidence[0]?.strongTokenMatches || 0)
  const requiresStrongEvidence = getStrongQueryTokens(queryTokens).length > 0
  if (requiresStrongEvidence && topEvidenceStrongMatches === 0) {
    const bestLexicalProcedure = lexicalProcedures[0]
    if (bestLexicalProcedure?.lexicalScore >= 10) {
      return buildProcedureFallbackReply(query_, bestLexicalProcedure.procedure, municipality)
    }
    return {
      query: query_,
      title: 'No encontré evidencia suficiente',
      summary: `No encontré evidencia municipal suficientemente relacionada con esa consulta dentro de ${getMunicipalityDisplayName(municipality)}. Prefiero no confirmarlo con una fuente que no trata realmente ese tema.`,
      action: 'Prueba con más detalle sobre el tema exacto o revisa noticias, deportes o resoluciones oficiales de esa municipalidad para confirmar el evento.',
      source: getMunicipalitySourceLabel(municipality),
      sourceUrl: getMunicipalitySourceUrl(municipality),
      suggestedSection: null,
      relatedProcedureId: null,
      citations: [],
      grounded: false,
      model: null,
    }
  }

  if (!topProcedure && selectedEvidence[0]?.chunk?.procedureId) {
    topProcedure = procedures.find((procedure) => procedure.id === selectedEvidence[0].chunk.procedureId) ?? null
  }
  if (!topProcedure && !shouldPreferSpiderEvidence) {
    topProcedure = procedures[0] ?? null
  }

  const topChunk = selectedEvidence[0]?.chunk ?? null
  const secondChunk = selectedEvidence[1]?.chunk ?? null
  const evidenceCitations = selectedEvidence.map(({ chunk }) => ({
    id: chunk.id,
    titulo: chunk.fuente?.titulo || chunk.titulo,
    url: chunk.fuente?.url || null,
    seccion: chunk.seccion,
    municipalityId: chunk.municipalityId,
    municipalityName: chunk.municipalityName || getMunicipalityDisplayName(municipality),
    sourceType: chunk.sourceType,
    updatedAt: chunk.indexedAt || chunk.fecha || null,
    texto: truncateText(chunk.text, 220),
  }))
  const citations = evidenceCitations.slice(0, 1)

  const generated = evidenceCitations.length
    ? await generateGroundedAnswer({
        query: query_,
        citations: evidenceCitations,
        fallbackTitle: topChunk?.titulo ?? topProcedure?.titulo ?? 'Consulta municipal',
        municipality,
      }).catch(() => null)
    : null

  const suggestedSection =
    (topChunk?.seccion && topChunk.seccion !== 'fuente' ? topChunk.seccion : null) ||
    getProcedureSuggestedSection(topProcedure)

  return {
    query: query_,
    title: generated?.title ?? topChunk?.titulo ?? topProcedure?.titulo ?? 'Consulta municipal',
    summary: generated?.summary || getAssistantSummaryFallback(topChunk, topProcedure),
    action:
      generated?.action ||
      getProcedureActionFallback(topProcedure) ||
      secondChunk?.text ||
      (topChunk?.fuente?.url ? `Revisa la fuente oficial en ${topChunk.fuente.url}.` : null) ||
      (topProcedure
        ? `Puedes abrir la ficha de ${topProcedure.titulo} para ver la información organizada por secciones.`
        : 'Prueba con una consulta más concreta, por ejemplo licencia, habilitación, patente, reclamos o centros.'),
    source: topChunk?.fuente?.titulo ?? topProcedure?.fuente?.titulo ?? getMunicipalitySourceLabel(municipality),
    sourceUrl: topChunk?.fuente?.url ?? topProcedure?.fuente?.url ?? getMunicipalitySourceUrl(municipality),
    suggestedSection,
    relatedProcedureId: topProcedure?.id ?? null,
    citations,
    grounded: Boolean(citations.length),
    model: generated?.model ?? null,
  }
}

async function createProcedureSectionAnswer({ procedure, section, chunks, procedures }) {
  const sectionLabel = SECTION_LABELS[section] ?? section
  const sectionQuery = `${procedure.titulo} ${sectionLabel} ${procedure.resumen ?? procedure.descripcion}`
  const relatedChunks = chunks.filter(
    (chunk) => chunk.procedureId === procedure.id || chunk.categoria === procedure.categoria || chunk.fuente?.url?.includes('asuncion.gov.py'),
  )

  const evidence = await retrieveRelevantChunks(sectionQuery, procedures, relatedChunks, 6, { useEmbeddings: false })
  const exactProcedureEvidence = evidence.filter(({ chunk }) => chunk.procedureId === procedure.id && chunk.seccion === section)
  const contextualProcedureEvidence = evidence.filter(
    ({ chunk }) => chunk.procedureId === procedure.id && ['descripcion', 'observaciones'].includes(chunk.seccion),
  )
  const fallbackEvidence = evidence.filter(({ chunk }) => chunk.procedureId === procedure.id || chunk.seccion === section)

  const selectedEvidence = [...exactProcedureEvidence, ...contextualProcedureEvidence, ...fallbackEvidence]
    .filter((item, index, collection) => collection.findIndex((candidate) => candidate.chunk.id === item.chunk.id) === index)
    .slice(0, 4)

  const citations = selectedEvidence.map(({ chunk }) => ({
    id: chunk.id,
    titulo: chunk.fuente?.titulo || chunk.titulo,
    url: chunk.fuente?.url || null,
    seccion: chunk.seccion,
    municipalityId: chunk.municipalityId,
    municipalityName: chunk.municipalityName || 'Asuncion',
    sourceType: chunk.sourceType,
    updatedAt: chunk.indexedAt || chunk.fecha || null,
    texto: truncateText(chunk.text, 220),
  }))

  const fallbackContent =
    section === 'descripcion'
      ? [procedure.descripcion]
      : readSectionItems(procedure.secciones?.[section])

  const extractedContent = exactProcedureEvidence.length
    ? exactProcedureEvidence.map(({ chunk }) => compactWhitespace(chunk.text)).filter(Boolean)
    : []

  const content = extractedContent.length ? extractedContent : fallbackContent

  return {
    section,
    label: sectionLabel,
    content,
    citations,
    model: null,
    grounded: Boolean(citations.length),
    source: selectedEvidence[0]?.chunk?.fuente?.titulo ?? procedure.fuente?.titulo ?? null,
    sourceUrl: selectedEvidence[0]?.chunk?.fuente?.url ?? procedure.fuente?.url ?? null,
  }
}

// ---------------------------------------------------------------------------
// Motor RAG en memoria
// ---------------------------------------------------------------------------

function createRagEngine(payload) {
  const procedures = payload.procedures
  const chunks = payload.chunks
  const municipalities = payload.municipalities ?? []
  const municipalityById = new Map(municipalities.map((municipality) => [municipality.id, municipality]))
  const municipalityBySlug = new Map(municipalities.map((municipality) => [normalizeMunicipalitySlug(municipality.slug), municipality]))
  const procedureMunicipalityIds = new Map()

  for (const chunk of chunks) {
    if (!chunk.procedureId || !chunk.municipalityId) continue
    const current = procedureMunicipalityIds.get(chunk.procedureId) || new Set()
    current.add(chunk.municipalityId)
    procedureMunicipalityIds.set(chunk.procedureId, current)
  }

  function resolveMunicipality({ municipalityId = '', municipalitySlug = '', municipalityName = '' } = {}) {
    const numericId = Number(municipalityId)
    if (Number.isFinite(numericId) && municipalityById.has(numericId)) {
      return municipalityById.get(numericId)
    }

    const normalizedSlug = normalizeMunicipalitySlug(municipalitySlug)
    if (normalizedSlug && municipalityBySlug.has(normalizedSlug)) {
      return municipalityBySlug.get(normalizedSlug)
    }

    const normalizedName = compactWhitespace(String(municipalityName || ''))
    if (!normalizedName) return null
    return {
      id: null,
      slug: normalizedSlug || normalizeMunicipalitySlug(normalizedName),
      name: normalizedName,
      primaryDomain: '',
      sourceName: `Municipalidad de ${normalizedName}`,
      sourceUrl: '',
    }
  }

  function getScopedCorpus({ municipalityId = '', municipalitySlug = '', municipalityName = '', strictMunicipalityScope = true } = {}) {
    const municipality = resolveMunicipality({ municipalityId, municipalitySlug, municipalityName })
    if (!municipality?.id) {
      return {
        municipality,
        procedures,
        chunks,
        strictMunicipalityScope: false,
      }
    }

    const municipalityChunks = chunks.filter((chunk) => Number(chunk.municipalityId) === Number(municipality.id))
    if (!municipalityChunks.length) {
      if (strictMunicipalityScope) {
        return {
          municipality,
          procedures: [],
          chunks: [],
          strictMunicipalityScope: true,
        }
      }
      return {
        municipality,
        procedures,
        chunks,
        strictMunicipalityScope: false,
      }
    }

    const scopedProcedureIds = new Set(municipalityChunks.map((chunk) => chunk.procedureId).filter(Boolean))
    const municipalityProcedures = procedures.filter((procedure) =>
      scopedProcedureIds.has(procedure.id) || procedureMunicipalityIds.get(procedure.id)?.has(municipality.id),
    )

    return {
      municipality,
      procedures: municipalityProcedures,
      chunks: municipalityChunks,
      strictMunicipalityScope,
    }
  }

  return {
    procedures,
    chunks,
    municipalities,
    sources: payload.sources ?? asuncionSources,
    snapshotCount: payload.snapshotCount ?? 0,
    generatedAt: payload.generatedAt ?? null,
    embeddingModel: payload.embeddingModel ?? null,
    chatModel: payload.chatModel ?? null,

    getProcedureById(id) {
      return procedures.find((procedure) => procedure.id === id) ?? null
    },

    async getProcedureSection(id, section) {
      const procedure = procedures.find((item) => item.id === id)
      if (!procedure) return null
      return createProcedureSectionAnswer({ procedure, section, chunks, procedures })
    },

    async search({
      query: q = '',
      categoria = 'all',
      tipo = 'all',
      seccion = 'all',
      onlyOfficialSource = false,
      limit = 6,
      municipalityId = '',
      municipalitySlug = '',
      municipalityName = '',
      runtimeConfig = {},
    } = {}) {
      const scope = getScopedCorpus({
        municipalityId,
        municipalitySlug,
        municipalityName,
        strictMunicipalityScope: runtimeConfig.assistantStrictMunicipalityScope !== false,
      })
      const queryTokens = normalizeQueryTokens(tokenize(q))
      const filteredProcedures = scope.procedures.filter((procedure) =>
        filterProcedure(procedure, { categoria, tipo, seccion, onlyOfficialSource }),
      )

      if (!queryTokens.length) {
        return {
          query: q,
          total: filteredProcedures.length,
          results: filteredProcedures.slice(0, limit).map((procedure) => ({ ...procedure, score: 1 })),
        }
      }

      // Búsqueda híbrida: léxica + semántica (embeddings si están disponibles)
      const evidence = await retrieveRelevantChunks(q, filteredProcedures, scope.chunks, Math.max(limit * 3, 18), {
        useEmbeddings: runtimeConfig.assistantUseEmbeddings !== false,
      })
      const ranked = rankProceduresForQuery(filteredProcedures, queryTokens, evidence, seccion)
        .slice(0, limit)

      return {
        query: q,
        total: ranked.length,
        results: ranked.map(({ procedure, score }) => ({ ...procedure, score })),
      }
    },

    async ask({ query: q = '', municipalityId = '', municipalitySlug = '', municipalityName = '', runtimeConfig = {} } = {}) {
      const scope = getScopedCorpus({
        municipalityId,
        municipalitySlug,
        municipalityName,
        strictMunicipalityScope: runtimeConfig.assistantStrictMunicipalityScope !== false,
      })
      return createAssistantReply(q, scope.procedures, scope.chunks, {
        municipality: scope.municipality,
        runtimeConfig,
        scope,
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Carga del motor RAG desde PostgreSQL
// ---------------------------------------------------------------------------

export async function loadRagEngine() {
  const { rows: procedureRows } = await query(
    'SELECT * FROM rag_procedures ORDER BY created_at',
  )
  const { rows: municipalityRows } = await query(
    'SELECT id, slug, name, primary_domain, source_name, source_url FROM rag_municipalities ORDER BY name',
  )
  const publicIndexEnabled = await isRagPublicIndexEnabled()
  const { rows: chunkRows } = await query(
    publicIndexEnabled
      ? `SELECT c.*, m.name AS municipality_name
         FROM rag_chunks c
         LEFT JOIN rag_municipalities m ON m.id = c.municipality_id`
      : `SELECT c.*, m.name AS municipality_name
         FROM rag_chunks c
         LEFT JOIN rag_municipalities m ON m.id = c.municipality_id
         WHERE c.source_item_id IS NULL`,
  )

  const procedures = procedureRows.map(rowToProcedure)
  const chunks = chunkRows.map(rowToChunk)
  const municipalities = municipalityRows.map(rowToMunicipality)

  const embeddingsLoaded = chunks.filter((c) => c.embedding?.length > 0).length
  console.log(
    `[rag] Cargado desde DB: ${procedures.length} procedures, ${chunks.length} chunks` +
    ` (${embeddingsLoaded} con embeddings)`,
  )

  return createRagEngine({
    procedures,
    chunks,
    municipalities,
    sources: asuncionSources,
    snapshotCount: 0,
    generatedAt: new Date().toISOString(),
    embeddingModel: hasOpenAIAccess() ? openAIModels.embedding : null,
    chatModel: hasOpenAIAccess() ? openAIModels.chat : null,
  })
}

// ---------------------------------------------------------------------------
// buildGeneratedCorpus: actualiza embeddings en DB para chunks que no los tienen.
// Llamado por scripts/buildCorpus.js (npm run corpus:build).
// ---------------------------------------------------------------------------

export async function buildGeneratedCorpus() {
  const { rows: allRows } = await query('SELECT * FROM rag_procedures ORDER BY created_at')
  const { rows: chunkRows } = await query('SELECT * FROM rag_chunks')

  if (!allRows.length) {
    throw new Error('No hay procedures en DB. Levantá el servidor primero para que se ejecute el seed.')
  }

  let updatedCount = 0
  if (hasOpenAIAccess()) {
    const missingEmbeddings = chunkRows.filter((row) => !row.embedding)
    if (missingEmbeddings.length) {
      console.log(`[corpus:build] Generando embeddings para ${missingEmbeddings.length} chunks...`)
      const texts = missingEmbeddings.map((row) => `${row.titulo}\n${row.text}`)
      const embeddings = await embedTexts(texts)
      if (embeddings) {
        const pgVectorAvailable = await hasPgVector()
        for (let i = 0; i < missingEmbeddings.length; i++) {
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
              [embeddingJson, openAIModels.embedding, embeddingVector, missingEmbeddings[i].id],
            )
          } else {
            await query(
              `UPDATE rag_chunks
               SET embedding = $1,
                   embedding_model = $2,
                   indexed_at = NOW()
               WHERE id = $3`,
              [embeddingJson, openAIModels.embedding, missingEmbeddings[i].id],
            )
          }
        }
        updatedCount = embeddings.length
        console.log(`[corpus:build] ${updatedCount} embeddings guardados en DB.`)
      }
    } else {
      console.log('[corpus:build] Todos los chunks ya tienen embeddings.')
    }
  }

  const procedures = allRows.map(rowToProcedure)
  const chunks = chunkRows.map(rowToChunk)

  return {
    procedures,
    chunks,
    snapshotCount: 0,
    embeddingsUpdated: updatedCount,
    generatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Estado de las fuentes web (scraping)
// ---------------------------------------------------------------------------

async function readJsonIfExists(filePath) {
  try {
    const file = await fs.readFile(filePath, 'utf8')
    return JSON.parse(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function listSourceStatuses() {
  const snapshots = (await readJsonIfExists(RAW_SNAPSHOTS_PATH)) ?? []
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]))

  return asuncionSources.map((source) => {
    const snapshot = byId.get(source.id)
    return {
      ...source,
      fetchedAt: snapshot?.fetchedAt ?? null,
      ok: snapshot?.ok ?? false,
      title: snapshot?.title ?? null,
      blocks: snapshot?.blocks?.length ?? 0,
      error: snapshot?.error ?? null,
    }
  })
}
