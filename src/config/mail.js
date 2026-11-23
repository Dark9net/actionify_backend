/**
 * The mail transporter: one nodemailer instance for the whole server, built from
 * the SMTP_* values in .env (see env.js).
 *
 *   const { transporter, MAIL_FROM } = require("../config/mail")
 *   await transporter.sendMail({ from: MAIL_FROM, to, subject, text, html })
 *
 * Without SMTP_HOST a "console" transporter is used: nothing is
 * sent, and utils/mailer.js prints each message (with its link) in the
 * server log instead.
 */
const nodemailer = require("nodemailer")
const env = require("./env")

/** True when mail really leaves the server. */
const isSmtp = Boolean(env.SMTP_HOST)

const transporter = isSmtp
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE, // true: TLS from the start (465); false: STARTTLS upgrade (587)
      requireTLS: !env.SMTP_SECURE, // never send codes over an unencrypted connection
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
      pool: true, // reuse connections when many codes go out together
      maxConnections: 3,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    })
  : nodemailer.createTransport({ jsonTransport: true }) // builds the message, sends nothing

/**
 * Checks the SMTP login at startup (server.js) so a wrong host or password shows
 * up straight away instead of on the first sign-up. Never throws.
 */
async function verifyMailer() {
  if (!isSmtp) return { ok: true, mode: "console" }
  try {
    await transporter.verify()
    return { ok: true, mode: "smtp" }
  } catch (err) {
    return { ok: false, mode: "smtp", reason: `${err.code ?? "error"}: ${err.message}` }
  }
}

module.exports = { transporter, isSmtp, verifyMailer, MAIL_FROM: env.MAIL_FROM }
