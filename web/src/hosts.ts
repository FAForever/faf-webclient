// FAF's host names for links and images. FAF runs this site against its real
// servers (faforever.com) and its test servers (faforever.xyz); the server
// says which in /api/config (lib/hosts.js), and main.tsx sets it before the
// first render.

let baseDomain = "faforever.com";

export function setBaseDomain(domain: unknown) {
  if (typeof domain === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) baseDomain = domain;
}

/** https://<sub>.<base domain>, e.g. fafUrl("replay") -> https://replay.faforever.com */
export function fafUrl(sub: string): string {
  return `https://${sub}.${baseDomain}`;
}
