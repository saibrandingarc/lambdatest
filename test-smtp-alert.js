/**
 * Sends one test message using the same env rules as playwright-single.js sendFailureAlertEmail.
 * Run: npm run test:alert-email
 */
require('dotenv').config();

function getRequiredEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing required env: ${name}`);
  return String(v).trim();
}

(async () => {
  const host = getRequiredEnv('ALERT_SMTP_HOST');
  const to = getRequiredEnv('ALERT_EMAIL_TO');
  const from = String(process.env.ALERT_EMAIL_FROM || process.env.IMAP_USER || '').trim();
  if (!from) {
    throw new Error('Set ALERT_EMAIL_FROM or IMAP_USER');
  }
  const smtpUser = String(process.env.ALERT_SMTP_USER || process.env.IMAP_USER || '').trim();
  const smtpPass = String(
    process.env.ALERT_SMTP_PASS || process.env.EMAIL_APP_PSWD || process.env.IMAP_PASS || ''
  ).trim();
  if (smtpUser && !smtpPass) {
    throw new Error('Set ALERT_SMTP_PASS, or EMAIL_APP_PSWD / IMAP_PASS for the SMTP user');
  }

  const port = Number(process.env.ALERT_SMTP_PORT || 587);
  const secure = /^1|true|yes$/i.test(String(process.env.ALERT_SMTP_SECURE ?? '').trim());

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined,
  });

  await transporter.sendMail({
    from,
    to,
    subject: '[TEST] Playwright SMTP probe',
    text: `If you received this, SMTP settings are OK.\n\nTime: ${new Date().toISOString()}\nHost: ${host}:${port} secure=${secure}`,
  });

  console.log('OK — test email sent to:', to);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
