'use strict';
// Attachment resolution for the SMTP sender: an entry is either an http(s) URL
// (fetched here behind an SSRF guard, see fetchUrl.js) or a file inside the
// attachment folder. data:/file: URIs, other schemes and paths that resolve
// (symlinks followed) outside the folder are refused.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchAttachment } = require('./fetchUrl');

/** The folder attachments are read from: ATTACHMENTS_DIR, else <tmp>/beeflow-attachments. */
function attachmentRoot(env = process.env) {
  return env.ATTACHMENTS_DIR || path.join(os.tmpdir(), 'beeflow-attachments');
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/** ATTACHMENT_MAX_BYTES: default 25 MB, 0 = unlimited. */
function maxBytes(env = process.env) {
  const n = Number(env.ATTACHMENT_MAX_BYTES);
  return env.ATTACHMENT_MAX_BYTES !== undefined && env.ATTACHMENT_MAX_BYTES !== '' && Number.isFinite(n) && n >= 0
    ? n
    : 25 * 1024 * 1024;
}

/**
 * Turns the comma-separated `attachments` input into nodemailer attachments
 * with the content already loaded, so nodemailer never opens a path or URL.
 * Relative file entries are resolved against the attachment folder, which is
 * created when missing.
 */
async function resolveAttachments(list, root = attachmentRoot(), deps = {}) {
  if (list.length === 0) return [];
  const limit = deps.maxBytes ?? maxBytes();
  let realRoot;
  try {
    fs.mkdirSync(root, { recursive: true });
    realRoot = fs.realpathSync(root);
  } catch {
    throw new Error(`Attachment folder not available: ${root}`);
  }
  const out = [];
  for (const entry of list) {
    if (/^https?:\/\//i.test(entry)) {
      out.push(await fetchAttachment(entry, { maxBytes: limit }, deps));
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry) || /^(data|file):/i.test(entry)) {
      throw new Error(`Attachment '${entry}' rejected: only http(s) URLs and files in the attachment folder can be attached`);
    }
    let real;
    try {
      real = fs.realpathSync(path.resolve(realRoot, entry));
    } catch {
      throw new Error(`Attachment '${entry}' not found in the attachment folder`);
    }
    if (!isInside(realRoot, real)) {
      throw new Error(`Attachment '${entry}' rejected: it is outside the attachment folder`);
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) {
      throw new Error(`Attachment '${entry}' rejected: not a regular file`);
    }
    if (limit > 0 && stat.size > limit) {
      throw new Error(`Attachment '${entry}' too large (limit ${limit} bytes, ATTACHMENT_MAX_BYTES)`);
    }
    out.push({ filename: path.basename(entry), content: fs.readFileSync(real) });
  }
  return out;
}

module.exports = { attachmentRoot, resolveAttachments };
