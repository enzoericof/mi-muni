import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const JWT_ALGORITHM = 'HS256'
const JWT_TYPE = 'JWT'
const DEFAULT_ISSUER = 'mi-muni-api'
const DEFAULT_AUDIENCE = 'mi-muni-app'

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function base64UrlDecode(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64')
}

function getJwtSecret() {
  const configured = String(process.env.JWT_SECRET || process.env.AUTH_JWT_SECRET || '').trim()
  if (configured.length >= 32) return configured

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be configured with at least 32 characters in production')
  }

  if (!globalThis.__MI_MUNI_DEV_JWT_SECRET__) {
    globalThis.__MI_MUNI_DEV_JWT_SECRET__ = randomBytes(32).toString('hex')
  }
  return globalThis.__MI_MUNI_DEV_JWT_SECRET__
}

function signInput(input, secret = getJwtSecret()) {
  return createHmac('sha256', secret).update(input).digest('base64url')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function createJwt(payload, { expiresInSeconds = 12 * 60 * 60, issuer = DEFAULT_ISSUER, audience = DEFAULT_AUDIENCE } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const header = {
    alg: JWT_ALGORITHM,
    typ: JWT_TYPE,
  }
  const claims = {
    ...payload,
    iss: issuer,
    aud: audience,
    iat: now,
    exp: now + expiresInSeconds,
  }

  const encodedHeader = base64UrlEncode(JSON.stringify(header))
  const encodedPayload = base64UrlEncode(JSON.stringify(claims))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = signInput(signingInput)
  return `${signingInput}.${signature}`
}

export function verifyJwt(token, { issuer = DEFAULT_ISSUER, audience = DEFAULT_AUDIENCE } = {}) {
  const normalized = String(token || '').trim()
  const parts = normalized.split('.')
  if (parts.length !== 3) return null

  const [encodedHeader, encodedPayload, signature] = parts
  const expectedSignature = signInput(`${encodedHeader}.${encodedPayload}`)
  if (!safeEqual(signature, expectedSignature)) return null

  let header = null
  let payload = null
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8'))
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'))
  } catch (_error) {
    return null
  }

  if (header?.alg !== JWT_ALGORITHM || header?.typ !== JWT_TYPE) return null
  if (payload?.iss !== issuer || payload?.aud !== audience) return null
  if (!payload?.exp || Number(payload.exp) <= Math.floor(Date.now() / 1000)) return null

  return payload
}
