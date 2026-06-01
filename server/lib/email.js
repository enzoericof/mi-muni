import nodemailer from 'nodemailer'

let transporter = null

function getEmailConfig() {
  const smtpUrl = String(process.env.SMTP_URL || '').trim()
  const host = String(process.env.SMTP_HOST || '').trim()
  const port = Number(process.env.SMTP_PORT || 587)
  const user = String(process.env.SMTP_USER || '').trim()
  const pass = String(process.env.SMTP_PASS || '').trim()
  const from = String(process.env.MAIL_FROM || process.env.SMTP_FROM || user || '').trim()

  if (smtpUrl) {
    return {
      from,
      transport: smtpUrl,
    }
  }

  if (!host || !from) return null

  return {
    from,
    transport: {
      host,
      port: Number.isFinite(port) ? port : 587,
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465,
      auth: user && pass ? { user, pass } : undefined,
    },
  }
}

function getTransporter() {
  const config = getEmailConfig()
  if (!config) return null
  if (!transporter) {
    transporter = nodemailer.createTransport(config.transport)
  }
  return { transporter, from: config.from }
}

function buildNotificationSubject(barrioLabel = '') {
  return barrioLabel
    ? `Aviso de recoleccion para ${barrioLabel}`
    : 'Aviso de recoleccion municipal'
}

export async function sendCollectionNotificationEmail({ to, name = '', barrioLabel = '', message = '' } = {}) {
  const recipient = String(to || '').trim()
  if (!recipient) return { ok: false, skipped: true, reason: 'recipient-missing' }

  const mailer = getTransporter()
  if (!mailer) return { ok: false, skipped: true, reason: 'smtp-not-configured' }

  const cleanName = String(name || '').trim()
  const cleanMessage = String(message || '').trim() || 'El recolector aviso que el recorrido esta por iniciar.'
  const cleanBarrioLabel = String(barrioLabel || '').trim()
  const greeting = cleanName ? `Hola ${cleanName},` : 'Hola,'
  const barrioLine = cleanBarrioLabel ? `Barrio: ${cleanBarrioLabel}` : ''
  const text = [greeting, '', cleanMessage, barrioLine, '', 'Municipalidad - Mi Muni']
    .filter((line) => line !== '')
    .join('\n')

  await mailer.transporter.sendMail({
    from: mailer.from,
    to: recipient,
    subject: buildNotificationSubject(cleanBarrioLabel),
    text,
  })

  return { ok: true, skipped: false }
}

export function isCollectionEmailConfigured() {
  return Boolean(getEmailConfig())
}
