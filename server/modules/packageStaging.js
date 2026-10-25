/** @typedef {import('./packageVerify').PackageManifest} PackageManifest */
/**
 * Package loader: paths, verify-and-stage and the atomic extract.
 *
 * Signature + integrity verification of a `.bfmod`, the identity and
 * product-compatibility gates, the atomic extraction into the version dir,
 * and the re-verify FROM DISK that boot, reconcile, rollback and reactivation
 * run before any package comes back up.
 */

'use strict';

const path = require('path');
const fsp = require('fs/promises');

const { deps, dataRoot, packageKeyResolver } = require('./packageState');

const { hubClient, licenseVerify, packageVerify, hostApiFactory } = deps;

// ── Path helpers (defense-in-depth segment sanitising) ────────────────────
/**
 * @param {string} seg
 */
function _safeSeg(seg) {
    const s = String(seg || '');
    if (!s || s.includes('/') || s.includes('\\') || s.includes('..')) {
        throw new Error(`unsafe path segment: ${seg}`);
    }
    return s;
}
/**
 * @param {string} id
 */
function moduleRoot(id) { return path.join(dataRoot(), _safeSeg(id)); }
/**
 * @param {string} id
 * @param {string} version
 */
function versionDir(id, version) { return path.join(moduleRoot(id), 'versions', _safeSeg(version)); }
/**
 * @param {string} id
 */
function moduleDataDir(id) { return path.join(moduleRoot(id), 'data'); }
/**
 * @param {string} id
 * @param {string} version
 */
function packagePath(id, version) { return path.join(moduleRoot(id), 'pkg', `${_safeSeg(version)}.bfmod`); }

// ── Compatibility gate ─────────────────────────────────────────────────────
/**
 * @param {string} reason
 */
function _incompatible(reason) {
    const e = new Error(reason);
    e.compat = true;
    return e;
}
/**
 * Compatibility gate — SIGNED payload values first (what the signer pinned),
 * manifest spellings (snake_case AND the SDK's authored camelCase) only as
 * fallback for packages signed before the payload carried them.
 * @param {PackageManifest | undefined} manifest
 */
function _compatCheck(manifest, signedPayload = null) {
    const semver = require('../utils/semver');
    const HOST_API_VERSION = hostApiFactory().HOST_API_VERSION;
    const sp = signedPayload || {};
    const need = Number(
        sp.host_api_version
        ?? (manifest.server && manifest.server.host_api_version)
        ?? manifest.hostApiVersion
        ?? 1
    );
    if (Number.isFinite(need) && need > HOST_API_VERSION) {
        throw _incompatible(`host_api_version ${need} > ${HOST_API_VERSION}`);
    }
    // Only a version a release stamped (APP_VERSION) is graded: server/package.json is frozen at 1.0.0
    // (see server/version.js), so an unstamped build skips the semver bounds rather than refusing modules.
    const appVer = process.env.APP_VERSION || null;
    const minApp = sp.min_app_version
        || manifest.min_app_version
        || manifest.minAppVersion
        || manifest.minProductVersion
        || (manifest.server && manifest.server.min_app_version)
        || null;
    if (minApp && appVer && !semver.satisfiesMin(appVer, minApp)) {
        throw _incompatible(`requires product >= ${minApp} (have ${appVer})`);
    }
    // Advisory upper bound — manifest-only (the pinned JWS payload is not
    // widened with max claims in 3.1).
    const maxApp = manifest.max_app_version || manifest.maxAppVersion || null;
    if (maxApp && appVer && !semver.satisfiesMax(appVer, maxApp)) {
        throw _incompatible(`requires product <= ${maxApp} (have ${appVer})`);
    }
}

// ── Atomic extraction ──────────────────────────────────────────────────────
/**
 * @param {string} destDir
 * @param {Map<string, Buffer<ArrayBufferLike>> | undefined} files
 */
async function _extractAtomic(destDir, files) {
    const parent = path.dirname(destDir);
    await fsp.mkdir(parent, { recursive: true });
    const tmp = `${destDir}.tmp-${process.pid}-${Date.now()}`;
    await fsp.rm(tmp, { recursive: true, force: true });
    for (const [rel, buf] of files) {
        const abs = path.join(tmp, rel);
        if (abs !== tmp && !abs.startsWith(tmp + path.sep)) throw new Error(`bad extract path: ${rel}`);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, buf);
    }
    await fsp.rm(destDir, { recursive: true, force: true });
    await fsp.rename(tmp, destDir);
}

/**
 * @param {Map<string, Buffer<ArrayBufferLike>> | undefined} files
 */
function _kidFromSignature(files) {
    try {
        const jws = files.get('signature.jws');
        if (!jws) return null;
        const { header } = licenseVerify().decodeJwtUnverified(jws.toString('utf8'));
        return (header && header.kid) || null;
    } catch (_) { return null; }
}

