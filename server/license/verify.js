/**
 * License JWT Verification
 *
 * Verifies RS256-signed license tokens issued by license.beeflow.nl.
 * Implemented with Node's built-in `crypto` (no external JWT lib) so we
 * don't add a dependency for one signature scheme.
 *
 * Trust model:
 *   - The Beeflow public key is shipped in the binary via env var
 *     `LICENSE_PUBLIC_KEY` (PEM, multi-line) or `LICENSE_PUBLIC_KEY_FILE`
 *     (path to a .pem file). For dev/testing a generated dev key is used
 *     when neither is set, but tier resolution then refuses to upgrade
 *     beyond `community`.
 *
 * Full-tier guard:
 *   The token's `tier` claim MUST be backed by an issuer string we expect.
 *   Even though RS256 alone is sufficient (you can't forge without the
 *   private key), we double-lock so a leaked Pro/Enterprise signing key
 *   can't issue Full licenses without also matching the internal issuer.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isValidTier, TIER_HIERARCHY } = require('./tiers');
const log = require('../telemetry/log');

const EXPECTED_ISSUER = 'license.beeflow.nl';
const FULL_TIER_ISSUER = 'license.beeflow.nl/internal';
const ALG = 'RS256';

const BUNDLED_KEY_PATH = path.join(__dirname, 'bundled-public-key.pem');
const JWKS_URL = process.env.LICENSE_JWKS_URL || '';
const JWKS_CACHE_MS = parseInt(process.env.LICENSE_JWKS_CACHE_SECONDS || '300', 10) * 1000;

let _cachedKey = null;
let _cachedKeySource = null;
let _jwksCache = { fetchedAt: 0, keysByKid: new Map(), revokedKids: [] };

// ── Known-kid cache (key-rotation resilience) ──────────────────────────────
// Every kid successfully resolved via JWKS is persisted (PEM) in configStore,
// so a package/grant signed by a key the hub has since ROTATED OUT still
// verifies at boot even when JWKS is unreachable or no longer serves that kid.
// Purged by the JWKS `revoked_kids` list and by 90 days of disuse; capped LRU.
// Best-effort everywhere: the cache must never make verification fail.
const KNOWN_KEYS_CONFIG_KEY = 'beeflow_hub_known_signing_keys';
const KNOWN_KEYS_MAX = 16;
const KNOWN_KEYS_STALE_MS = 90 * 24 * 60 * 60 * 1000;

let _configStore;
function configStore() { return _configStore || (_configStore = require('../stores/configStore')); }

function _pemOf(key) {
    try {
        if (typeof key === 'string') return key;
        return key.export({ type: 'spki', format: 'pem' }).toString();
    } catch (_) { return null; }
}

async function _readKnownKeys() {
    try {
        const stored = await configStore().getConfig(KNOWN_KEYS_CONFIG_KEY);
        return (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
    } catch (_) { return {}; }
}

async function _writeKnownKeys(map) {
    try {
        // Prune stale entries, then LRU-cap on lastUsedAt.
        const now = Date.now();
        const entries = Object.entries(map)
            .filter(([, v]) => v && v.pem && (now - Date.parse(v.lastUsedAt || v.firstSeenAt || 0)) < KNOWN_KEYS_STALE_MS)
            .sort((a, b) => Date.parse(b[1].lastUsedAt || 0) - Date.parse(a[1].lastUsedAt || 0))
            .slice(0, KNOWN_KEYS_MAX);
        await configStore().setConfig(KNOWN_KEYS_CONFIG_KEY, Object.fromEntries(entries));
    } catch (_) { /* cache write is never load-bearing */ }
}

/** Persist freshly-seen JWKS keys + apply the hub's revocation list. */
async function _persistKnownKeys(keysByKid, revokedKids) {
    try {
        const map = await _readKnownKeys();
        const nowIso = new Date().toISOString();
        for (const [kid, key] of keysByKid) {
            const pem = _pemOf(key);
            if (!pem) continue;
            map[kid] = { pem, firstSeenAt: (map[kid] && map[kid].firstSeenAt) || nowIso, lastUsedAt: nowIso };
        }
        for (const kid of (revokedKids || [])) delete map[kid];
        await _writeKnownKeys(map);
    } catch (_) { /* best effort */ }
}

/**
 * Resolve the public key in this precedence:
 *   1. LICENSE_PUBLIC_KEY env var (inline PEM, supports literal \n)
 *   2. LICENSE_PUBLIC_KEY_FILE env var (path to PEM file)
 *   3. ./bundled-public-key.pem shipped alongside this module
 *
 * Step 3 is what makes activation work out-of-the-box for self-hosted
 * installs (Nextcloud-bundled, Docker, bare-metal). Operators only need
 * to override via env var when they want to validate against a custom
 * license server (e.g. white-label deployments).
 *
 * Beeflow replaces bundled-public-key.pem with the production key before
 * cutting a release; the dev key in this repo only validates dev-signed
 * test JWTs.
 */
