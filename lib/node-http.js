// Node-only HTTP helpers. They use node:https rather than fetch() so we can
// prefer IPv4: on some machines DNS hands back only IPv6 addresses that aren't
// actually routable.

import dns from 'node:dns';
import https from 'node:https';
import zlib from 'node:zlib';
import { USER_AGENT } from './sportsconnect.js';

export function getJson(url, { timeoutMs = 30_000 } = {}) {
  return getBody(url, { Accept: 'application/json' }, timeoutMs).then((text) => JSON.parse(text));
}

function getBody(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip', ...headers },
      lookup: lookupPreferV4,
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(getBody(new URL(res.headers.location, url).href, headers, timeoutMs));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${res.statusCode} ${res.statusMessage} from ${url}`));
      }
      const body = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      const chunks = [];
      body.on('data', (c) => chunks.push(c));
      body.on('error', reject);
      body.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error(`Timed out fetching ${url}`)));
    req.on('error', reject);
  });
}

function lookupPreferV4(host, opts, cb) {
  dns.lookup(host, { ...opts, family: 4 }, (err, ...rest) =>
    (err ? dns.lookup(host, opts, cb) : cb(null, ...rest)));
}

export async function discoverPortal(site) {
  const html = await getBody(site + '/', {}, 20_000);
  const id = html.match(/portalid=(\d+)/i)?.[1];
  if (!id) throw new Error(`Could not find a SportsConnect portal id on ${site}; set SC_PORTAL_ID.`);
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || '';
  return { portalId: id, title: title.replace(/\s*[|>].*$/, '').trim() };
}
