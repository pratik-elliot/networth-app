const nodemailer = require("nodemailer");

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 15000;

// Resend's sandbox sender works without verifying a domain, but it can only
// deliver to the address that owns the Resend account. Verify your own domain
// in Resend to send anywhere else, then set MAIL_FROM to an address on it.
const DEFAULT_FROM = "Net Worth Ledger <onboarding@resend.dev>";

function fromAddress() {
  return process.env.MAIL_FROM || process.env.SMTP_FROM || DEFAULT_FROM;
}

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Fail fast rather than holding the login request open for minutes when the
    // SMTP port is unreachable. Render's free instances block outbound
    // 25/465/587, which otherwise surfaces as a ~2 minute hang before ETIMEDOUT.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

/* Sends over HTTPS (port 443), which hosts that block outbound SMTP still allow. */
async function sendViaResend(toEmail, subject, text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: fromAddress(), to: [toEmail], subject, text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Resend API returned ${res.status} ${res.statusText}. ${detail.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function sendViaSmtp(toEmail, subject, text) {
  await transporter.sendMail({ from: fromAddress(), to: toEmail, subject, text });
}

async function sendOtpEmail(toEmail, code) {
  const subject = "Your Net Worth Ledger verification code";
  const text = `Your verification code is ${code}. It expires in ${process.env.OTP_TTL_MINUTES || 10} minutes.`;

  // Prefer the HTTP API: it works even where outbound SMTP ports are blocked.
  const provider = process.env.RESEND_API_KEY ? "resend" : transporter ? "smtp" : null;

  if (!provider) {
    console.log(`\n[DEV MODE — no email provider configured] OTP for ${toEmail}: ${code}\n`);
    return { delivered: false, devMode: true };
  }

  try {
    if (provider === "resend") await sendViaResend(toEmail, subject, text);
    else await sendViaSmtp(toEmail, subject, text);
    return { delivered: true, devMode: false, provider };
  } catch (err) {
    // A mail outage must never crash the process or lock the user out. Log the
    // code so login is still possible while delivery is being sorted out.
    const reason = err.name === "AbortError" ? `timed out after ${SEND_TIMEOUT_MS}ms` : err.message;
    console.error(`[MAIL] Could not send OTP to ${toEmail} via ${provider}: ${reason}${err.code ? ` (${err.code})` : ""}`);
    console.log(`\n[MAIL FALLBACK] OTP for ${toEmail}: ${code}\n`);
    return { delivered: false, devMode: false, provider, error: reason };
  }
}

module.exports = { sendOtpEmail };
