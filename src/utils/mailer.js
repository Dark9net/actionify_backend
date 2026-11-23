/**
 * The emails the app sends, through the transporter in config/mail.js. Without
 * SMTP_HOST (development) each message is printed in the server console, link
 * included, so sign-up and reset can be tried without a mail account.
 */
const env = require("../config/env")
const QRCode = require("qrcode")
const { transporter, isSmtp, MAIL_FROM } = require("../config/mail")

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

async function send({ to, subject, text, html, attachments }) {
  await transporter.sendMail({ from: MAIL_FROM, to, subject, text, html, attachments })
  if (!isSmtp) {
    const files = attachments?.length ? `\n\nAttached: ${attachments.map((a) => a.filename).join(", ")}` : ""
    console.log(`\n----- Email (printed: SMTP_HOST isn't set) -----\nTo: ${to}\nSubject: ${subject}\n\n${text}${files}\n------------------------------------------------\n`)
  }
}

/** "10m" → "10 minutes" for the email text. */
function humanDuration({ text }) {
  const [, n, unit] = /^(\d+)\s*(\w)$/.exec(text)
  const word = { s: "second", m: "minute", h: "hour", d: "day", w: "week" }[unit]
  return `${n} ${word}${n === "1" ? "" : "s"}`
}

/** A plain studio layout: paragraphs, then an optional big code or button. */
function layout(paragraphs, { code, button } = {}) {
  const p = (t) => `<p style="margin:0 0 16px">${escapeHtml(t)}</p>`
  const codeBlock = code
    ? `<p style="margin:8px 0 24px;font-size:32px;font-weight:700;letter-spacing:8px;font-family:ui-monospace,Consolas,monospace">${escapeHtml(code)}</p>`
    : ""
  const cta = button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(button.href)}" style="background:#1d1a16;color:#f7f3ec;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(button.label)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;color:#6b645a">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(button.href)}</span></p>`
    : ""
  const [first, ...rest] = paragraphs
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#1d1a16;max-width:520px">
    <p style="font-family:Georgia,serif;font-size:20px;margin:0 0 20px">${escapeHtml(env.APP_NAME)}</p>${p(first)}${codeBlock}${rest.map(p).join("")}${cta}</div>`
}

/** After sign-up and on "Send the link again": confirms the address. */
function sendVerificationLinkEmail({ to, name, token }) {
  const link = `${env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`
  const lines = [
    `Hi ${name},`,
    `Confirm your email address to finish creating your ${env.APP_NAME} account. The link works for ${humanDuration(env.EMAIL_VERIFY_EXPIRES_IN)}.`,
    "If you didn't sign up, you can ignore this email.",
  ]
  return send({
    to,
    subject: `Confirm your email for ${env.APP_NAME}`,
    text: `${lines.slice(0, -1).join("\n\n")}\n\n${link}\n\n${lines.at(-1)}`,
    html: layout(lines, { button: { href: link, label: "Confirm email" } }),
  })
}

/**
 * Someone tried to create an account with an address that already has one. The sign-up form
 * answers the same either way (so it can't be used to find out who has an account); the owner
 * hears about it here instead.
 */
function sendAccountExistsEmail({ to, name }) {
  const login = `${env.APP_URL}/login`
  const lines = [
    `Hi ${name},`,
    `Someone (hopefully you) tried to create a ${env.APP_NAME} account with this email address, but you already have one.`,
    `Sign in with your password, or choose "Forgot password?" on the sign-in page to set a new one.`,
    "If this wasn't you, you can ignore this email: nothing has changed.",
  ]
  return send({
    to,
    subject: `You already have a ${env.APP_NAME} account`,
    text: `${lines.join("\n\n")}\n\n${login}`,
    html: layout(lines, { button: { href: login, label: "Sign in" } }),
  })
}

/** "Forgot password?": a link to /reset-password where a new password is chosen. */
function sendPasswordResetEmail({ to, name, token }) {
  const link = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`
  const lines = [
    `Hi ${name},`,
    `We received a request to reset the password for your ${env.APP_NAME} account. Choose a new one with the link below. It works for ${humanDuration(env.PASSWORD_RESET_EXPIRES_IN)} and only once.`,
    "If you didn't ask for this, you can ignore this email: your password stays the same.",
  ]
  return send({
    to,
    subject: `Reset your ${env.APP_NAME} password`,
    text: `${lines.slice(0, -1).join("\n\n")}\n\n${link}\n\n${lines.at(-1)}`,
    html: layout(lines, { button: { href: link, label: "Choose a new password" } }),
  })
}

