/**
 * `.bfmod` package verifier — PURE, in-memory, NO fs writes.
 *
 * A `.bfmod` is a ZIP holding a downloadable Bee Flow module:
 *   manifest.json   — module descriptor (subset validated here)
 *   integrity.json  — { algo:'sha256', files:{ '<relpath>': '<hex sha256>' } }
 *                     covering EVERY packaged file EXCEPT signature.jws and
 *                     integrity.json itself (a file can't hash itself; the
 *                     signature binds integrity.json's own hash instead).
 *   signature.jws   — compact RS256 JWS over the package-signature contract:
 *                     { iss:'license.beeflow.nl/modules', module_id, version,
 *                       integrity_sha256, iat, min_app_version, host_api_version }
 *   server/… frontend/… assets/… — the module payload.
 *
 * Trust chain (verify BEFORE anyone extracts to disk):
 *   1. structural caps + path-traversal rejection (cheap, pre-crypto),
 *   2. signature.jws verifies against the package trust root (kid→key via the
 *      caller-supplied resolver) and binds this module id+version,
 *   3. sha256(integrity.json bytes) === signature payload.integrity_sha256,
 *   4. every packaged file's sha256 matches integrity.json AND integrity.json
 *      lists no phantom files.
 *
 * Crypto is reused from ../license/verify.js (one RS256 implementation for the
 * whole product): decodeJwtUnverified + verifyCompactRs256. This module never
 * touches the network and never writes to disk — the caller (packageLoader)
 * owns extraction once verifyPackage() returns { ok:true }.
 */

'use strict';

const crypto = require('crypto');
const JSZip = require('jszip');
const { decodeJwtUnverified, verifyCompactRs256 } = require('../license/verify');

const PACKAGE_ISS = 'license.beeflow.nl/modules';

// Structural caps — a signed first-party package should never approach these;
// they bound damage from a malformed/hostile ZIP before any crypto work.
const MAX_ENTRIES = 2000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;   // 50 MB per file (uncompressed)
const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB total (uncompressed)
const MAX_MANIFEST_BYTES = 512 * 1024;     // 512 KB
const MAX_PATH_LEN = 260;

// Files that are NOT self-covered by integrity.json (see header): the
// signature and the integrity manifest itself.
const UNCOVERED = new Set(['signature.jws', 'integrity.json']);

const ID_RE = /^[a-z][a-z0-9_]{2,40}$/;
// Practical semver: MAJOR.MINOR.PATCH with optional -prerelease / +build.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

