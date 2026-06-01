import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { OAuth2Client } from 'google-auth-library'
import { query } from '../db/index.js'
import { getUserActionUsage } from './actionLimits.js'

const SESSION_DURATION_MINUTES = 60 * 12
const SCRYPT_KEYLEN = 64
const googleOAuthClient = new OAuth2Client()

export const ROLES = Object.freeze({
  ADMIN: 'admin',
  DESARROLLADOR: 'desarrollador',
  RECOLECTOR: 'recolector',
  DIFUSOR: 'difusor',
})

const VALID_ROLES = new Set(Object.values(ROLES))
const DEFAULT_MULTI_ROLE_OVERRIDES = new Map([
  ['enzoericof@gmail.com', [ROLES.ADMIN, ROLES.DESARROLLADOR, ROLES.RECOLECTOR]],
  ['horacio.aranda.py@gmail.com', [ROLES.ADMIN, ROLES.DESARROLLADOR, ROLES.RECOLECTOR]],
  ['federi.al77@hotmail.com', [ROLES.ADMIN, ROLES.DESARROLLADOR, ROLES.RECOLECTOR]],
  ['lcernuzz@gmail.com', [ROLES.ADMIN, ROLES.RECOLECTOR]],
  ['erikwasmosy98@gmail.com', [ROLES.ADMIN, ROLES.RECOLECTOR]],
])

function getMultiRoleOverrides() {
  const overrides = new Map(DEFAULT_MULTI_ROLE_OVERRIDES)
  const raw = String(process.env.AUTH_MULTI_ROLE_OVERRIDES || '').trim()
  if (!raw) return overrides

  for (const entry of raw.split(';')) {
    const [emailPart, rolesPart] = entry.split('=')
    const email = String(emailPart || '').trim().toLowerCase()
    const roles = String(rolesPart || '')
      .split(',')
      .map((role) => role.trim())
      .filter((role) => VALID_ROLES.has(role))

    if (email && roles.length) overrides.set(email, [...new Set(roles)])
  }

  return overrides
}

function getEffectiveRoles(row) {
  if (!row?.email) return row?.role ? [row.role] : []
  const email = String(row.email).trim().toLowerCase()
  const overrides = getMultiRoleOverrides()
  const effective = overrides.get(email) || []
  const baseRole = VALID_ROLES.has(row.role) ? [row.role] : []
  return [...new Set([...baseRole, ...effective])]
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex')
  return `scrypt$${salt}$${derived}`
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const [, salt, expected] = parts
  const derived = scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex')
  const a = Buffer.from(derived, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function toPublicUser(row) {
  if (!row) return null
  const roles = getEffectiveRoles(row)
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    roles,
    barrioSlug: row.barrio_slug || null,
    barrioLabel: row.barrio_label || null,
    address: row.address || null,
    phone: row.phone || null,
  }
}

function toSessionState(row, user) {
  if (!row) return null
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null
  const remainingMs = expiresAt ? Math.max(0, expiresAt.getTime() - Date.now()) : 0
  return {
    sessionId: row.session_id,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    remainingSeconds: Math.floor(remainingMs / 1000),
    user: toPublicUser(user || row),
  }
}

async function enrichSessionUsage(session) {
  if (!session?.user?.id) return session
  return {
    ...session,
    usage: await getUserActionUsage(session.user),
  }
}

export async function purgeExpiredAppSessions() {
  await query(`DELETE FROM app_sessions WHERE expires_at <= NOW()`)
}

export async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase()
  if (!normalized) return null
  const { rows } = await query(`SELECT * FROM app_users WHERE LOWER(email) = $1 LIMIT 1`, [normalized])
  return rows[0] || null
}

export async function findUserByGoogleSub(googleSub) {
  const normalized = String(googleSub || '').trim()
  if (!normalized) return null
  const { rows } = await query(`SELECT * FROM app_users WHERE google_sub = $1 LIMIT 1`, [normalized])
  return rows[0] || null
}

