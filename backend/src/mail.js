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

// ------------------------------------------------------- from your own Gmail
//
// Mail to the hiring team goes out from the person's own Gmail (or Google
// Workspace) account, with an app password they gave in Settings, so it
// comes from them and replies reach them. A fresh connection each time: these
// are rare, and no account's credentials stay in memory between requests.

// The password Gmail rejects in the in-memory test backend.
export const TEST_WRONG_PASSWORD = 'wrongwrongwrongw';

const authFailed = () => Object.assign(
  new Error('Gmail did not accept that address and app password.'), { code: 'EAUTH' });

function gmail({ address, password }) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: address, pass: password },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
  });
}

const isAuthError = (e) => e && (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534);

// Checks the address and app password without sending anything.
export async function verifyAccount(account) {
  if (config.providers === 'memory') {
    if (account.password === TEST_WRONG_PASSWORD) throw authFailed();
    return;
  }
  const t = gmail(account);
  try {
    await t.verify();
  } catch (e) {
    throw isAuthError(e) ? authFailed() : e;
  } finally {
    t.close();
  }
}

export async function sendAs(account, { to, subject, text, attachments = [] }) {
  if (config.providers === 'memory') {
    if (account.password === TEST_WRONG_PASSWORD) throw authFailed();
    outbox.push({ from: account.address, replyTo: account.address, to, subject, text, attachments });
    return;
  }
  const t = gmail(account);
  try {
    await t.sendMail({ from: account.address, replyTo: account.address, to, subject, text, attachments });
  } catch (e) {
    throw isAuthError(e) ? authFailed() : e;
  } finally {
    t.close();
  }
}
