// Sealing secrets a person hands us - their Gmail app password - before they
// reach the database.
//
// AES-256-GCM with MAIL_SECRET_KEY, a key that lives only in the backend's
// environment. The database (and any backup or SQL console) holds only the
// sealed form. The account id is bound in as associated data, so a sealed
// value copied onto another account will not open there.
//
//   v1.<iv>.<auth tag>.<ciphertext>     each part base64url
//
// Make a key with:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
import crypto from 'node:crypto';
import { config } from './config.js';

const VERSION = 'v1';

export const vaultReady = () => !!config.mailSecretKey;

const aad = (userId) => Buffer.from('jobdo:mailbox:' + String(userId));

export function seal(plain, userId) {
  if (!vaultReady()) throw new Error('MAIL_SECRET_KEY is not set on this server.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.mailSecretKey, iv);
  cipher.setAAD(aad(userId));
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

// Throws if the value was tampered with, sealed for another account, or
// sealed with a different key.
export function open(sealed, userId) {
  if (!vaultReady()) throw new Error('MAIL_SECRET_KEY is not set on this server.');
  const [v, iv, tag, ct] = String(sealed || '').split('.');
  if (v !== VERSION || !iv || !tag || !ct) throw new Error('not a sealed value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.mailSecretKey, Buffer.from(iv, 'base64url'));
  decipher.setAAD(aad(userId));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
