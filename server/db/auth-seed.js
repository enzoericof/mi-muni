import { query } from './index.js'
import { hashPassword, ROLES } from '../lib/auth.js'

function isDemoUserSeedingEnabled() {
  return String(process.env.AUTH_ENABLE_DEMO_USERS || '').trim().toLowerCase() === 'true'
}

function getSeedPassword(envKey) {
  return String(process.env[envKey] || '').trim()
}

function getDemoUsers() {
  return [
    {
      email: 'admin@mimuni.gov.py',
      password: getSeedPassword('AUTH_SEED_ADMIN_PASSWORD'),
      name: 'Administración Municipal',
      role: ROLES.ADMIN,
      barrioSlug: null,
      barrioLabel: null,
      address: null,
      phone: null,
    },
    {
      email: 'dev@mimuni.gov.py',
      password: getSeedPassword('AUTH_SEED_DEV_PASSWORD'),
      name: 'Desarrollador Mi Muni',
      role: ROLES.DESARROLLADOR,
      barrioSlug: null,
      barrioLabel: null,
      address: null,
      phone: '+595981000222',
    },
    {
      email: 'recolector@mimuni.gov.py',
      password: getSeedPassword('AUTH_SEED_RECOLECTOR_PASSWORD'),
      name: 'Carlos Recolector',
      role: ROLES.RECOLECTOR,
      barrioSlug: null,
      barrioLabel: null,
      address: null,
      phone: '+595981000111',
    },
    {
      email: 'difusor@mimuni.gov.py',
      password: getSeedPassword('AUTH_SEED_DIFUSOR_PASSWORD'),
      name: 'Maria Vecina',
      role: ROLES.DIFUSOR,
      barrioSlug: 'zeballos-cue',
      barrioLabel: 'ZEBALLOS CUE',
      address: 'Av. Eusebio Ayala 1234',
      phone: '+595981222333',
    },
  ]
}

export async function seedAppUsers({ force = false } = {}) {
  if (!isDemoUserSeedingEnabled()) {
    console.log('[db] Demo user seeding disabled. Set AUTH_ENABLE_DEMO_USERS=true to opt in locally.')
    return { seeded: false, total: 0, reason: 'disabled' }
  }

  const demoUsers = getDemoUsers()
    .filter((user) => user.password)

  if (!demoUsers.length) {
    console.log('[db] Demo user seeding skipped. Provide AUTH_SEED_* passwords together with AUTH_ENABLE_DEMO_USERS=true.')
    return { seeded: false, total: 0, reason: 'missing-passwords' }
  }

  if (force) {
    await query(`DELETE FROM app_sessions`)
    await query(`DELETE FROM app_users`)
  }

  for (const user of demoUsers) {
    const passwordHash = hashPassword(user.password)
    await query(
      `
        INSERT INTO app_users (email, password_hash, name, role, barrio_slug, barrio_label, address, phone)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (email)
        DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          name = EXCLUDED.name,
          role = EXCLUDED.role,
          barrio_slug = EXCLUDED.barrio_slug,
          barrio_label = EXCLUDED.barrio_label,
          address = EXCLUDED.address,
          phone = EXCLUDED.phone,
          updated_at = NOW()
      `,
      [
        user.email,
        passwordHash,
        user.name,
        user.role,
        user.barrioSlug,
        user.barrioLabel,
        user.address,
        user.phone,
      ],
    )
  }

  console.log(`[db] Synced ${demoUsers.length} seeded users (admin, desarrollador, recolector, difusor)`)
  return { seeded: true, total: demoUsers.length }
}
