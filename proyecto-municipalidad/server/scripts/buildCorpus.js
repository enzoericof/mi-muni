// Genera o actualiza embeddings en PostgreSQL para todos los chunks del corpus RAG.
// Requiere que el servidor haya corrido al menos una vez para crear el esquema.
//
// Uso:  npm run corpus:build
//
// Nota: necesita DATABASE_URL. Solo genera embeddings si OPENAI_ENABLED=true y hay OPENAI_API_KEY.

import '../lib/env.js'
import { connectWithRetry } from '../db/index.js'
import { buildGeneratedCorpus } from '../lib/rag.js'

async function main() {
  await connectWithRetry()
  const result = await buildGeneratedCorpus()
  console.log(`Procedures en DB: ${result.procedures.length}`)
  console.log(`Chunks en DB:     ${result.chunks.length}`)
  console.log(`Embeddings nuevos: ${result.embeddingsUpdated}`)
  console.log(`Generado:          ${result.generatedAt}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
