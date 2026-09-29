#!/usr/bin/env node
/**
 * sign.mjs — inject a `signature.jws` into an existing `.bfmod`.
 *
 * Reads integrity.json + manifest.json from the ZIP, builds the pinned
 * package-signature payload, signs it RS256 (RSA-SHA256, PKCS#1 v1.5) with the
 * given private key, and rewrites the ZIP with signature.jws added.
 *
 * Pinned package-signature contract (must match server/modules/packageVerify.js
 * and the hub's package signer):
 *   header  = { alg:'RS256', typ:'JWT', kid }
 *   payload = { iss:'license.beeflow.nl/modules', module_id, version,
 *               integrity_sha256:<hex sha256 of integrity.json bytes>,
 *               iat, min_app_version, host_api_version }
 *   kid     = sha256(<SPKI public PEM string>).slice(0,16)   // matches verify.js kidForPem
 *
 * Takes an RSA-2048 keypair, PKCS8 private / SPKI public — the format the
 * (private) license server's keypair generator writes, and what
 * `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048` produces.
 * If --pub is omitted the public key is derived from the private key.
 *
 * Usage:  node scripts/sign.mjs <file.bfmod> <private-key.pem> [--pub <public.pem>]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

function sha256hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

const b64url = (input) => Buffer.from(input).toString('base64url');

/** kid = sha256(SPKI public PEM string).slice(0,16) — mirrors verify.js kidForPem. */
function kidForPem(publicPem) {
    return crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
}

function signJws(header, payload, privatePem) {
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), {
        key: privatePem,
        padding: crypto.constants.RSA_PKCS1_PADDING,
    });
    return `${signingInput}.${b64url(sig)}`;
}

/**
 * Sign a `.bfmod` buffer in memory. Returns { buf, kid, jws }.
 * @param {Buffer} bfmodBuf
 * @param {string} privatePem  PKCS8 (or PKCS1) RSA private key PEM
 * @param {string} [publicPem] SPKI public key PEM (derived if omitted)
 * @param {{ licenseClass?: 'free'|'paid' }} [opts]
 *        licenseClass:'free' pins the module as freely sideloadable — an
 *        air-gapped product accepts it without an offline grant. Absent ⇒ paid.
 */
async function signBuffer(bfmodBuf, privatePem, publicPem, opts = {}) {
    const zip = await JSZip.loadAsync(bfmodBuf);

    const integrityFile = zip.file('integrity.json');
    if (!integrityFile) throw new Error('integrity.json missing — pack the module first');
    const integrityBuf = await integrityFile.async('nodebuffer');

    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) throw new Error('manifest.json missing');
    const manifest = JSON.parse((await manifestFile.async('nodebuffer')).toString('utf8'));

    const pubPem = publicPem
        || crypto.createPublicKey(privatePem).export({ type: 'spki', format: 'pem' });
    const kid = kidForPem(pubPem);

    const payload = {
        iss: 'license.beeflow.nl/modules',
        module_id: manifest.id,
        version: manifest.version,
        integrity_sha256: sha256hex(integrityBuf),
        iat: Math.floor(Date.now() / 1000),
        min_app_version: manifest.minAppVersion || manifest.min_app_version || '0.0.0',
        host_api_version: manifest.hostApiVersion || manifest.host_api_version || 1,
    };
    if (opts.licenseClass === 'free') payload.license_class = 'free';
    const header = { alg: 'RS256', typ: 'JWT', kid };
    const jws = signJws(header, payload, privatePem);

    zip.file('signature.jws', jws);
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return { buf, kid, jws };
}

async function main() {
    const args = process.argv.slice(2);
    const pubIdx = args.indexOf('--pub');
    const pubPath = pubIdx >= 0 ? args[pubIdx + 1] : null;
    const lcIdx = args.indexOf('--license-class');
    const licenseClass = lcIdx >= 0 ? args[lcIdx + 1] : null;
    const skip = new Set([pubIdx, pubIdx + 1, lcIdx, lcIdx + 1].filter(i => i >= 0));
    const positional = args.filter((a, i) => !skip.has(i));

    const bfmodPath = positional[0];
    const keyPath = positional[1];
    if (!bfmodPath || !keyPath) {
        console.error('Usage: node scripts/sign.mjs <file.bfmod> <private-key.pem> [--pub <public.pem>] [--license-class free]');
        process.exit(2);
    }
    if (licenseClass && licenseClass !== 'free' && licenseClass !== 'paid') {
        console.error(`--license-class must be 'free' or 'paid' (got '${licenseClass}')`);
        process.exit(2);
    }

    const privatePem = fs.readFileSync(path.resolve(keyPath), 'utf8');
    const publicPem = pubPath ? fs.readFileSync(path.resolve(pubPath), 'utf8') : undefined;
    const bfmodBuf = fs.readFileSync(path.resolve(bfmodPath));

    const { buf, kid } = await signBuffer(bfmodBuf, privatePem, publicPem, { licenseClass });
    fs.writeFileSync(path.resolve(bfmodPath), buf);
    console.log(`Signed ${bfmodPath}`);
    console.log(`  kid: ${kid}`);
    console.log(`  package sha256: ${sha256hex(buf)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((e) => { console.error('sign failed:', e.message); process.exit(1); });
}

export { signBuffer, signJws, kidForPem, sha256hex };
