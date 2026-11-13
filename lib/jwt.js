'use strict';

/**
 * Checking a token FAF's login server signed, without asking anyone: FAF's
 * login server (Ory Hydra) issues JWTs and publishes the keys that sign them at
 * /.well-known/jwks.json. RS256 only, which is what Hydra signs with.
 *
 * Used by the PC link (lib/link.js) to learn which FAF account a desktop
 * client belongs to, from its OIDC ID token (verifyIdToken): signed by Hydra,
 * issued to (`aud`) the client it claims to be, and NOT an access token. An ID
 * token names the player and can do nothing as them: neither the API nor the
 * lobby accepts one, so this server never holds anything that could.
 */

const crypto = require('crypto');
const { transport } = require('./hosts');

const TIMEOUT_MS = 10_000;
const MAX_JWKS_BYTES = 64 * 1024;
/** Keys are kept this long, and refetched sooner only for an unknown key id. */
const JWKS_TTL_MS = 60 * 60 * 1000;
/** At most one refetch for an unknown key id per this long. */
const REFETCH_MIN_MS = 60 * 1000;
/** Clock difference tolerated between this server and Hydra. */
const LEEWAY_SECONDS = 60;

class TokenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function base64urlJson(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = transport(url).get(url, { headers: { Accept: 'application/json', 'User-Agent': 'faf-webclient' } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_JWKS_BYTES) { res.destroy(); reject(new Error('key set too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error('key set answered ' + res.statusCode)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (err) { reject(err); }
      });
      res.on('error', reject);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('key set timed out')));
    req.on('error', reject);
  });
}

/**
 * @param {object} options
 * @param {string} options.jwksUrl   where the signing keys are published
 * @param {string[]} options.issuers accepted `iss` values
 * @param {(url: string) => Promise<object>} [options.fetchJson] for tests
 * @param {() => number} [options.now] milliseconds, for tests
 */
function createJwtVerifier({ jwksUrl, issuers, fetchJson = getJson, now = Date.now }) {
  let keys = new Map();
  let fetchedAt = 0;
  let pending = null;

  async function refresh() {
    if (!pending) {
      pending = fetchJson(jwksUrl)
        .then((doc) => {
          const next = new Map();
          for (const jwk of (doc && Array.isArray(doc.keys) ? doc.keys : [])) {
            if (!jwk || jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig') || typeof jwk.kid !== 'string') continue;
            try {
              next.set(jwk.kid, crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' }));
            } catch (_) {
              // A key this server cannot read signs nothing it accepts.
            }
          }
          keys = next;
          fetchedAt = now();
        })
        .finally(() => { pending = null; });
    }
    return pending;
  }

  async function keyFor(kid) {
    const stale = now() - fetchedAt > JWKS_TTL_MS;
    if (stale || (!keys.has(kid) && now() - fetchedAt > REFETCH_MIN_MS)) {
      try {
        await refresh();
      } catch (err) {
        if (!keys.size) throw new TokenError('keys-unavailable', 'FAF login keys could not be read: ' + err.message);
      }
    }
    return keys.get(kid);
  }

  /** The token's claims, or a TokenError saying why not. */
  async function verify(token) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3 || token.length > 8192) throw new TokenError('malformed', 'not a FAF login token');
    const header = base64urlJson(parts[0]);
    const claims = base64urlJson(parts[1]);
    if (!header || !claims || typeof claims !== 'object' || Array.isArray(claims)) throw new TokenError('malformed', 'not a FAF login token');
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new TokenError('malformed', 'unexpected token signature');

    const key = await keyFor(header.kid);
    if (!key) throw new TokenError('unknown-key', 'token not signed by FAF');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new TokenError('bad-signature', 'token not signed by FAF');

    const seconds = Math.floor(now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_SECONDS < seconds) throw new TokenError('expired', 'token expired');
    if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_SECONDS > seconds) throw new TokenError('not-yet-valid', 'token not valid yet');
    const iss = String(claims.iss || '').replace(/\/+$/, '');
    if (!issuers.some((accepted) => accepted.replace(/\/+$/, '') === iss)) throw new TokenError('wrong-issuer', 'token from another login server');
    return claims;
  }

  /** An ID token's claims, from verify and then checkIdToken. */
  async function verifyIdToken(token, clientIds) {
    return checkIdToken(await verify(token), clientIds);
  }

  return { verify, verifyIdToken };
}

/**
 * The claims of an OIDC ID token issued to one of `clientIds`, or a
 * TokenError. Hydra's ID tokens name their client in `aud` (a list, or one
 * string); its access tokens carry `client_id` and `scp` instead, and one is
 * refused even with a good signature: the link must never be handed a token
 * that could act as the player.
 */
function checkIdToken(claims, clientIds) {
  if (claims.scp !== undefined || claims.client_id !== undefined) {
    throw new TokenError('access-token', 'an access token; the link takes the ID token');
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.some((aud) => typeof aud === 'string' && clientIds.includes(aud))) {
    throw new TokenError('wrong-client', 'issued to another program');
  }
  return claims;
}

module.exports = { createJwtVerifier, checkIdToken, TokenError };
