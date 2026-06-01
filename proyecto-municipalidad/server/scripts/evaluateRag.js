import 'dotenv/config'
import ragQuestions from '../data/eval/ragQuestions.js'
import { connectWithRetry, getPool, initSchema } from '../db/index.js'
import { seedRagIfEmpty } from '../db/rag-seed.js'
import { loadRagEngine } from '../lib/rag.js'

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function matchesExpected(haystack, expectedAny = []) {
  const normalized = normalize(haystack)
  return expectedAny.some((token) => normalized.includes(normalize(token)))
}

async function evaluate() {
  const strict = process.argv.includes('--strict')
  await connectWithRetry()
  await initSchema()
  await seedRagIfEmpty()

  const engine = await loadRagEngine()
  const results = []

  for (const item of ragQuestions) {
    const [answer, search] = await Promise.all([
      engine.ask({ query: item.question }),
      engine.search({ query: item.question, limit: 3 }),
    ])

    const searchHaystack = JSON.stringify(search.results || [])
    const answerHaystack = JSON.stringify(answer || {})
    const top3Hit = item.expectedNoGrounding
      ? answer?.grounded === false
      : matchesExpected(`${searchHaystack} ${answerHaystack}`, item.expectedAny)

    results.push({
      id: item.id,
      question: item.question,
      passed: top3Hit,
      expectedNoGrounding: item.expectedNoGrounding === true,
      grounded: answer?.grounded === true,
      topResults: (search.results || []).slice(0, 3).map((result) => ({
        id: result.id,
        title: result.titulo,
        score: Math.round(Number(result.score || 0) * 100) / 100,
      })),
      citations: (answer?.citations || []).map((citation) => ({
        title: citation.titulo,
        url: citation.url,
        sourceType: citation.sourceType || 'manual',
        updatedAt: citation.updatedAt || null,
      })),
    })
  }

  const passed = results.filter((result) => result.passed).length
  const summary = {
    ok: passed === results.length,
    passed,
    total: results.length,
    openAIEnabled: Boolean(process.env.OPENAI_API_KEY) && String(process.env.OPENAI_ENABLED ?? 'true').toLowerCase() !== 'false',
    results,
  }

  console.log(JSON.stringify(summary, null, 2))
  if (strict && !summary.ok) {
    process.exitCode = 1
  }
}

evaluate()
  .catch((error) => {
    console.error('[rag:evaluate]', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await getPool().end().catch(() => null)
  })