// mv2 permission grammar — fixed taxonomy ids plus http:<pattern> grants
// (exact host, *.suffix, or *). Kept in lockstep with hostApi.PERMISSION_IDS
// (hostApi is not required here to keep this module dependency-light and pure).
const PERMISSION_RE = /^(db|ai|usage:write|limits:read|storage:read|webpages:write|email:send|license:read|config|env:docker|env:files|http:(\*|(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?))$/i;

function sha256hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Reject entry names that could escape the extraction root. */
function isBadPath(name) {
    if (typeof name !== 'string' || name.length === 0) return true;
    if (name.length > MAX_PATH_LEN) return true;
    if (name.includes('\\')) return true;         // backslash / Windows sep
    if (name.startsWith('/')) return true;        // absolute (posix)
    if (/^[a-zA-Z]:/.test(name)) return true;     // absolute (windows drive)
    if (name.split('/').some((seg) => seg === '..')) return true; // traversal
    return false;
}

/**
 * Validate the shape of a parsed manifest object. This is the runtime subset
 * of MANIFEST.schema.json that the loader hard-depends on — the full schema is
 * enforced at authoring/pack time in hub-module-sdk.
 * @returns {{ ok:true } | { ok:false, error:string }}
 */
function validateManifest(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return { ok: false, error: 'bad_manifest' };
    }
    if (typeof obj.id !== 'string' || !ID_RE.test(obj.id)) {
        return { ok: false, error: 'invalid_id' };
    }
    if (typeof obj.version !== 'string' || !SEMVER_RE.test(obj.version)) {
        return { ok: false, error: 'invalid_version' };
    }
    if (!Array.isArray(obj.capabilities)) {
        return { ok: false, error: 'invalid_capabilities' };
    }
    for (const cap of obj.capabilities) {
        if (!cap || typeof cap !== 'object' || typeof cap.id !== 'string' || !cap.id) {
            return { ok: false, error: 'invalid_capabilities' };
        }
    }

    // ── manifestVersion 2 (permission manifest) ────────────────────────────
    const mv = Number(obj.manifestVersion || 1);
    if (mv !== 1 && mv !== 2) return { ok: false, error: 'unsupported_manifest_version' };
    if (mv === 2) {
        const perms = obj.permissions;
        if (perms !== undefined) {
            if (!Array.isArray(perms)) return { ok: false, error: 'invalid_permissions' };
            for (const p of perms) {
                if (typeof p !== 'string' || !PERMISSION_RE.test(p)) {
                    return { ok: false, error: 'invalid_permissions' };
                }
            }
            // Permission-gating is the one semantic old loaders can't honour —
            // a non-empty grant list must declare hostApiVersion >= 3 so a
            // pre-3.1 product refuses the package instead of over-granting.
            const hav = Number(
                obj.host_api_version
                ?? obj.hostApiVersion
                ?? (obj.server && typeof obj.server === 'object' && !Array.isArray(obj.server)
                    ? obj.server.host_api_version : undefined)
                ?? 1
            );
            if (perms.length > 0 && hav < 3) return { ok: false, error: 'permissions_require_host_api_3' };
        }
        for (const cap of obj.capabilities) {
            // mv2 capability ids must be module-own: '<id>' or '<id>_…'.
            if (cap.id !== obj.id && !cap.id.startsWith(`${obj.id}_`)) {
                return { ok: false, error: 'capability_not_module_owned' };
            }
            if (cap.kind === 'core') return { ok: false, error: 'capability_kind_core_forbidden' };
        }
    }

    if (!obj.server || typeof obj.server !== 'object' || Array.isArray(obj.server)) {
        return { ok: false, error: 'invalid_server' };
    }
    if (typeof obj.server.entry !== 'string' || !obj.server.entry) {
        return { ok: false, error: 'invalid_server_entry' };
    }
    if (isBadPath(obj.server.entry)) return { ok: false, error: 'invalid_server_entry' };
    if (obj.frontend !== undefined) {
        if (!obj.frontend || typeof obj.frontend !== 'object' || Array.isArray(obj.frontend)) {
            return { ok: false, error: 'invalid_frontend' };
        }
        if (typeof obj.frontend.entry !== 'string' || !obj.frontend.entry) {
            return { ok: false, error: 'invalid_frontend' };
        }
        // Frontend paths are later served from the extracted dir — reject
        // anything that could escape it.
        if (isBadPath(obj.frontend.entry)) return { ok: false, error: 'invalid_frontend' };
        if (obj.frontend.css !== undefined) {
            if (!Array.isArray(obj.frontend.css)) return { ok: false, error: 'invalid_frontend' };
            for (const c of obj.frontend.css) {
                if (typeof c !== 'string' || !c || isBadPath(c)) return { ok: false, error: 'invalid_frontend' };
            }
        }
    }
    if (obj.requirements !== undefined
        && (typeof obj.requirements !== 'object' || obj.requirements === null || Array.isArray(obj.requirements))) {
        return { ok: false, error: 'invalid_requirements' };
    }
    return { ok: true };
}

function fail(error) {
    return { ok: false, error };
}

/**
 * Verify a `.bfmod` ZIP buffer in memory.
 *
 * @param {Buffer} buf
 * @param {object} opts
 * @param {(kid:(string|undefined)) => (Promise<any>|any)} opts.publicKeyResolver
 *        Resolve the package trust-root public key (PEM or KeyObject) for the
 *        JWS `kid`. Return null/undefined for an unknown kid.
 * @param {number} [opts.now]  Reserved for future iat sanity checks (unused;
 *        the package-signature contract carries no exp/nbf).
 * @returns {Promise<{ ok:true, manifest:object, files:Map<string,Buffer>,
 *                     signature:{ payload:object, kid:(string|null) } }
 *                  | { ok:false, error:string }>}
 */