export async function getUserById(id) {
  const { rows } = await query(`SELECT * FROM app_users WHERE id = $1 LIMIT 1`, [id])
  return rows[0] || null
}

export async function createSessionForUser(user) {
  if (!user) {
    const error = new Error('auth-user-required')
    error.code = 'auth-user-required'
    throw error
  }

  await purgeExpiredAppSessions()

  const sessionId = randomBytes(28).toString('hex')
  const { rows } = await query(
    `
      INSERT INTO app_sessions (session_id, user_id, expires_at)
      VALUES ($1, $2, NOW() + ($3::text || ' minutes')::interval)
      RETURNING session_id, user_id, expires_at, created_at
    `,
    [sessionId, user.id, String(SESSION_DURATION_MINUTES)],
  )

  return enrichSessionUsage(toSessionState(rows[0], user))
}

export async function loginWithCredentials(email, password) {
  const user = await findUserByEmail(email)
  if (!user || !verifyPassword(password, user.password_hash)) {
    const error = new Error('auth-invalid-credentials')
    error.code = 'auth-invalid-credentials'
    throw error
  }
  return createSessionForUser(user)
}

function validateRegistrationEmail(email) {
  const normalized = String(email || '').trim().toLowerCase()
  if (!/^\S+@\S+\.\S+$/.test(normalized)) {
    const error = new Error('auth-email-invalid')
    error.code = 'auth-email-invalid'
    throw error
  }
  return normalized
}

function validateRegistrationName(name) {
  const normalized = String(name || '').trim().replace(/\s+/g, ' ')
  if (normalized.length < 2) {
    const error = new Error('auth-name-required')
    error.code = 'auth-name-required'
    throw error
  }
  return normalized.slice(0, 160)
}

function validateRegistrationPassword(password) {
  const normalized = String(password || '').trim()
  if (normalized.length < 6) {
    const error = new Error('auth-password-too-short')
    error.code = 'auth-password-too-short'
    throw error
  }
  return normalized
}

function getGoogleClientIds() {
  const values = [
    process.env.GOOGLE_CLIENT_IDS,
    process.env.GOOGLE_CLIENT_ID,
    process.env.VITE_GOOGLE_CLIENT_ID,
  ]

  return [...new Set(
    values
      .flatMap((value) => String(value || '').split(','))
      .map((value) => value.trim())
      .filter(Boolean),
  )]
}

async function createDifusorUser({ email, name, passwordHash, phone = '', address = '', googleSub = null, authProvider = 'email' }) {
  const { rows } = await query(
    `
      INSERT INTO app_users (email, password_hash, name, role, barrio_slug, barrio_label, address, phone, google_sub, auth_provider)
      VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6, $7, $8)
      RETURNING *
    `,
    [
      email,
      passwordHash,
      name,
      ROLES.DIFUSOR,
      String(address || '').trim() || null,
      String(phone || '').trim() || null,
      googleSub ? String(googleSub).trim() : null,
      authProvider,
    ],
  )
  return rows[0]
}

