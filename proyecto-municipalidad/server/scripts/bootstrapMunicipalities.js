import '../lib/env.js'
import { bootstrapMunicipalityGeography } from '../lib/municipalities.js'

function normalizeTargets(argv = []) {
  return [...new Set(
    argv
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean),
  )]
}

async function main() {
  const targets = normalizeTargets(process.argv.slice(2))

  if (!targets.length) {
    console.error('Uso: node server/scripts/bootstrapMunicipalities.js <slug> [slug...]')
    console.error('Ejemplo: node server/scripts/bootstrapMunicipalities.js lambare luque san-lorenzo')
    process.exitCode = 1
    return
  }

  const results = []

  for (const municipalitySlug of targets) {
    console.log(`[bootstrap] Importando barrios oficiales para ${municipalitySlug}...`)
    const result = await bootstrapMunicipalityGeography({
      municipalitySlug,
      requestedBy: 'cli-bootstrap',
    })
    results.push(result)
    console.log(
      `[bootstrap] ${result.municipalityName} listo: ${result.barrioCount} barrios (${result.sourceName}).`,
    )
  }

  console.log('[bootstrap] Resumen final:')
  for (const result of results) {
    console.log(
      `- ${result.municipalitySlug}: ${result.barrioCount} barrios importados`,
    )
  }
}

main().catch((error) => {
  console.error('[bootstrap] Error:', error.code || error.name || 'unknown', error.message)
  process.exitCode = 1
})