/**
 * @param {PackageManifest | undefined} m
 */
function _manifestSummary(m) {
    return {
        id: m.id,
        name: m.name || m.id,
        version: m.version,
        manifestVersion: Number(m.manifestVersion || 1),
        permissions: Array.isArray(m.permissions) ? m.permissions : [],
        schemaVersion: Number(m.server && m.server.schemaVersion) || null,
        description: m.description || '',
        category: m.category || 'Modules',
        icon: m.icon || 'box',
        capabilities: Array.isArray(m.capabilities)
            ? m.capabilities.map(c => ({
                id: c.id, kind: c.kind || 'integration', name: c.name || c.id,
                description: c.description || '', category: c.category || null,
                licenseFeature: c.licenseFeature || null, lifecycle: c.lifecycle || 'stable',
            }))
            : [],
        frontend: m.frontend || null,
        requirements: (m.requirements && typeof m.requirements === 'object') ? m.requirements : {},
    };
}

/**
 * Verify a `.bfmod` and extract it to versionDir atomically.
 * @param {string} moduleId
 * @param {string} version
 * @param {{ buffer?:Buffer, download?:boolean }} opts
 * @returns {Promise<{ manifest, dir, sha256, kid }>}
 */
async function verifyAndStage(moduleId, version, { buffer = null, download = false, expectedSha256 = null, redownloadSha = null } = {}) {
    /** @type {string | null} */
    let sha256 = null;
    let pkgPath = packagePath(moduleId, version);

    if (download) {
        const dl = await hubClient().downloadPackage({ moduleId, version, destPath: pkgPath, expectedSha256, redownloadSha });
        sha256 = dl.sha256;
        buffer = await fsp.readFile(pkgPath);
    } else if (buffer) {
        await fsp.mkdir(path.dirname(pkgPath), { recursive: true });
        await fsp.writeFile(pkgPath, buffer); // retain for boot re-verify
        sha256 = require('crypto').createHash('sha256').update(buffer).digest('hex');
    } else {
        buffer = await fsp.readFile(pkgPath);
        sha256 = require('crypto').createHash('sha256').update(buffer).digest('hex');
    }

    const result = await packageVerify().verifyPackage(buffer, { publicKeyResolver: packageKeyResolver() });
    if (!result.ok) {
        const e = new Error(`package_verify_failed:${result.error}`);
        throw e;
    }
    const manifest = result.manifest;
    if (manifest.id !== moduleId || manifest.version !== version) {
        throw new Error(`package_identity_mismatch: ${manifest.id}@${manifest.version} != ${moduleId}@${version}`);
    }
    _compatCheck(manifest, result.signature && result.signature.payload);

    // Honest requiresRestart (M3): native addons can't be re-require()d into a
    // live process, and restart:'always' is the author saying "don't hot-swap
    // me". Updates of a RUNNING module with this flag are STAGED for the next
    // restart instead of activated.
    const requiresRestart = [...result.files.keys()].some(n => n.endsWith('.node'))
        || !!(manifest.server && (manifest.server.native === true || manifest.server.restart === 'always'));

    await _extractAtomic(versionDir(moduleId, version), result.files);
    return {
        manifest,
        dir: versionDir(moduleId, version),
        sha256,
        kid: (result.signature && result.signature.kid) || _kidFromSignature(result.files),
        signedPayload: (result.signature && result.signature.payload) || null,
        requiresRestart,
    };
}

// ── Re-verify from disk (boot, reconcile, rollback, reactivate) ──────────
/**
 * @param {string} moduleId
 * @param {string} version
 */
async function _reverifyFromDisk(moduleId, version) {
    /** @type {NonSharedBuffer} */
    let buffer;
    try { buffer = await fsp.readFile(packagePath(moduleId, version)); }
    catch (_) { throw new Error('package_file_missing'); }
    const result = await packageVerify().verifyPackage(buffer, { publicKeyResolver: packageKeyResolver() });
    if (!result.ok) throw new Error(`verify_failed:${result.error}`);
    if (result.manifest.id !== moduleId || result.manifest.version !== version) throw new Error('manifest_mismatch');
    _compatCheck(result.manifest, result.signature && result.signature.payload);
    await _extractAtomic(versionDir(moduleId, version), result.files);
    return { manifest: result.manifest, kid: (result.signature && result.signature.kid) || _kidFromSignature(result.files) };
}

module.exports = {
    _safeSeg,
    moduleRoot,
    versionDir,
    moduleDataDir,
    packagePath,
    _compatCheck,
    _extractAtomic,
    _kidFromSignature,
    _manifestSummary,
    verifyAndStage,
    _reverifyFromDisk,
};