async function linkDifusorGoogleAccount(user, { googleSub, name }) {
  const normalizedSub = String(googleSub || '').trim()
  if (!user?.id || !normalizedSub) return user

  if (user.google_sub && user.google_sub !== normalizedSub) {
    const error = new Error('auth-google-account-conflict')
    error.code = 'auth-google-account-conflict'
    throw error
  }

  const { rows } = await query(
    `
      UPDATE app_users
      SET google_sub = COALESCE(google_sub, $2),
          auth_provider = CASE
            WHEN auth_provider = 'email' THEN 'email_google'
            ELSE auth_provider
          END,
          name = COALESCE(NULLIF(name, ''), $3),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [user.id, normalizedSub, name],
  )
  return rows[0] || user
}

export async function registerDifusorWithEmail({ email, password, name, phone = '', address = '' }) {
  const normalizedEmail = validateRegistrationEmail(email)
  const normalizedName = validateRegistrationName(name)
  const normalizedPassword = validateRegistrationPassword(password)

  const existing = await findUserByEmail(normalizedEmail)
  if (existing) {
    const error = new Error('auth-email-already-registered')
    error.code = 'auth-email-already-registered'
    throw error
  }

  const user = await createDifusorUser({
    email: normalizedEmail,
    name: normalizedName,
    passwordHash: hashPassword(normalizedPassword),
    phone,
    address,
  })
  return createSessionForUser(user)
}

async function verifyGoogleCredential(credential) {
  const clientIds = getGoogleClientIds()
  if (!clientIds.length) {
    const error = new Error('auth-google-not-configured')
    error.code = 'auth-google-not-configured'
    throw error
  }

  const token = String(credential || '').trim()
  if (!token) {
    const error = new Error('auth-google-credential-required')
    error.code = 'auth-google-credential-required'
    throw error
  }

  let payload = null
  try {
    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: token,
      audience: clientIds,
    })
    payload = ticket.getPayload()
  } catch (_error) {
    const error = new Error('auth-google-invalid')
    error.code = 'auth-google-invalid'
    throw error
  }

  if (
    !payload?.sub ||
    !payload?.email ||
    !clientIds.includes(payload.aud) ||
    !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss) ||
    payload.email_verified !== true
  ) {
    const error = new Error('auth-google-invalid')
    error.code = 'auth-google-invalid'
    throw error
  }

  return {
    googleSub: String(payload.sub),
    email: validateRegistrationEmail(payload.email),
    name: validateRegistrationName(payload.name || payload.email.split('@')[0]),
  }
}

export async function loginWithGoogleCredential(credential, _options = {}) {
  const profile = await verifyGoogleCredential(credential)
  const linkedUser = await findUserByGoogleSub(profile.googleSub)
  let user = linkedUser

  // Google auth should be resilient: if the user already exists by email, link it;
  // if not, create a difusor account instead of leaving the UI in a broken state.
  if (!user) {
    user = await findUserByEmail(profile.email)
  }

  if (user && user.role !== ROLES.DIFUSOR) {
    const error = new Error('auth-google-difusor-only')
    error.code = 'auth-google-difusor-only'
    throw error
  }

  if (user) {
    user = await linkDifusorGoogleAccount(user, profile)
  } else {
    user = await createDifusorUser({
      email: profile.email,
      name: profile.name,
      passwordHash: hashPassword(randomBytes(32).toString('hex')),
      googleSub: profile.googleSub,
      authProvider: 'google',
    })
  }

  return createSessionForUser(user)
}

export async function getSessionWithUser(sessionId) {
  const normalized = String(sessionId || '').trim()
  if (!normalized) return null

  await purgeExpiredAppSessions()

  const { rows } = await query(
    `
      UPDATE app_sessions
      SET expires_at = NOW() + ($2::text || ' minutes')::interval,
          last_seen_at = NOW()
      WHERE session_id = $1
        AND expires_at > NOW()
      RETURNING session_id, user_id, expires_at, created_at
    `,
    [normalized, String(SESSION_DURATION_MINUTES)],
  )

  if (!rows.length) return null

  const user = await getUserById(rows[0].user_id)
  if (!user) return null

  return enrichSessionUsage(toSessionState(rows[0], user))
}

export async function revokeSession(sessionId) {
  const normalized = String(sessionId || '').trim()
  if (!normalized) return false
  const { rowCount } = await query(`DELETE FROM app_sessions WHERE session_id = $1`, [normalized])
  return rowCount > 0
}

export function hasRole(user, role) {
  if (!user) return false
  if (!VALID_ROLES.has(role)) return false
  if (Array.isArray(user.roles) && user.roles.length) {
    return user.roles.includes(role)
  }
  return user.role === role
}

export function ensureRole(session, role) {
  if (!session?.user) {
    const error = new Error('auth-session-required')
    error.code = 'auth-session-required'
    error.status = 401
    throw error
  }
  if (!hasRole(session.user, role)) {
    const error = new Error('auth-role-forbidden')
    error.code = 'auth-role-forbidden'
    error.status = 403
    throw error
  }
  return session
}
