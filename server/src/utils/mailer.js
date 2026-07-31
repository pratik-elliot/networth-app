const nodemailer = require("nodemailer");

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Fail fast rather than holding the login request open for minutes when the
    // SMTP port is unreachable. Render's free instances block outbound 25/465/587,
    // which otherwise surfaces as a ~2 minute hang before ETIMEDOUT.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

async function sendOtpEmail(toEmail, code) {
  const subject = "Your Net Worth Ledger verification code";
  const text = `Your verification code is ${code}. It expires in ${process.env.OTP_TTL_MINUTES || 10} minutes.`;

  if (!transporter) {
    // No SMTP configured: log instead of sending.
    console.log(`\n[DEV MODE — no SMTP configured] OTP for ${toEmail}: ${code}\n`);
    return { delivered: false, devMode: true };
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || "Net Worth Ledger <no-reply@example.com>",
      to: toEmail,
      subject,
      text,
    });
    return { delivered: true, devMode: false };
  } catch (err) {
    // A mail outage must never crash the process or lock the user out. Log the
    // code so login is still possible while delivery is being sorted out.
    console.error(`[MAIL] Could not send OTP to ${toEmail}: ${err.message} (${err.code || "no code"})`);
    console.log(`\n[MAIL FALLBACK] OTP for ${toEmail}: ${code}\n`);
    return { delivered: false, devMode: false, error: err.message };
  }
}

module.exports = { sendOtpEmail };
