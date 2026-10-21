'use strict';
// Fetches an http(s) attachment for the SMTP sender without reaching internal
// addresses. The URL comes from a workflow author or an agent, so every hop
// (the first URL and each redirect) is resolved here, every resolved address
// must be public, and the socket is then pinned to the address that was
// checked (no second lookup, so no DNS rebinding). Size and time are capped.
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30000;

const BLOCKED = new net.BlockList();
for (const [net4, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) BLOCKED.addSubnet(net4, bits, 'ipv4');
for (const [net6, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]]) {
  BLOCKED.addSubnet(net6, bits, 'ipv6');
}

/** True when `ip` is not a public unicast address (fail-closed on anything unparsable). */
function isForbiddenAddress(ip) {
  const a = String(ip || '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = net.isIP(a);
  if (family === 0) return true;
  // BlockList folds IPv4-mapped IPv6 onto the IPv4 rules; the deprecated ::a.b.c.d form it does not.
  if (family === 6 && /^::\d+\.\d+\.\d+\.\d+$/.test(a)) return true;
  return BLOCKED.check(a, family === 6 ? 'ipv6' : 'ipv4');
}

function refused(host) {
  return new Error(`Attachment URL refused: ${host} resolves to a private or internal address`);
}

/** Resolves a hop and returns the address to pin; throws when any address is forbidden. */
async function checkHop(url, lookup) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Attachment URL refused: only http(s) URLs are allowed');
  }
  if (url.username || url.password) throw new Error('Attachment URL refused: embedded credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(host)) {
    if (isForbiddenAddress(host)) throw refused(host);
    return { address: host, family: net.isIP(host) };
  }
  let list;
  try {
    list = await lookup(host);
  } catch {
    throw new Error(`Attachment URL could not be resolved: ${host}`);
  }
  if (!Array.isArray(list) || list.length === 0) throw new Error(`Attachment URL could not be resolved: ${host}`);
  if (list.some((r) => !r || isForbiddenAddress(r.address))) throw refused(host);
  return { address: list[0].address, family: list[0].family || net.isIP(list[0].address) };
}

/** Default transport: one GET whose socket connects to exactly `address`. */
function httpGet({ url, address, family }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      agent: false,
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'BeeFlow-SMTP-Attachment/1.0', Accept: '*/*' },
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
    }, (res) => resolve({ status: res.statusCode, headers: res.headers, body: res }));
    req.on('timeout', () => req.destroy(new Error('Attachment download timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function readCapped(body, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (maxBytes > 0 && size > maxBytes) {
      body.destroy();
      throw new Error(`Attachment too large (limit ${maxBytes} bytes, ATTACHMENT_MAX_BYTES)`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Filename from Content-Disposition, else the URL path basename, else "attachment". */
function attachmentFilename(disposition, url) {
  // Split on ';' instead of a regex: a real header is short, so cap it too.
  const params = {};
  for (const part of String(disposition || '').slice(0, 1024).split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  let name = '';
  try {
    const star = params['filename*'];
    const plain = params.filename;
    if (star) name = decodeURIComponent(star.slice(star.lastIndexOf("'") + 1));
    else if (plain) name = plain.replace(/^"|"$/g, '');
  } catch { name = ''; }
  if (!name) {
    try { name = decodeURIComponent(path.posix.basename(url.pathname)); } catch { name = path.posix.basename(url.pathname); }
  }
  name = name.replace(/\\/g, '/').split('/').pop().replace(/[\r\n\0]/g, '').trim();
  return name || 'attachment';
}

/**
 * @param {string} rawUrl
 * @param {{ maxBytes?: number }} [opts]  maxBytes 0 = unlimited
 * @param {{ lookup?: Function, httpGet?: Function }} [deps]  for tests
 * @returns {Promise<{ filename: string, content: Buffer, contentType?: string }>}
 */
async function fetchAttachment(rawUrl, { maxBytes = 0 } = {}, deps = {}) {
  const lookup = deps.lookup || ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));
  const get = deps.httpGet || httpGet;
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error(`Attachment URL is invalid: ${rawUrl}`); }
  for (let hop = 0; ; hop++) {
    const { address, family } = await checkHop(url, lookup);
    const res = await get({ url, address, family });
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location) {
      res.body.resume();
      if (hop >= MAX_REDIRECTS) throw new Error('Attachment URL: too many redirects');
      url = new URL(location, url);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      res.body.resume();
      throw new Error(`Attachment download failed with status ${res.status}`);
    }
    const declared = Number(res.headers['content-length']);
    if (maxBytes > 0 && declared > maxBytes) {
      res.body.destroy();
      throw new Error(`Attachment too large (limit ${maxBytes} bytes, ATTACHMENT_MAX_BYTES)`);
    }
    const content = await readCapped(res.body, maxBytes);
    const contentType = res.headers['content-type'] || undefined;
    return { filename: attachmentFilename(res.headers['content-disposition'], url), content, contentType };
  }
}

module.exports = { fetchAttachment, isForbiddenAddress, attachmentFilename };