async function verifyPackage(buf, opts = {}) {
    const publicKeyResolver = opts && opts.publicKeyResolver;
    if (typeof publicKeyResolver !== 'function') return fail('no_resolver');

    let zip;
    try {
        zip = await JSZip.loadAsync(buf);
    } catch (_) {
        return fail('bad_zip');
    }

    // Count real (non-directory) entries up front — cheap DoS guard before we
    // decompress anything.
    const fileEntries = Object.values(zip.files).filter((e) => !e.dir);
    if (fileEntries.length > MAX_ENTRIES) return fail('too_large');

    // Decompress one at a time; path + size caps bound memory to ~one file.
    const files = new Map(); // relpath -> Buffer
    let total = 0;
    for (const entry of fileEntries) {
        const name = entry.name;
        if (isBadPath(name)) return fail('bad_path');
        let data;
        try {
            data = await entry.async('nodebuffer');
        } catch (_) {
            return fail('bad_zip');
        }
        if (data.length > MAX_FILE_BYTES) return fail('too_large');
        total += data.length;
        if (total > MAX_TOTAL_BYTES) return fail('too_large');
        files.set(name, data);
    }

    // ── manifest.json ────────────────────────────────────────────────────
    const manifestBuf = files.get('manifest.json');
    if (!manifestBuf) return fail('missing_manifest');
    if (manifestBuf.length > MAX_MANIFEST_BYTES) return fail('manifest_too_large');
    let manifest;
    try {
        manifest = JSON.parse(manifestBuf.toString('utf8'));
    } catch (_) {
        return fail('bad_manifest');
    }
    const mv = validateManifest(manifest);
    if (!mv.ok) return fail(mv.error);

    // ── integrity.json + signature.jws presence ──────────────────────────
    const integrityBuf = files.get('integrity.json');
    if (!integrityBuf) return fail('missing_integrity');
    const jwsBuf = files.get('signature.jws');
    if (!jwsBuf) return fail('missing_signature');

    let integrity;
    try {
        integrity = JSON.parse(integrityBuf.toString('utf8'));
    } catch (_) {
        return fail('bad_integrity');
    }
    if (!integrity || integrity.algo !== 'sha256'
        || !integrity.files || typeof integrity.files !== 'object' || Array.isArray(integrity.files)) {
        return fail('bad_integrity');
    }

    // ── signature verification ───────────────────────────────────────────
    let header, payload, parts;
    try {
        ({ header, payload, parts } = decodeJwtUnverified(jwsBuf.toString('utf8')));
    } catch (_) {
        return fail('bad_signature');
    }
    let publicKey;
    try {
        publicKey = await publicKeyResolver(header && header.kid);
    } catch (_) {
        publicKey = null;
    }
    const sigOk = verifyCompactRs256(`${parts[0]}.${parts[1]}`, parts[2], publicKey);
    if (!sigOk) return fail('bad_signature');

    if (payload.iss !== PACKAGE_ISS
        || payload.module_id !== manifest.id
        || payload.version !== manifest.version) {
        return fail('signature_module_mismatch');
    }

    // ── integrity.json is what the signature actually vouches for ─────────
    if (typeof payload.integrity_sha256 !== 'string'
        || sha256hex(integrityBuf) !== payload.integrity_sha256) {
        return fail('integrity_mismatch');
    }

    // ── per-file coverage (exact set + exact hashes) ──────────────────────
    const declared = integrity.files;
    for (const [name, data] of files) {
        if (UNCOVERED.has(name)) continue;
        const expected = declared[name];
        if (typeof expected !== 'string') return fail('unexpected_file');
        if (sha256hex(data) !== expected) return fail('file_hash_mismatch');
    }
    for (const name of Object.keys(declared)) {
        if (!files.has(name)) return fail('missing_file');
    }

    // The VERIFIED signature payload is the load-bearing source for compat
    // claims (host_api_version, min_app_version) — a manifest key spelled
    // differently can never sidestep what the signer pinned.
    return {
        ok: true,
        manifest,
        files,
        signature: { payload, kid: (header && header.kid) || null },
    };
}

module.exports = {
    verifyPackage,
    validateManifest,
    PACKAGE_ISS,
    PERMISSION_RE,
    // exported for the SDK/tests to stay byte-for-byte in agreement:
    sha256hex,
    isBadPath,
    UNCOVERED,
    MAX_ENTRIES,
    MAX_FILE_BYTES,
    MAX_TOTAL_BYTES,
    MAX_MANIFEST_BYTES,
    MAX_PATH_LEN,
};
