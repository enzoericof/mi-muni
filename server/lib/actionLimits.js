import { query } from '../db/index.js'

const APP_TIME_ZONE = 'America/Asuncion'

export const APP_ACTIONS = Object.freeze({
  MUNITA_ASK: 'munita_ask',
  POTHOLE_REPORT_CREATE: 'pothole_report_create',
  POTHOLE_CONFIRM_CREATE: 'pothole_confirm_create',
})

const ACTION_POLICIES = Object.freeze({
  [APP_ACTIONS.MUNITA_ASK]: {
    label: 'Consultas a Munita',
    window: 'day',
    defaultDailyLimit: 5,
    roleDailyLimits: {
      admin: null,
      desarrollador: null,
      recolector: null,
      difusor: 5,
    },
  },
  [APP_ACTIONS.POTHOLE_REPORT_CREATE]: {
    label: 'Reportes de baches',
    window: 'day',
    defaultDailyLimit: 3,
    roleDailyLimits: {},
  },
  [APP_ACTIONS.POTHOLE_CONFIRM_CREATE]: {
    label: 'Confirmaciones de baches',
    window: 'day',
    defaultDailyLimit: 5,
    roleDailyLimits: {},
  },
})

function getEffectiveRoles(user) {
  if (!user) return []
  if (Array.isArray(user.roles) && user.roles.length) return [...new Set(user.roles)]
  return user.role ? [user.role] : []
}

function resolveDailyLimit(user, actionKey) {
  const policy = ACTION_POLICIES[actionKey]
  if (!policy || !user?.id) return null

  const roles = getEffectiveRoles(user)
  const matchingLimits = roles
    .filter((role) => Object.prototype.hasOwnProperty.call(policy.roleDailyLimits, role))
    .map((role) => policy.roleDailyLimits[role])

  if (matchingLimits.includes(null)) return null
  if (matchingLimits.length) return Math.max(...matchingLimits)
  return policy.defaultDailyLimit
}

function buildQuotaSummary(user, actionKey, usedToday = 0) {
  const policy = ACTION_POLICIES[actionKey]
  if (!policy || !user?.id) return null

  const dailyLimit = resolveDailyLimit(user, actionKey)
  const used = Math.max(0, Number(usedToday || 0))
  const unlimited = dailyLimit == null
  const remainingToday = unlimited ? null : Math.max(0, dailyLimit - used)

  return {
    actionKey,
    label: policy.label,
    window: policy.window,
    timeZone: APP_TIME_ZONE,
    dailyLimit,
    usedToday: used,
    remainingToday,
    unlimited,
    allowed: unlimited || used < dailyLimit,
  }
}

function buildLimitExceededError(summary) {
  const actionLabel = {
    [APP_ACTIONS.MUNITA_ASK]: summary.dailyLimit === 1 ? 'consulta' : 'consultas',
    [APP_ACTIONS.POTHOLE_REPORT_CREATE]: summary.dailyLimit === 1 ? 'reporte de bache' : 'reportes de baches',
    [APP_ACTIONS.POTHOLE_CONFIRM_CREATE]: summary.dailyLimit === 1 ? 'confirmación de bache' : 'confirmaciones de baches',
  }[summary.actionKey] || 'acciones'

  const error = new Error(`Llegaste al límite diario de ${summary.dailyLimit} ${actionLabel}.`)
  error.code = 'action-limit-exceeded'
  error.status = 429
  error.actionKey = summary.actionKey
  error.usage = summary
  return error
}

async function getTodayUsageMap(userId) {
  if (!userId) return new Map()
  const { rows } = await query(
    `
      SELECT action_key, used_count
      FROM app_user_action_usage
      WHERE user_id = $1
        AND usage_date = (CURRENT_TIMESTAMP AT TIME ZONE '${APP_TIME_ZONE}')::date
    `,
    [userId],
  )

  return new Map(rows.map((row) => [row.action_key, Number(row.used_count || 0)]))
}

export async function getUserActionUsage(user) {
  if (!user?.id) return {}

  const usageMap = await getTodayUsageMap(user.id)
  return Object.fromEntries(
    Object.keys(ACTION_POLICIES)
      .map((actionKey) => [actionKey, buildQuotaSummary(user, actionKey, usageMap.get(actionKey) || 0)])
      .filter(([, summary]) => Boolean(summary)),
  )
}

export async function getUserActionQuota(user, actionKey) {
  if (!user?.id) return null
  const usageMap = await getTodayUsageMap(user.id)
  return buildQuotaSummary(user, actionKey, usageMap.get(actionKey) || 0)
}

export async function consumeUserAction(user, actionKey) {
  if (!user?.id) return null

  const before = await getUserActionQuota(user, actionKey)
  if (!before) return null
  if (!before.allowed) {
    throw buildLimitExceededError(before)
  }

  await query(
    `
      INSERT INTO app_user_action_usage (user_id, action_key, usage_date, used_count, last_used_at)
      VALUES ($1, $2, (CURRENT_TIMESTAMP AT TIME ZONE '${APP_TIME_ZONE}')::date, 1, NOW())
      ON CONFLICT (user_id, action_key, usage_date)
      DO UPDATE
      SET used_count = app_user_action_usage.used_count + 1,
          last_used_at = NOW()
    `,
    [user.id, actionKey],
  )

  return getUserActionQuota(user, actionKey)
}