/** After a reset or change: tells the owner, so a change they didn't make doesn't go unnoticed. */
function sendPasswordChangedEmail({ to, name }) {
  const lines = [
    `Hi ${name},`,
    `The password for your ${env.APP_NAME} account was just changed, and every other device that was signed in has been signed out.`,
    `If this wasn't you, reset your password straight away from the sign-in page ("Forgot password?") and tell the studio.`,
  ]
  return send({ to, subject: `Your ${env.APP_NAME} password was changed`, text: lines.join("\n\n"), html: layout(lines) })
}

/** A studio lead approved a new account: it can sign in now. */
function sendAccountApprovedEmail({ to, name }) {
  const login = `${env.APP_URL}/login`
  const lines = [`Hi ${name},`, `Your ${env.APP_NAME} account has been verified by the studio. You can sign in now.`]
  return send({
    to,
    subject: `Your ${env.APP_NAME} account is ready`,
    text: `${lines.join("\n\n")}\n\n${login}`,
    html: layout(lines, { button: { href: login, label: "Sign in" } }),
  })
}

/** Too many wrong passwords: the account is paused for a while. */
function sendAccountLockedEmail({ to, name, minutes }) {
  const lines = [
    `Hi ${name},`,
    `There were several wrong passwords on your ${env.APP_NAME} account, so signing in is paused for ${minutes} minutes.`,
    `If that wasn't you, choose "Forgot password?" on the sign-in page to set a new password.`,
  ]
  return send({ to, subject: `Signing in to ${env.APP_NAME} is paused`, text: lines.join("\n\n"), html: layout(lines) })
}

/** "+9779812345678" → "+977 981 234 5678" */
const showMobile = (m) => (/^\+977\d{10}$/.test(m) ? `+977 ${m.slice(4, 7)} ${m.slice(7, 10)} ${m.slice(10)}` : m)

/** "2026-12-05" → "Saturday 5 December 2026" (the day itself, whatever the server's time zone). */
const longDay = (day) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })

/**
 * The studio sent photographers to a booking (the panel's Bookings page): the client hears who is
 * coming, with each one's phone, and that they will be on site on time.
 * crew: [{ name, mobile }]; mobile may be null (none on the staff member's profile yet).
 */
function sendCrewAssignedEmail({ to, name, ref, type, day, time, venue, crew }) {
  const many = crew.length > 1
  const who = crew.map((c) => c.name)
  const names = who.length < 2 ? who.join("") : `${who.slice(0, -1).join(", ")} and ${who.at(-1)}`
  const when = `${longDay(day)}${time ? ` at ${time}` : ""}`
  const lines = [
    `Hi ${name},`,
    `Your ${many ? "photographers are" : "photographer is"} assigned to your event: ${type.toLowerCase()} on ${when}, at ${venue}.`,
    `${names} ${many ? "are" : "is"} assigned to your event and will arrive on site on time.`,
    ...crew.map((c) => `${c.name}: ${c.mobile ? showMobile(c.mobile) : "phone not on file yet"}`),
    ...(crew.some((c) => !c.mobile) ? ["Where a phone number is missing, reply to this email and we will send it before the day."] : []),
    `Your booking reference is ${ref}. If anything about the day changes, reply to this email and let us know.`,
  ]
  return send({
    to,
    subject: `Your ${many ? "photographers are" : "photographer is"} assigned · ${ref}`,
    text: lines.join("\n\n"),
    html: layout(lines),
  })
}

/**
 * The studio marked a booking completed (the panel's Bookings page): thanks the client and, when
 * the event's gallery has a live access code, gives them the private link, the code and its QR code
 * (an inline image, also attached so it can be printed on table cards).
 * gallery: { link, code, expiresAt } | null (no folder or no live code yet: the link follows).
 */
