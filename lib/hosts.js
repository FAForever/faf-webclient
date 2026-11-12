'use strict';

/**
 * FAF's host names, all under one base domain, and the addresses this server
 * itself uses to reach FAF's services.
 *
 * FAF runs this site twice (gitops-stack apps/faf-webclient): at
 * webclient.faforever.com, and for testing at webclient.faforever.xyz, which
 * must talk to FAF's test servers (api.faforever.xyz, hydra.faforever.xyz, ...)
 * rather than the real ones. FAF_BASE_DOMAIN says which; the cluster sets it
 * from its own baseDomain. Unset, it is faforever.com.
 *
 * The public addresses go through Cloudflare, whose anti-spam checks refuse
 * requests from a server. So inside FAF's cluster the server calls FAF's
 * services by their cluster-internal names instead (`serverUrl`). Links and
 * images the browser loads keep using the public addresses (`fafUrl`).
 */

const http = require('http');
const https = require('https');

const BASE_DOMAIN = (process.env.FAF_BASE_DOMAIN || '').trim().toLowerCase() || 'faforever.com';

if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(BASE_DOMAIN)) {
  throw new Error(`FAF_BASE_DOMAIN is not a domain name: "${BASE_DOMAIN}"`);
}

/** https://<sub>.<base domain>, e.g. fafUrl('api') -> https://api.faforever.com */
function fafUrl(sub, scheme = 'https') {
  return `${scheme}://${sub}.${BASE_DOMAIN}`;
}

// Kubernetes sets this in every pod, so it tells FAF's cluster (and a local
// Tilt cluster, which has the same services) from anywhere else.
const IN_CLUSTER = Boolean(process.env.KUBERNETES_SERVICE_HOST);

// The services' names and ports in the faf-apps namespace, which this app is
// deployed into too (gitops-stack apps/<name>/templates/service.yaml).
const INTERNAL = {
  api: 'http://faf-api:8010',
  hydra: 'http://ory-hydra:4444',
  user: 'http://faf-user-service:8080',
  www: 'http://faf-website:3000',
  tournaments: 'http://faf-tournaments:8090'
};

// Each can also be set by hand, e.g. for a cluster where a name differs.
const OVERRIDES = {
  api: 'FAF_API_URL',
  hydra: 'FAF_HYDRA_URL',
  user: 'FAF_USER_SERVICE_URL',
  www: 'FAF_WEBSITE_URL',
  tournaments: 'FAF_TOURNAMENTS_URL',
  lobby: 'FAF_LOBBY_URL'
};

function override(sub) {
  const name = OVERRIDES[sub];
  const value = name ? (process.env[name] || '').trim().replace(/\/+$/, '') : '';
  if (!value) return null;
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(value)) {
    throw new Error(`${name} must be a plain http(s)://host[:port] address, got "${value}"`);
  }
  return value;
}

/** Where this server reaches a FAF service: set by hand, cluster-internal, or public. */
function serverUrl(sub) {
  return override(sub) || (IN_CLUSTER && INTERNAL[sub]) || fafUrl(sub);
}

/** Node's http or https module, whichever the URL needs. */
function transport(url) {
  return String(url).startsWith('http:') ? http : https;
}

module.exports = { BASE_DOMAIN, IN_CLUSTER, fafUrl, serverUrl, transport };
