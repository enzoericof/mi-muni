import { query } from '../db/index.js'
import { sendCollectionNotificationEmail } from './email.js'
import { getCollectionRuntimeEnvironmentKey } from './collectionRuntime.js'

const RECOLECTOR_POSITION_RETENTION_DAYS = 60
const RECOLECTOR_POSITION_PURGE_INTERVAL_MS = 12 * 60 * 60 * 1000

let lastRecolectorPositionPurgeAt = 0
let recolectorPositionPurgePromise = null
const recolectorEnvironmentKey = getCollectionRuntimeEnvironmentKey()

function normalizeShift(row) {
  if (!row) return null
  return {
    id: row.id,
    environment: row.environment_key || recolectorEnvironmentKey,
    userId: row.user_id,
    routeId: row.route_id,
    routeLabel: row.route_label,
    barrioSlug: row.barrio_slug,
    barrioLabel: row.barrio_label,
    status: row.status,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    lastLat: row.last_lat === null ? null : Number(row.last_lat),
    lastLon: row.last_lon === null ? null : Number(row.last_lon),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
  }
}

function normalizeEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    notificationId: row.notification_id,
    userId: row.user_id,
    shiftId: row.shift_id,
    routeId: row.route_id,
    barrioSlug: row.barrio_slug,
    barrioLabel: row.barrio_label || row.barrio_slug,
    channel: row.channel,
    message: row.message,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }
}

async function purgeOldRecolectorPositionsIfNeeded() {
  const now = Date.now()
  if (recolectorPositionPurgePromise) return recolectorPositionPurgePromise
  if (now - lastRecolectorPositionPurgeAt < RECOLECTOR_POSITION_PURGE_INTERVAL_MS) return null

  recolectorPositionPurgePromise = query(
    `
      DELETE FROM recolector_positions
      WHERE recorded_at < NOW() - ($1::text || ' days')::interval
        AND environment_key = $2
    `,
    [String(RECOLECTOR_POSITION_RETENTION_DAYS), recolectorEnvironmentKey],
  )
    .catch((error) => {
      console.warn('[recolector] No se pudo purgar historial antiguo de posiciones:', error.message)
    })
    .finally(() => {
      lastRecolectorPositionPurgeAt = Date.now()
      recolectorPositionPurgePromise = null
    })

  return recolectorPositionPurgePromise
}

export async function getDifusorProfile(user) {
  const email = String(user?.email || '').trim().toLowerCase()
  if (!email) return { reportCount: 0, resolvedCount: 0, openCount: 0, notifications: [], events: [] }

  const [statsResult, notificationsResult, eventsResult] = await Promise.all([
    query(
      `
        SELECT
          COUNT(*)::int AS report_count,
          COUNT(*) FILTER (WHERE status = 'resuelto')::int AS resolved_count,
          COUNT(*) FILTER (WHERE status NOT IN ('resuelto', 'descartado'))::int AS open_count
        FROM pothole_reports
        WHERE LOWER(reporter_email) = $1
      `,
      [email],
    ),
    query(
      `
        SELECT id, zone_id, event_type, channel, active, created_at
        FROM collection_notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 12
      `,
      [user.id],
    ),
    query(
      `
        SELECT id, notification_id, user_id, shift_id, route_id, barrio_slug, channel, message, created_at
        FROM collection_notification_events
        WHERE user_id = $1
          AND environment_key = $2
        ORDER BY created_at DESC
        LIMIT 12
      `,
      [user.id, recolectorEnvironmentKey],
    ),
  ])

  const stats = statsResult.rows[0] || {}
  return {
    reportCount: Number(stats.report_count || 0),
    resolvedCount: Number(stats.resolved_count || 0),
    openCount: Number(stats.open_count || 0),
    notifications: notificationsResult.rows,
    events: eventsResult.rows.map(normalizeEvent),
  }
}

export async function getRecolectorProfile(user) {
  const { rows } = await query(
    `
      SELECT *
      FROM recolector_shifts
      WHERE user_id = $1
        AND environment_key = $2
      ORDER BY started_at DESC
      LIMIT 8
    `,
    [user.id, recolectorEnvironmentKey],
  )

  return {
    shifts: rows.map(normalizeShift),
    activeShift: normalizeShift(rows.find((row) => row.status === 'online') || null),
  }
}

