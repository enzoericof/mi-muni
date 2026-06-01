const MOJIBAKE_PATTERN = /(?:\u00C3.|\u00C2.|\u00E2[\u0080-\u00BF]{1,2})/
const SPIDER_BOILERPLATE_LINES = new Set([
  'saltar al contenido',
  'inicio',
  'intendencia',
  'tramites',
  'servicios',
  'transparencia',
  'informacion publica',
  'leyes reglamentos',
  'mas informacion',
  'anterior',
  'siguiente',
])
const SPIDER_BOILERPLATE_TOKENS = new Set([
  'saltar',
  'al',
  'contenido',
  'inicio',
  'intendencia',
  'tramites',
  'servicios',
  'transparencia',
  'informacion',
  'publica',
  'leyes',
  'reglamentos',
  'mas',
  'anterior',
  'siguiente',
])
const SPIDER_BOILERPLATE_PATTERNS = [
  /\bsaltar al contenido\s+inicio\s+intendencia\s+tr[aá]mites\s+servicios\s+transparencia\s+informaci[oó]n p[úu]blica\s+leyes\s*(?:&|y)?\s*reglamentos(?:\s+m[aá]s(?:\s+informaci[oó]n)?)?/giu,
  /\binicio\s+intendencia\s+tr[aá]mites\s+servicios\s+transparencia\s+informaci[oó]n p[úu]blica\s+leyes\s*(?:&|y)?\s*reglamentos(?:\s+m[aá]s(?:\s+informaci[oó]n)?)?/giu,
  /(?:^|\s)(?:\d+\s+){2,12}anterior\s+siguiente\b/giu,
  /\bfacebook\s+twitter\s+whatsapp\s+copy\s+link\s+telegram\b/giu,
  /\bleer\s+m[aá]s\b/giu,
  /\bviews?\s*:\s*\d+\b/giu,
  /\betiquetas?\s+de\s+la\s+entrada\s*:\s*/giu,
  /\bnavegaci[oó]n\s+de\s+entradas\b[^]*$/giu,
]

function looksLikeMojibake(value = '') {
  return MOJIBAKE_PATTERN.test(value)
}

function repairMojibakeOnce(value = '') {
  try {
    const repaired = Buffer.from(value, 'latin1').toString('utf8')
    return repaired.includes('\uFFFD') ? value : repaired
  } catch {
    return value
  }
}

function repairReplacementNye(value = '') {
  if (!value.includes('\uFFFD')) return value

  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char !== '\uFFFD') {
      result += char
      continue
    }

    const prev = value[index - 1] || ''
    const next = value[index + 1] || ''
    const useLowercase = /[a-záéíóúü]/.test(prev) || /[a-záéíóúü]/.test(next)
    result += useLowercase ? 'ñ' : 'Ñ'
  }

  return result
}

export function repairMojibake(value = '') {
  let current = String(value ?? '')
  if (!current) return current
  if (!looksLikeMojibake(current)) return repairReplacementNye(current)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const next = repairMojibakeOnce(current)
    if (next === current) break
    current = next
    if (!looksLikeMojibake(current)) break
  }

  return repairReplacementNye(current)
}

export function normalizeText(value = '') {
  return repairMojibake(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenize(value = '') {
  return normalizeText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean)
}

export function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean))]
}

export function compactWhitespace(value = '') {
  return repairMojibake(value).replace(/\s+/g, ' ').trim()
}

function isSpiderBoilerplateLine(value = '') {
  const normalized = normalizeText(value)
  if (!normalized) return false
  if (SPIDER_BOILERPLATE_LINES.has(normalized)) return true
  if (normalized.length > 180) return false

  const tokens = normalized.split(' ').filter(Boolean)
  const meaningfulTokens = tokens.filter((token) => !/^\d+$/.test(token))
  return meaningfulTokens.length >= 3 && meaningfulTokens.every((token) => SPIDER_BOILERPLATE_TOKENS.has(token))
}

export function stripSpiderBoilerplate(value = '') {
  const raw = repairMojibake(String(value || '')).replace(/\r/g, '\n')
  if (!raw.trim()) return ''

  const filteredLines = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isSpiderBoilerplateLine(line))

  let cleaned = filteredLines.join('\n')
  for (const pattern of SPIDER_BOILERPLATE_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ')
  }

  return compactWhitespace(cleaned)
}
