'use strict';

/**
 * Web Push: a notification on a phone, even with the page closed.
 *
 * The browser hands over a "subscription" (an address at its vendor's push
 * service and two keys). Sending is an encrypted POST to that address, signed
 * with this server's own key pair so the push service knows the sender:
 *
 *   - encryption: RFC 8291 (Message Encryption for Web Push), aes128gcm
 *   - sender key: RFC 8292 (VAPID), an ES256-signed token
 *
 * The key pair is made when the server starts. Nothing is stored: a browser
 * whose subscription was made for an earlier key signs up again the next time
 * the page is open (web/src/link/push.ts), which it is when somebody starts a
 * search from it. FAF_LINK_VAPID_KEY (a PKCS#8 PEM) keeps one key across
 * restarts instead, for anyone who wants that.
 *
 * Only the push services of the browsers are ever posted to (`allowedEndpoint`):
 * a subscription is something a visitor sends, and this server must not become
 * a way to make requests to anywhere else.
 */

const crypto = require('crypto');
const https = require('https');

const TIMEOUT_MS = 10_000;
const RECORD_SIZE = 4096;

/** The push services of Chrome and Android, Firefox, Safari and iOS, and Edge. */
function allowedEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch (_) { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return host === 'fcm.googleapis.com' ||
    host === 'android.googleapis.com' ||
    host === 'updates.push.services.mozilla.com' ||
    host.endsWith('.push.services.mozilla.com') ||
    host === 'web.push.apple.com' ||
    host.endsWith('.push.apple.com') ||
    host.endsWith('.notify.windows.com');
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * Encrypt a payload for one subscription (RFC 8291, section 3 and 4).
 * `options.senderPrivateKey` and `options.salt` exist for tests only.
 */
function encrypt(payload, keys, options = {}) {
  const uaPublic = Buffer.from(keys.p256dh, 'base64url');
  const authSecret = Buffer.from(keys.auth, 'base64url');
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');

  const sender = crypto.createECDH('prime256v1');
  if (options.senderPrivateKey) sender.setPrivateKey(options.senderPrivateKey);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);
  const salt = options.salt || crypto.randomBytes(16);

  // ikm from the shared secret and the subscription's auth secret.
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  // Content key and nonce, from the salt.
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  // One record: the payload, then the last-record delimiter.
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/**
 * @param {object} options
 * @param {string} options.subject contact for the push services (RFC 8292), an https: or mailto: URL
 * @param {string} [options.privateKeyPem] keep one key across restarts
 * @param {Function} [options.post] for tests: (url, headers, body) => Promise<{status}>
 */
function createWebPush({ subject, privateKeyPem, post = postBody }) {
  const privateKey = privateKeyPem
    ? crypto.createPrivateKey(privateKeyPem)
    : crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  // The uncompressed point: 0x04, x, y. What the browser's subscribe() takes.
  const publicKey = b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));

  function vapidToken(endpoint) {
    const audience = new URL(endpoint).origin;
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64url(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
    const signature = crypto.sign('sha256', Buffer.from(header + '.' + claims), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return header + '.' + claims + '.' + b64url(signature);
  }

  /** Send one notification. Resolves with the push service's status; 404 and 410 mean the subscription is gone. */
  async function send(subscription, message, { ttlSeconds = 120, urgency = 'high', topic } = {}) {
    if (!allowedEndpoint(subscription.endpoint)) throw new Error('not a known push service');
    const body = encrypt(JSON.stringify(message), subscription.keys);
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Content-Length': body.length,
      TTL: String(ttlSeconds),
      Urgency: urgency,
      Authorization: `vapid t=${vapidToken(subscription.endpoint)}, k=${publicKey}`
    };
    if (topic) headers.Topic = topic;
    return post(subscription.endpoint, headers, body);
  }

  return { publicKey, send, vapidToken };
}

function postBody(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode || 0 }));
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('push service timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { createWebPush, encrypt, allowedEndpoint };