export async function startRecolectorShift(user, { routeId, routeLabel, barrioSlug, barrioLabel, lat, lon }) {
  void purgeOldRecolectorPositionsIfNeeded()

  const normalizedRouteId = String(routeId || '').trim()
  const normalizedRouteLabel = String(routeLabel || '').trim()
  const normalizedBarrioSlug = String(barrioSlug || '').trim()
  const normalizedBarrioLabel = String(barrioLabel || '').trim()
  if (!normalizedRouteId || !normalizedRouteLabel || !normalizedBarrioSlug || !normalizedBarrioLabel) {
    const error = new Error('recolector-shift-required-fields')
    error.code = 'recolector-shift-required-fields'
    throw error
  }

  await query(
    `
      UPDATE recolector_shifts
      SET status = 'offline',
          ended_at = NOW()
      WHERE user_id = $1
        AND environment_key = $2
        AND status = 'online'
    `,
    [user.id, recolectorEnvironmentKey],
  )

  const { rows } = await query(
    `
      INSERT INTO recolector_shifts (
        environment_key, user_id, route_id, route_label, barrio_slug, barrio_label, last_lat, last_lon, last_seen_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7::double precision IS NULL THEN NULL ELSE NOW() END)
      RETURNING *
    `,
    [
      recolectorEnvironmentKey,
      user.id,
      normalizedRouteId,
      normalizedRouteLabel,
      normalizedBarrioSlug,
      normalizedBarrioLabel,
      Number.isFinite(Number(lat)) ? Number(lat) : null,
      Number.isFinite(Number(lon)) ? Number(lon) : null,
    ],
  )

  const shift = rows[0]
  if (shift.last_lat !== null && shift.last_lon !== null) {
      await query(
      `
        INSERT INTO recolector_positions (environment_key, shift_id, lat, lon)
        VALUES ($1, $2, $3, $4)
      `,
      [recolectorEnvironmentKey, shift.id, shift.last_lat, shift.last_lon],
    )
  }

  return normalizeShift(shift)
}

export async function updateRecolectorPosition(user, shiftId, { lat, lon, barrioSlug, barrioLabel, routeId, routeLabel }) {
  void purgeOldRecolectorPositionsIfNeeded()

  const normalizedShiftId = Number(shiftId)
  const normalizedLat = Number(lat)
  const normalizedLon = Number(lon)
  const normalizedBarrioSlug = String(barrioSlug || '').trim() || null
  const normalizedBarrioLabel = String(barrioLabel || '').trim() || null
  const normalizedRouteId = String(routeId || '').trim() || null
  const normalizedRouteLabel = String(routeLabel || '').trim() || null
  if (!Number.isFinite(normalizedShiftId) || !Number.isFinite(normalizedLat) || !Number.isFinite(normalizedLon)) {
    const error = new Error('recolector-position-invalid')
    error.code = 'recolector-position-invalid'
    throw error
  }

  const { rows } = await query(
    `
      UPDATE recolector_shifts
      SET last_lat = $3,
          last_lon = $4,
          last_seen_at = NOW(),
          barrio_slug = COALESCE($6, barrio_slug),
          barrio_label = COALESCE($7, barrio_label),
          route_id = COALESCE($8, route_id),
          route_label = COALESCE($9, route_label)
      WHERE id = $1
        AND user_id = $2
        AND environment_key = $5
        AND status = 'online'
      RETURNING *
    `,
    [
      normalizedShiftId,
      user.id,
      normalizedLat,
      normalizedLon,
      recolectorEnvironmentKey,
      normalizedBarrioSlug,
      normalizedBarrioLabel,
      normalizedRouteId,
      normalizedRouteLabel,
    ],
  )

  if (!rows.length) return null

  await query(
    `
      INSERT INTO recolector_positions (environment_key, shift_id, lat, lon)
      VALUES ($1, $2, $3, $4)
    `,
    [recolectorEnvironmentKey, normalizedShiftId, normalizedLat, normalizedLon],
  )

  return normalizeShift(rows[0])
}

export async function endRecolectorShift(user, shiftId) {
  const normalizedShiftId = Number(shiftId)
  if (!Number.isFinite(normalizedShiftId)) return null
  const { rows } = await query(
    `
      UPDATE recolector_shifts
      SET status = 'offline',
          ended_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND environment_key = $3
        AND status = 'online'
      RETURNING *
    `,
    [normalizedShiftId, user.id, recolectorEnvironmentKey],
  )
  return normalizeShift(rows[0])
}

export async function broadcastRecolectorNotifications(user, { zoneIds = [], message = '', channel = 'all', shiftId = null } = {}) {
  const normalizedZoneIds = [...new Set((Array.isArray(zoneIds) ? zoneIds : [])
    .map((zoneId) => String(zoneId || '').trim())
    .filter(Boolean))]
  const normalizedChannel = String(channel || 'all').trim() || 'all'
  const normalizedMessage = String(message || '').trim() || 'El recolector aviso que el recorrido esta por iniciar.'
  const hasShiftId = shiftId !== null && shiftId !== undefined && String(shiftId).trim() !== ''
  const normalizedShiftId = hasShiftId ? Number(shiftId) : NaN
  const safeShiftId = Number.isFinite(normalizedShiftId) ? normalizedShiftId : null

  if (!normalizedZoneIds.length) {
    const error = new Error('recolector-notification-zones-required')
    error.code = 'recolector-notification-zones-required'
    throw error
  }

  const channelFilter = normalizedChannel === 'all' ? null : normalizedChannel
  const { rows } = await query(
    `
      INSERT INTO collection_notification_events (
        environment_key, notification_id, user_id, shift_id, route_id, barrio_slug, channel, message
      )
      SELECT
        $1,
        n.id,
        n.user_id,
        $2,
        NULL,
        n.zone_id,
        delivery.channel,
        $3
      FROM collection_notifications n
      CROSS JOIN LATERAL unnest(
        CASE
          WHEN n.channel IN ('both', 'all') THEN ARRAY['panel', 'email']::text[]
          ELSE ARRAY[n.channel]::text[]
        END
      ) AS delivery(channel)
      WHERE n.active = TRUE
        AND n.user_id IS NOT NULL
        AND n.zone_id = ANY($4::text[])
        AND ($5::text IS NULL OR delivery.channel = $5)
      RETURNING id, notification_id, user_id, shift_id, route_id, barrio_slug, channel, message, created_at
    `,
    [recolectorEnvironmentKey, safeShiftId, normalizedMessage, normalizedZoneIds, channelFilter],
  )
  const events = rows.map(normalizeEvent)
  const emailRows = rows.filter((row) => row.channel === 'email')
  const emailResult = await sendNotificationEmails(emailRows)

  return {
    count: events.length,
    requestedZones: normalizedZoneIds.length,
    email: emailResult,
    events,
  }
}