function loadPublicKey() {
    if (_cachedKey) return { key: _cachedKey, source: _cachedKeySource };

    const inline = process.env.LICENSE_PUBLIC_KEY;
    if (inline && inline.includes('BEGIN PUBLIC KEY')) {
        _cachedKey = inline.replace(/\\n/g, '\n');
        _cachedKeySource = 'env';
        return { key: _cachedKey, source: _cachedKeySource };
    }

    const fromFile = process.env.LICENSE_PUBLIC_KEY_FILE;
    if (fromFile) {
        try {
            _cachedKey = fs.readFileSync(fromFile, 'utf8');
            _cachedKeySource = 'file';
            return { key: _cachedKey, source: _cachedKeySource };
        } catch (e) {
            log.error('[License Verify] Could not read LICENSE_PUBLIC_KEY_FILE:', e.message);
        }
    }

    try {
        if (fs.existsSync(BUNDLED_KEY_PATH)) {
            // In production, refuse to fall back to the bundled dev key.
            // Operators must set LICENSE_PUBLIC_KEY or LICENSE_PUBLIC_KEY_FILE
            // explicitly. Otherwise a deploy that forgot to install the
            // production key would silently validate dev-signed tokens.
            if (process.env.NODE_ENV === 'production' && process.env.LICENSE_ALLOW_BUNDLED_KEY !== 'true') {
                log.error('[License Verify] Refusing bundled dev key in production. Set LICENSE_PUBLIC_KEY or LICENSE_PUBLIC_KEY_FILE.');
                return { key: null, source: null };
            }
            _cachedKey = fs.readFileSync(BUNDLED_KEY_PATH, 'utf8');
            _cachedKeySource = 'bundled';
            return { key: _cachedKey, source: _cachedKeySource };
        }
    } catch (e) { /* unreadable bundled key — treat as missing */ }

    return { key: null, source: null };
}

function base64UrlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64');
}

function decodeJwtUnverified(token) {
    if (typeof token !== 'string') throw new Error('Token must be a string');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Malformed JWT');
    const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
    const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
    return { header, payload, parts };
}

/**
 * Fetch JWKS keys from LICENSE_JWKS_URL with a small in-process cache. Used
 * for safe key rotation — verifiers pick the key whose kid matches the JWT
 * header. Returns a Map<kid, KeyObject>; the bundled key is also indexed
 * by its computed kid so it remains the default when JWKS is unavailable.
 */
async function getJwksKeys() {
    const now = Date.now();
    if (now - _jwksCache.fetchedAt < JWKS_CACHE_MS && _jwksCache.keysByKid.size > 0) {
        return _jwksCache.keysByKid;
    }
    if (!JWKS_URL) return _jwksCache.keysByKid; // empty map → caller falls back
    const timeoutMs = parseInt(process.env.LICENSE_JWKS_TIMEOUT_MS || '5000', 10);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(JWKS_URL, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const keysByKid = new Map();
        for (const jwk of (body.keys || [])) {
            if (!jwk.kid) continue;
            try {
                const ko = crypto.createPublicKey({ key: jwk, format: 'jwk' });
                keysByKid.set(jwk.kid, ko);
            } catch (e) {
                log.warn('[License Verify] could not import JWK', jwk.kid, e.message);
            }
        }
        const revokedKids = Array.isArray(body.revoked_kids) ? body.revoked_kids : [];
        _jwksCache = { fetchedAt: now, keysByKid, revokedKids };
        // Fire-and-forget: remember every good kid for rotation resilience.
        _persistKnownKeys(keysByKid, revokedKids).catch(() => {});
    } catch (e) {
        const reason = e.name === 'AbortError' ? `timeout_${timeoutMs}ms` : e.message;
        log.warn(`[License Verify] license.jwks.fetch_failed reason=${reason}`);
    } finally {
        clearTimeout(timer);
    }
    return _jwksCache.keysByKid;
}

function kidForPem(pem) {
    if (!pem) return null;
    return crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16);
}

/**
 * Verify the JWT signature and required claims.
 * @returns {{ valid: true, payload: object } | { valid: false, error: string }}
 *
 * Key resolution: if the JWT header carries a `kid`, prefer the matching key
 * from the configured JWKS endpoint, then fall back to the bundled key when
 * its kid matches (or when no kid is present at all).
 */
