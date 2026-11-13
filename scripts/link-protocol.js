'use strict';

/**
 * Takes the Rust client's PC link contract into test/, pinned to one commit.
 *
 *   node scripts/link-protocol.js <commit, branch or tag>
 *
 * The contract is generated in FAForeverRustClient/FAForeverRustClient
 * (docs/web-link-protocol.json, written by
 * crates/faf-domain/tests/web_link_protocol.rs). webtest.js checks lib/link.js
 * against the copy in test/ ("link protocol"), so when the Rust client changes
 * the link, take its new file with this, then change lib/link.js until the
 * suite passes again. A branch or tag is resolved to its commit, and the
 * commit is what test/web-link-protocol.commit records.
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const REPO = 'FAForeverRustClient/FAForeverRustClient';
const FILE = 'docs/web-link-protocol.json';
const OUT = path.join(__dirname, '..', 'test');

function get(url, accept) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: accept, 'User-Agent': 'faf-webclient' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) reject(new Error(url + ' answered ' + res.statusCode));
        else resolve(body);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  const ref = process.argv[2];
  if (!ref || !/^[\w./-]{1,100}$/.test(ref)) {
    console.error('usage: node scripts/link-protocol.js <commit, branch or tag>');
    process.exit(2);
  }
  const sha = (await get(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`, 'application/vnd.github.sha')).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('not a commit: ' + sha.slice(0, 80));
  const text = await get(`https://raw.githubusercontent.com/${REPO}/${sha}/${FILE}`, 'application/json');
  const fixture = JSON.parse(text);
  if (typeof fixture.version !== 'number' || !Array.isArray(fixture.commands)) throw new Error('not the link contract');
  fs.writeFileSync(path.join(OUT, 'web-link-protocol.json'), text);
  fs.writeFileSync(path.join(OUT, 'web-link-protocol.commit'), sha + '\n');
  console.log(`test/web-link-protocol.json is ${REPO}@${sha.slice(0, 12)}. Now run npm test.`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