async function sendNotificationEmails(events = []) {
  if (!events.length) return { attempted: 0, sent: 0, skipped: 0, failed: 0 }

  const { rows: recipients } = await query(
    `
      SELECT
        e.id,
        e.message,
        e.barrio_slug,
        COALESCE(cb.barrio_label, mb.barrio_label, e.barrio_slug) AS barrio_label,
        u.email,
        u.name
      FROM collection_notification_events e
      JOIN app_users u ON u.id = e.user_id
      LEFT JOIN collection_barrios cb ON cb.barrio_id = e.barrio_slug
      LEFT JOIN LATERAL (
        SELECT barrio_label
        FROM municipal_barrios
        WHERE barrio_slug = e.barrio_slug
        ORDER BY id
        LIMIT 1
      ) mb ON TRUE
      WHERE e.id = ANY($1::bigint[])
    `,
    [events.map((event) => Number(event.id)).filter(Number.isFinite)],
  )

  const result = { attempted: recipients.length, sent: 0, skipped: 0, failed: 0 }
  for (const recipient of recipients) {
    try {
      const delivery = await sendCollectionNotificationEmail({
        to: recipient.email,
        name: recipient.name,
        barrioLabel: recipient.barrio_label,
        message: recipient.message,
      })
      if (delivery.ok) result.sent += 1
      else if (delivery.skipped) result.skipped += 1
      else result.failed += 1
    } catch (error) {
      result.failed += 1
      console.warn('[notifications] No se pudo enviar email de recoleccion:', error.message)
    }
  }
  return result
}

export async function listCollectionNotificationEvents(user, { sinceId = 0, channel = 'panel', limit = 10 } = {}) {
  const normalizedUserId = Number(user?.id)
  if (!Number.isFinite(normalizedUserId)) return []
  const normalizedSinceId = Number(sinceId)
  const normalizedChannel = String(channel || 'panel').trim()
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10))
  const { rows } = await query(
    `
      SELECT
        e.id,
        e.notification_id,
        e.user_id,
        e.shift_id,
        e.route_id,
        e.barrio_slug,
        COALESCE(cb.barrio_label, mb.barrio_label, e.barrio_slug) AS barrio_label,
        e.channel,
        e.message,
        e.created_at
      FROM collection_notification_events e
      LEFT JOIN collection_barrios cb ON cb.barrio_id = e.barrio_slug
      LEFT JOIN LATERAL (
        SELECT barrio_label
        FROM municipal_barrios
        WHERE barrio_slug = e.barrio_slug
        ORDER BY id
        LIMIT 1
      ) mb ON TRUE
      WHERE e.environment_key = $1
        AND e.user_id = $2
        AND e.id > $3
        AND e.channel = $4
      ORDER BY e.id ASC
      LIMIT $5
    `,
    [
      recolectorEnvironmentKey,
      normalizedUserId,
      Number.isFinite(normalizedSinceId) ? normalizedSinceId : 0,
      normalizedChannel,
      safeLimit,
    ],
  )
  return rows.map(normalizeEvent)
}

async function createRouteStartEvents(shift) {
  const { rows: notifications } = await query(
    `
      SELECT id, user_id, zone_id, channel
      FROM collection_notifications
      WHERE active = TRUE
        AND event_type IN ('route_start', 'collection-window')
        AND zone_id = $1
    `,
    [shift.barrio_slug],
  )

  for (const notification of notifications) {
    await query(
      `
        INSERT INTO collection_notification_events (
          environment_key, notification_id, user_id, shift_id, route_id, barrio_slug, channel, message
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        recolectorEnvironmentKey,
        notification.id,
        notification.user_id || null,
        shift.id,
        shift.route_id,
        shift.barrio_slug,
        notification.channel,
        `El recolector inicio la ruta ${shift.route_label} en ${shift.barrio_label}.`,
      ],
    )
  }
}
