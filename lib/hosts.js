'use strict';

/**
 * FAF's host names, all under one base domain.
 *
 * FAF runs this site twice (gitops-stack apps/faf-webclient): at
 * webclient.faforever.com, and for testing at webclient.faforever.xyz, which
 * must talk to FAF's test servers (api.faforever.xyz, hydra.faforever.xyz, ...)
 * rather than the real ones. FAF_BASE_DOMAIN says which; the cluster sets it
 * from its own baseDomain. Unset, it is faforever.com.
 */

const BASE_DOMAIN = (process.env.FAF_BASE_DOMAIN || '').trim().toLowerCase() || 'faforever.com';

if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(BASE_DOMAIN)) {
  throw new Error(`FAF_BASE_DOMAIN is not a domain name: "${BASE_DOMAIN}"`);
}

/** https://<sub>.<base domain>, e.g. fafUrl('api') -> https://api.faforever.com */
function fafUrl(sub, scheme = 'https') {
  return `${scheme}://${sub}.${BASE_DOMAIN}`;
}

module.exports = { BASE_DOMAIN, fafUrl };