async function sendEventCompletedEmail({ to, name, ref, type, day, venue, gallery }) {
  const thanks = `Thank you for choosing ${env.APP_NAME} for your ${type.toLowerCase()} on ${longDay(day)} at ${venue}. It was a pleasure to be part of your day, and your event is now complete.`
  const closing = [`Your booking reference is ${ref}. If there is anything you'd like changed, reply to this email.`, `With warm wishes,\nThe ${env.APP_NAME} team`]

  if (!gallery) {
    const lines = [
      `Hi ${name},`,
      thanks,
      "We are preparing your photographs and videos now. As soon as they are ready, we will send you a private link and a QR code to see and download them, and to share with your guests.",
      ...closing,
    ]
    return send({ to, subject: `Thank you, ${name}: your event is complete · ${ref}`, text: lines.join("\n\n"), html: layout(lines) })
  }

  const until = gallery.expiresAt ? `Your gallery stays open until ${longDay(new Date(gallery.expiresAt).toISOString().slice(0, 10))}.` : null
  const lines = [
    `Hi ${name},`,
    thanks,
    "All your photographs and videos have been prepared and shared with you. Open your private gallery from the link below, or scan the QR code with your phone's camera.",
    "Share the link or the QR code with your guests: everyone who has it can see the whole day and download the photos they want. Keep it among the people you invited.",
    ...(until ? [until] : []),
  ]
  const typeIt = `If the link doesn't open, go to ${env.APP_URL}/login and enter your gallery code: ${gallery.code}`
  const qr = await QRCode.toBuffer(gallery.link, { width: 480, margin: 2, errorCorrectionLevel: "M", color: { dark: "#1d1a16", light: "#ffffff" } })
  const cid = "gallery-qr@actionify"

  const p = (t) => `<p style="margin:0 0 16px">${escapeHtml(t).replace(/\n/g, "<br>")}</p>`
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#1d1a16;max-width:520px">
    <p style="font-family:Georgia,serif;font-size:20px;margin:0 0 20px">${escapeHtml(env.APP_NAME)}</p>${lines.map(p).join("")}
    <p style="margin:24px 0"><a href="${escapeHtml(gallery.link)}" style="background:#1d1a16;color:#f7f3ec;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600;display:inline-block">Open your gallery</a></p>
    <p style="margin:0 0 8px"><img src="cid:${cid}" width="200" height="200" alt="QR code for your gallery" style="display:block;border:1px solid #e4ddd0;border-radius:12px"></p>
    <p style="margin:0 0 24px;font-size:13px;color:#6b645a">Scan to open the gallery. The QR code is attached too, ready to print on table cards.</p>
    <p style="margin:0 0 4px;font-size:13px;color:#6b645a">Your gallery code</p>
    <p style="margin:0 0 16px;font-size:22px;font-weight:700;letter-spacing:3px;font-family:ui-monospace,Consolas,monospace">${escapeHtml(gallery.code)}</p>
    <p style="margin:0 0 24px;font-size:13px;color:#6b645a">If the button doesn't open, go to ${escapeHtml(env.APP_URL)}/login and enter the code, or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(gallery.link)}</span></p>
    ${closing.map(p).join("")}</div>`

  return send({
    to,
    subject: `Thank you, ${name}: your photographs are ready · ${ref}`,
    text: [...lines, `Your private gallery: ${gallery.link}`, typeIt, "The QR code for the gallery is attached, ready to print on table cards.", ...closing].join("\n\n"),
    html,
    attachments: [
      { filename: "gallery-qr.png", content: qr, contentType: "image/png", cid },
    ],
  })
}

/**
 * The studio shares an event's gallery from the panel (Uploads, the share button on an event;
 * services/sharegallery.js): the private link, the gallery code, its QR code (inline, and attached
 * to print), and step by step how to open, favourite, download and share the photos.
 *   name     the client's name, or null when it went to an address that isn't the client's on record
 *   event    { name, date: "YYYY-MM-DD", venue }
 *   gallery  { link, code, expiresAt, maxUsers }
 *   message  an optional note from the staff member; from: their name
 */
async function sendGalleryShareEmail({ to, name, event, gallery, message, from }) {
  const where = event.venue ? ` at ${event.venue}` : ""
  const intro = `Your photographs and videos from ${event.name}, ${longDay(event.date)}${where}, are ready in a private online gallery.`
  const steps = [
    `Open the gallery: press "Open your gallery" below, or scan the QR code with your phone's camera. No account or password is needed.`,
    `No link to hand? Go to ${env.APP_URL}/login, type your gallery code under "Have a gallery code?" (or press the camera button and scan the QR code), then slide to open your gallery.`,
    "Look through the albums. Tap the heart on a photo to keep it in your Favourites.",
    "To save photos, select the ones you want (or all of them) and press Download. One photo downloads as it is; several arrive together as one .zip file, always at full quality.",
    "Share the link or the QR code with your guests so they can see the day too. Keep it among the people you invited: anyone with the code can open the gallery.",
  ]
  const limits = [
    gallery.expiresAt ? `The gallery stays open until ${longDay(new Date(gallery.expiresAt).toISOString().slice(0, 10))}.` : null,
    gallery.maxUsers ? `Up to ${gallery.maxUsers} ${gallery.maxUsers === 1 ? "person" : "people"} can view it at the same time.` : null,
  ].filter(Boolean)
  const note = message ? `A note from ${from || "the studio"}:\n${message}` : null
  const closing = ["If anything doesn't open, reply to this email and we will help.", `With warm wishes,\nThe ${env.APP_NAME} team`]

  const qr = await QRCode.toBuffer(gallery.link, { width: 480, margin: 2, errorCorrectionLevel: "M", color: { dark: "#1d1a16", light: "#ffffff" } })
  const cid = "gallery-share-qr@actionify"
  const p = (t, style = "margin:0 0 16px") => `<p style="${style}">${escapeHtml(t).replace(/\n/g, "<br>")}</p>`
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#1d1a16;max-width:520px">
    <p style="font-family:Georgia,serif;font-size:20px;margin:0 0 20px">${escapeHtml(env.APP_NAME)}</p>
    ${p(name ? `Hi ${name},` : "Hello,")}${p(intro)}
    ${note ? p(note, "margin:0 0 16px;padding:12px 14px;background:#f4efe6;border-radius:10px") : ""}
    <p style="margin:24px 0"><a href="${escapeHtml(gallery.link)}" style="background:#1d1a16;color:#f7f3ec;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600;display:inline-block">Open your gallery</a></p>
    <p style="margin:0 0 8px"><img src="cid:${cid}" width="200" height="200" alt="QR code for your gallery" style="display:block;border:1px solid #e4ddd0;border-radius:12px"></p>
    <p style="margin:0 0 24px;font-size:13px;color:#6b645a">Scan to open the gallery. The QR code is attached too, ready to print on table cards.</p>
    <p style="margin:0 0 4px;font-size:13px;color:#6b645a">Your gallery code</p>
    <p style="margin:0 0 24px;font-size:22px;font-weight:700;letter-spacing:3px;font-family:ui-monospace,Consolas,monospace">${escapeHtml(gallery.code)}</p>
    <p style="font-family:Georgia,serif;font-size:17px;margin:0 0 10px">How to see and download your photos</p>
    <ol style="margin:0 0 20px;padding-left:20px">${steps.map((s) => `<li style="margin:0 0 8px">${escapeHtml(s)}</li>`).join("")}</ol>
    ${limits.map((t) => p(t)).join("")}
    <p style="margin:0 0 24px;font-size:13px;color:#6b645a">If the button doesn't open, paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(gallery.link)}</span></p>
    ${closing.map((t) => p(t)).join("")}</div>`

  const text = [
    name ? `Hi ${name},` : "Hello,",
    intro,
    ...(note ? [note] : []),
    `Your private gallery: ${gallery.link}`,
    `Your gallery code: ${gallery.code}`,
    `How to see and download your photos\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    ...limits,
    "The QR code for the gallery is attached, ready to print on table cards.",
    ...closing,
  ].join("\n\n")

  return send({
    to,
    subject: `Your photos from ${event.name} are ready to view`,
    text,
    html,
    attachments: [{ filename: "gallery-qr.png", content: qr, contentType: "image/png", cid }],
  })
}

