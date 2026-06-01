import { query } from '../db/index.js'

const SETTINGS_ID = 1
const LEGACY_ENVIRONMENT = 'legacy-shared'

export function getCollectionRuntimeEnvironmentKey() {
  const explicitEnvironment = String(process.env.COLLECTION_RUNTIME_ENV || '').trim().toLowerCase()
  if (explicitEnvironment) return explicitEnvironment
  return process.env.NODE_ENV === 'production' ? 'production' : 'development'
}

function toRuntimeState(row) {
  return {
    environment: row?.environment_key || getCollectionRuntimeEnvironmentKey(),
    simulationEnabled: Boolean(row?.simulation_enabled),
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row?.updated_by || null,
  }
}

export async function getCollectionRuntimeSettings() {
  const environmentKey = getCollectionRuntimeEnvironmentKey()
  const { rows } = await query(
    `
      SELECT environment_key, simulation_enabled, updated_at, updated_by
      FROM collection_runtime_environments
      WHERE environment_key = $1
      LIMIT 1
    `,
    [environmentKey],
  )

  if (rows.length) {
    return toRuntimeState(rows[0])
  }

  const { rows: legacyRows } = await query(
    `
      SELECT settings_id, simulation_enabled, updated_at, updated_by
      FROM collection_runtime_settings
      WHERE settings_id = $1
      LIMIT 1
    `,
    [SETTINGS_ID],
  )

  const fallbackState = legacyRows.length
    ? {
        environment_key: environmentKey,
        simulation_enabled: Boolean(legacyRows[0].simulation_enabled),
        updated_at: legacyRows[0].updated_at,
        updated_by: legacyRows[0].updated_by || LEGACY_ENVIRONMENT,
      }
    : {
        environment_key: environmentKey,
        simulation_enabled: true,
        updated_at: null,
        updated_by: 'system-bootstrap',
      }

  const { rows: insertedRows } = await query(
    `
      INSERT INTO collection_runtime_environments (environment_key, simulation_enabled, updated_at, updated_by)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (environment_key)
      DO UPDATE SET
        simulation_enabled = EXCLUDED.simulation_enabled,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
      RETURNING environment_key, simulation_enabled, updated_at, updated_by
    `,
    [
      fallbackState.environment_key,
      fallbackState.simulation_enabled,
      fallbackState.updated_by,
    ],
  )

  if (!legacyRows.length) {
    await query(
      `
        INSERT INTO collection_runtime_settings (settings_id, simulation_enabled, updated_by)
        VALUES ($1, TRUE, 'system-bootstrap')
        ON CONFLICT (settings_id) DO NOTHING
      `,
      [SETTINGS_ID],
    )
  }

  return toRuntimeState(insertedRows[0])
}

export async function isCollectionSimulationEnabled() {
  const settings = await getCollectionRuntimeSettings()
  return settings.simulationEnabled
}

export async function setCollectionSimulationEnabled(simulationEnabled, updatedBy = 'admin') {
  const { rows } = await query(
    `
      INSERT INTO collection_runtime_environments (environment_key, simulation_enabled, updated_at, updated_by)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (environment_key)
      DO UPDATE SET
        simulation_enabled = EXCLUDED.simulation_enabled,
        updated_at = NOW(),
        updated_by = EXCLUDED.updated_by
      RETURNING environment_key, simulation_enabled, updated_at, updated_by
    `,
    [getCollectionRuntimeEnvironmentKey(), Boolean(simulationEnabled), updatedBy],
  )

  return toRuntimeState(rows[0])
}