async function verifyToken(token, { now = Math.floor(Date.now() / 1000), publicKeyOverride = null } = {}) {
    let decoded;
    try {
        decoded = decodeJwtUnverified(token);
    } catch (e) {
        return { valid: false, error: `decode_failed: ${e.message}` };
    }

    const { header, payload, parts } = decoded;

    if (header.alg !== ALG) {
        return { valid: false, error: `unexpected_alg: ${header.alg}` };
    }
    if (header.typ && header.typ !== 'JWT') {
        return { valid: false, error: `unexpected_typ: ${header.typ}` };
    }

    let publicKey = publicKeyOverride;
    if (!publicKey) {
        const bundled = loadPublicKey().key;
        const bundledKid = kidForPem(bundled);
        if (header.kid) {
            // Try JWKS first, then bundled if it happens to match the kid.
            const jwks = await getJwksKeys();
            if (jwks.has(header.kid)) publicKey = jwks.get(header.kid);
            else if (bundled && bundledKid === header.kid) publicKey = bundled;
            else if (bundled) publicKey = bundled; // best effort — verify will fail if the key doesn't match
        } else {
            publicKey = bundled;
        }
    }
    if (!publicKey) {
        return { valid: false, error: 'no_public_key_configured' };
    }

    const signingInput = `${parts[0]}.${parts[1]}`;
    const signature = base64UrlDecode(parts[2]);
    let sigOk = false;
    try {
        sigOk = crypto.verify(
            'RSA-SHA256',
            Buffer.from(signingInput),
            { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
            signature
        );
    } catch (e) {
        return { valid: false, error: `signature_check_failed: ${e.message}` };
    }
    if (!sigOk) return { valid: false, error: 'invalid_signature' };

    // Required claims
    if (typeof payload.iss !== 'string') return { valid: false, error: 'missing_iss' };
    if (!isExpectedIssuer(payload.iss)) return { valid: false, error: `untrusted_issuer: ${payload.iss}` };
    if (typeof payload.tier !== 'string' || !isValidTier(payload.tier)) {
        return { valid: false, error: `invalid_tier: ${payload.tier}` };
    }
    if (typeof payload.license_id !== 'string' || !payload.license_id) {
        return { valid: false, error: 'missing_license_id' };
    }
    if (typeof payload.exp !== 'number') return { valid: false, error: 'missing_exp' };
    if (payload.exp <= now) return { valid: false, error: 'token_expired' };
    if (typeof payload.nbf === 'number' && payload.nbf > now + 60) {
        return { valid: false, error: 'token_not_yet_valid' };
    }

    // Hard lock: 'full' tier requires internal issuer.
    if (payload.tier === 'full' && !isFullTierIssuer(payload.iss)) {
        return { valid: false, error: 'full_tier_requires_internal_issuer' };
    }

    return { valid: true, payload };
}

function isExpectedIssuer(iss) {
    return iss === EXPECTED_ISSUER || iss === FULL_TIER_ISSUER;
}

function isFullTierIssuer(iss) {
    return iss === FULL_TIER_ISSUER;
}

/**
 * For tests: replace the cached public key. Pass null to clear.
 */
function _setPublicKeyForTesting(pem) {
    _cachedKey = pem;
    _cachedKeySource = pem ? 'test' : null;
}

// ── Reusable primitives for other RS256-signed token schemes ─────────────
// These are ADDITIVE exports so sibling verifiers (e.g. the module-grant
// verifier in ../modules/entitlements.js) don't fork this file's crypto.
// verifyToken above is intentionally left untouched.

/**
 * Resolve a public key by `kid`: the configured JWKS endpoint first, then the
 * persisted known-kid cache (bridges hub key ROTATION — a kid the JWKS no
 * longer serves but that we verified against before), then the bundled/env key
 * as a best-effort fallback (signature verification fails later if it
 * mismatches).
 * @returns {Promise<crypto.KeyObject|string|null>}
 */
async function resolvePublicKeyByKid(kid) {
    const bundled = loadPublicKey().key;
    if (kid) {
        const jwks = await getJwksKeys();
        if (jwks.has(kid)) return jwks.get(kid);
        try {
            if (!(_jwksCache.revokedKids || []).includes(kid)) {
                const known = await _readKnownKeys();
                const entry = known[kid];
                if (entry && entry.pem) {
                    entry.lastUsedAt = new Date().toISOString();
                    _writeKnownKeys(known).catch(() => {});
                    return entry.pem;
                }
            }
        } catch (_) { /* cache miss is fine */ }
        return bundled || null; // best effort — verify fails if key doesn't match
    }
    return bundled || null;
}

/**
 * Verify a compact-JWS RS256 signature over `signingInput` (the
 * "<header>.<payload>" string) given a base64url-encoded signature and a
 * public key. Reuses this module's base64UrlDecode + RSA-PKCS1 check so the
 * crypto lives in exactly one place. Never throws.
 * @returns {boolean}
 */
function verifyCompactRs256(signingInput, signatureB64url, publicKey) {
    if (!publicKey) return false;
    try {
        return crypto.verify(
            'RSA-SHA256',
            Buffer.from(signingInput),
            { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
            base64UrlDecode(signatureB64url)
        );
    } catch (e) {
        return false;
    }
}

module.exports = {
    verifyToken,
    decodeJwtUnverified,
    isExpectedIssuer,
    isFullTierIssuer,
    loadPublicKey,
    EXPECTED_ISSUER,
    FULL_TIER_ISSUER,
    TIER_HIERARCHY,
    _setPublicKeyForTesting,
    // Additive reuse primitives (see block above):
    base64UrlDecode,
    resolvePublicKeyByKid,
    verifyCompactRs256,
};
