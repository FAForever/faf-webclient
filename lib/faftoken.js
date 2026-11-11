'use strict';

/**
 * The service login for FAF's API.
 *
 * Every /data/* read on api.faforever.com needs a bearer token; only replay
 * downloads are anonymous (FAForever/faf-java-api, WebSecurityConfig). FAF's
 * own website reads public data the same way: an OAuth client_credentials
 * client of its own (gitops-stack apps/ory-hydra, "FAF Website (public)").
 *
 * The token lives only in this process. It is attached to upstream requests
 * to api.faforever.com and never sent to a browser.
 *
 * Configured with FAF_API_CLIENT_ID and FAF_API_CLIENT_SECRET. Without them
 * the tabs that need the API say so instead of failing.
 */

const https = require('https');

const DEFAULT_TOKEN_URL = 'https://hydra.faforever.com/oauth2/token';
const TIMEOUT_MS = 15_000;
// Renew this long before the token actually expires.
const EXPIRY_MARGIN_MS = 60_000;

function postForm(url, form, { timeoutMs = TIMEOUT_MS } = {}) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json',
        'User-Agent': 'faf-web'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('token request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Returns null when no client is configured, so callers can tell "not set up"
 * apart from "set up but failing".
 */
function createTokenSource({ clientId, clientSecret, tokenUrl = DEFAULT_TOKEN_URL, postImpl = postForm, now = Date.now } = {}) {
  if (!clientId || !clientSecret) return null;

  let token = null;
  let expiresAt = 0;
  let pending = null;

  async function fetchToken() {
    const res = await postImpl(tokenUrl, {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'public_profile'
    });
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch (_) { /* reported below */ }
    if (res.status !== 200 || !parsed || typeof parsed.access_token !== 'string') {
      // Hydra's error text is safe to log; it never contains the secret.
      const reason = parsed && (parsed.error_description || parsed.error);
      throw new Error('token request failed: ' + res.status + (reason ? ' ' + reason : ''));
    }
    const lifetimeMs = Math.max(0, Number(parsed.expires_in || 0) * 1000);
    token = parsed.access_token;
    expiresAt = now() + Math.max(0, lifetimeMs - EXPIRY_MARGIN_MS);
    return token;
  }

  return {
    /** A valid token; concurrent callers share one token request. */
    async get() {
      if (token && now() < expiresAt) return token;
      if (!pending) {
        pending = fetchToken().finally(() => { pending = null; });
      }
      return pending;
    },
    /** Drop the cached token, e.g. after the API answered 401. */
    invalidate() {
      token = null;
      expiresAt = 0;
    }
  };
}

module.exports = { createTokenSource, postForm, DEFAULT_TOKEN_URL };
