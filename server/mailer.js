const nodemailer = require('nodemailer');

// Outgoing email (invoices) through the owner's own mailbox. Off until both
// EMAIL_USER and EMAIL_APP_PASSWORD are set (see .env.example) — the portal
// then falls back to opening a Gmail compose window instead. Defaults to
// Gmail's SMTP server; SMTP_HOST/SMTP_PORT point it at another provider.
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD || '';
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || 'QueenCity Auto-Rentals';

let transport = null;
function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT) || 465;
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
    });
  }
  return transport;
}

function emailConfigured() {
  return !!(EMAIL_USER && EMAIL_APP_PASSWORD);
}

// Replies go back to the owner's mailbox, same as the From address.
async function sendEmail({ to, subject, text, html }) {
  if (!emailConfigured()) throw new Error('Email sending is not set up');
  return getTransport().sendMail({
    from: { name: EMAIL_FROM_NAME, address: EMAIL_USER },
    to, subject, text, html,
  });
}

module.exports = { emailConfigured, sendEmail, EMAIL_FROM_NAME };