/** 125000 → "NRs. 1,25,000"; 2500.5 → "NRs. 2,500.50" (lakh grouping, as in Nepal). */
const npr = (n) =>
  `NRs. ${Number(n).toLocaleString("en-IN", { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`

/**
 * The studio asks the client to pay (the panel's Clients page, Payment): the amount, what it is for
 * (an advance or the full payment) and the studio's own payment QR (eSewa, Khalti, Fonepay or a
 * bank's), shown in the email and attached. qr: { body: Buffer, contentType }.
 */
function sendPaymentRequestEmail({ to, name, ref, type, day, venue, amount, kind, note, paidSoFar, qr }) {
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[qr.contentType] ?? "png"
  const cid = "payment-qr@actionify"
  const lines = [
    `Hi ${name},`,
    `We charge ${npr(amount)} for your event photography or editing.`,
    kind === "advance"
      ? `This is the advance for your ${type.toLowerCase()} on ${longDay(day)} at ${venue}.`
      : `This is the full payment for your ${type.toLowerCase()} on ${longDay(day)} at ${venue}.`,
    ...(paidSoFar > 0 ? [`We have already received ${npr(paidSoFar)} from you. Thank you.`] : []),
    ...(note ? [`A note from the studio: ${note}`] : []),
    `To pay, scan the QR code below with eSewa, Khalti, Fonepay or your bank's app, enter ${npr(amount)} and write ${ref} in the remarks, so we can match your payment to your booking.`,
  ]
  const closing = [`Your booking reference is ${ref}. If you have any question about this payment, reply to this email.`, `With warm wishes,\nThe ${env.APP_NAME} team`]
  const p = (t) => `<p style="margin:0 0 16px">${escapeHtml(t).replace(/\n/g, "<br>")}</p>`
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#1d1a16;max-width:520px">
    <p style="font-family:Georgia,serif;font-size:20px;margin:0 0 20px">${escapeHtml(env.APP_NAME)}</p>${p(lines[0])}
    <p style="margin:0 0 4px;font-size:13px;color:#6b645a">${kind === "advance" ? "Advance" : "Full payment"} · ${escapeHtml(ref)}</p>
    <p style="margin:0 0 20px;font-size:30px;font-weight:700;letter-spacing:.5px">${escapeHtml(npr(amount))}</p>
    ${lines.slice(1).map(p).join("")}
    <p style="margin:8px 0 8px"><img src="cid:${cid}" width="240" alt="The studio's payment QR code" style="display:block;max-width:240px;height:auto;border:1px solid #e4ddd0;border-radius:12px"></p>
    <p style="margin:0 0 24px;font-size:13px;color:#6b645a">The QR code is attached too. Remarks: <b>${escapeHtml(ref)}</b></p>
    ${closing.map(p).join("")}</div>`
  return send({
    to,
    subject: `Payment request · ${npr(amount)} · ${ref}`,
    text: [...lines, "The studio's payment QR code is attached.", ...closing].join("\n\n"),
    html,
    attachments: [{ filename: `payment-qr-${ref}.${ext}`, content: qr.body, contentType: qr.contentType, cid }],
  })
}

/** What each one-time code is for (2FA later): subject and the sentence above the code. */
const OTP_COPY = {
  login_2fa: {
    subject: (code) => `${code} is your ${env.APP_NAME} sign-in code`,
    intro: `use this code to finish signing in to ${env.APP_NAME}:`,
  },
}

function sendOtpEmail({ to, name, code, purpose }) {
  const copy = OTP_COPY[purpose]
  const after = [
    `The code works for ${humanDuration(env.OTP_EXPIRES_IN)}. Never share it: ${env.APP_NAME} will never ask you for it.`,
    "If you didn't request this, you can ignore this email.",
  ]
  const intro = `Hi ${name}, ${copy.intro}`
  return send({ to, subject: copy.subject(code), text: `${intro}\n\n    ${code}\n\n${after.join("\n\n")}`, html: layout([intro, ...after], { code }) })
}

/**
 * Sends without failing the request: a new link can always be asked for, so a
 * mail outage is logged instead of becoming a 500.
 */
async function deliver(sending) {
  try {
    await sending
  } catch (err) {
    console.error("Email could not be sent:", err.message)
  }
}

module.exports = {
  sendVerificationLinkEmail,
  sendAccountExistsEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendAccountApprovedEmail,
  sendAccountLockedEmail,
  sendOtpEmail,
  sendCrewAssignedEmail,
  sendEventCompletedEmail,
  sendGalleryShareEmail,
  sendPaymentRequestEmail,
  npr,
  deliver,
  humanDuration,
}
