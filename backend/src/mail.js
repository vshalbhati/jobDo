// Outgoing email. Any SMTP server will do; the in-memory providers keep what
// would have been sent in `outbox`, so tests can read it.
import nodemailer from 'nodemailer';
import { config } from './config.js';

export const outbox = [];

export const mailConfigured = () =>
  config.providers === 'memory' || !!(config.smtpHost && config.smtpUser && config.smtpPass);

let transport = null;

export async function sendMail({ to, subject, html, text }) {
  if (config.providers === 'memory') {
    outbox.push({ to, subject, html, text });
    return;
  }
  if (!mailConfigured()) throw new Error('Email is not set up on this server (SMTP_HOST, SMTP_USER, SMTP_PASS).');
  transport = transport || nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass }
  });
  await transport.sendMail({ from: config.mailFrom || 'jobDo <' + config.smtpUser + '>', to, subject, html, text });
}
