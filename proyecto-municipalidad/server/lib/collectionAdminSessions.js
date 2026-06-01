import { randomBytes, timingSafeEqual } from 'node:crypto'
import { query } from '../db/index.js'

const SESSION_DURATION_MINUTES = 30
const MIN_ADMIN_USERNAME_LENGTH = 4
const MIN_ADMIN_PASSWORD_LENGTH = 12
const BLOCKED_DEFAULT_PASSWORDS = new Set([
  'admin',
  'admin123',
  'admin1234',
  'password',
  'password123',
  '123456',
  '12345678',
  'enzo1234',
])

function safeCompare(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))

  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function getConfiguredAdminUsername() {
  return String(process.env.COLLECTION_ADMIN_USERNAME || '').trim()
}

function getConfiguredAdminPassword() {
  return String(process.env.COLLECTION_ADMIN_PASSWORD || '').trim()
}

export function getCollectionAdminAuthStatus() {
  const username = getConfiguredAdminUsername()
  const password = getConfiguredAdminPassword()

  if (!username || !password) {
    return {
      ok: false,
      code: 'collection-admin-auth-not-configured',
    }
  }

  if (username.length < MIN_ADMIN_USERNAME_LENGTH) {
    return {
      ok: false,
      code: 'collection-admin-auth-insecure-config',
      detail: 'username-too-short',
    }
  }

  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: 'collection-admin-auth-insecure-config',
      detail: 'password-too-short',
    }
  }

  if (safeCompare(username.toLowerCase(), password.toLowerCase())) {
    return {
      ok: false,
      code: 'collection-admin-auth-insecure-config',
      detail: 'password-matches-username',
    }
  }

  if (BLOCKED_DEFAULT_PASSWORDS.has(password.toLowerCase())) {
    return {
      ok: false,
      code: 'collection-admin-auth-insecure-config',
      detail: 'password-blocklisted',
    }
  }

  return { ok: true, code: null, detail: null }
}

function toSessionState(row) {
  const expiresAt = row?.expires_at ? new Date(row.expires_at) : null
  const remainingMs = expiresAt ? Math.max(0, expiresAt.getTime() - Date.now()) : 0

  return {
    sessionId: row?.session_id || null,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    createdBy: row?.created_by || null,
    remainingSeconds: Math.floor(remainingMs / 1000),
  }
}

export function isCollectionAdminAuthConfigured() {
  return getCollectionAdminAuthStatus().ok
}

export function areCollectionAdminCredentialsValid(username, password) {
  const configuredUsername = getConfiguredAdminUsername()
  const configuredPassword = getConfiguredAdminPassword()
  if (!configuredUsername || !configuredPassword) return false
  return safeCompare(username, configuredUsername) && safeCompare(password, configuredPassword)
}

export async function purgeExpiredCollectionAdminSessions() {
  await query(
    `
      DELETE FROM collection_admin_sessions
      WHERE expires_at <= NOW()
    `,
  )
}

export async function createCollectionAdminSession({ username, password, createdBy = 'admin-runtime-login' }) {
  const authStatus = getCollectionAdminAuthStatus()
  if (!authStatus.ok) {
    const error = new Error(authStatus.code)
    error.code = authStatus.code
    error.detail = authStatus.detail || null
    throw error
  }

  if (!areCollectionAdminCredentialsValid(username, password)) {
    const error = new Error('collection-admin-unauthorized')
    error.code = 'collection-admin-unauthorized'
    throw error
  }

  await purgeExpiredCollectionAdminSessions()

  const sessionId = randomBytes(24).toString('hex')
  const { rows } = await query(
    `
      INSERT INTO collection_admin_sessions (session_id, expires_at, created_by)
      VALUES ($1, NOW() + ($2::text || ' minutes')::interval, $3)
      RETURNING session_id, expires_at, created_at, last_seen_at, created_by
    `,
    [sessionId, String(SESSION_DURATION_MINUTES), createdBy || username],
  )

  return toSessionState(rows[0])
}

export async function getCollectionAdminSession(sessionId) {
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) return null

  await purgeExpiredCollectionAdminSessions()

  const { rows } = await query(
    `
      UPDATE collection_admin_sessions
      SET last_seen_at = NOW(),
          expires_at = NOW() + ($2::text || ' minutes')::interval
      WHERE session_id = $1
        AND expires_at > NOW()
      RETURNING session_id, expires_at, created_at, last_seen_at, created_by
    `,
    [normalizedSessionId, String(SESSION_DURATION_MINUTES)],
  )

  if (!rows.length) return null

  return toSessionState(rows[0])
}

export async function revokeCollectionAdminSession(sessionId) {
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) return false

  const { rowCount } = await query(
    `
      DELETE FROM collection_admin_sessions
      WHERE session_id = $1
    `,
    [normalizedSessionId],
  )

  return rowCount > 0
}
