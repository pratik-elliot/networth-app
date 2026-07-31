const nodemailer = require("nodemailer");

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendOtpEmail(toEmail, code) {
  const subject = "Your Net Worth Ledger verification code";
  const text = `Your verification code is ${code}. It expires in ${process.env.OTP_TTL_MINUTES || 10} minutes.`;

  if (!transporter) {
    // Dev fallback: no SMTP configured, so log instead of sending.
    console.log(`\n[DEV MODE — no SMTP configured] OTP for ${toEmail}: ${code}\n`);
    return { delivered: false, devMode: true };
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || "Net Worth Ledger <no-reply@example.com>",
    to: toEmail,
    subject,
    text,
  });
  return { delivered: true, devMode: false };
}

module.exports = { sendOtpEmail };
