// @typecheck strict
const crypto = require('node:crypto');

/**
 * Tuya data centers. EU is the default: this is a GDPR-first product and the
 * Central Europe cluster keeps device data inside the EEA.
 */
/** @type {Record<string, string>} */
const DATA_CENTERS = {
    eu: 'https://openapi.tuyaeu.com',       // Central Europe
    weu: 'https://openapi-weaz.tuyaeu.com', // Western Europe
    us: 'https://openapi.tuyaus.com',
    cn: 'https://openapi.tuyacn.com',
    in: 'https://openapi.tuyain.com',
};

const DEFAULT_REGION = 'eu';

const DEFAULT_LIMIT = 50;

const MAX_LIMIT = 200;

/** Tools that touch a physical device or scene — skipped when read-only. */
const WRITE_TOOLS = ['send_command', 'switch_device', 'set_light', 'trigger_scene'];

/**
 * Tuya category codes for locks, safes, access control and gate/garage openers.
 *
 * These stay read-only unless the operator sets TUYA_ALLOW_LOCKS. An agent acts
 * on text it did not write — a booby-trapped e-mail or web page that reaches the
 * model must not be one tool call away from opening a front door.
 */
const LOCK_CATEGORIES = new Set([
    'ms',       // smart lock
    'mspro',    // smart lock (pro)
    'jtmspro',  // residential lock pro
    'jtmsbh',   // household lock
    'bxx',      // safe box
    'mk',       // access control
    'ckmkzq',   // garage door opener
]);

/** Belt-and-braces for categories Tuya adds after this ships. */
const LOCK_NAME_HINT = /\b(lock|slot|deurslot|garage|gate|poort|hek|safe|kluis|barrier|slagboom)\b/i;

/**
 * Device fields that must never leave this process.
 *   local_key — the per-device secret used for LAN control; leaking it into a
 *               chat transcript hands over the device.
 *   ip        — the household's public IP address, i.e. personal data we have
 *               no reason to put in front of a model.
 */
const DEVICE_SECRET_FIELDS = ['local_key', 'ip'];

/**
 * @param {string | undefined} v
 */
const isTruthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

/**
 * Resolve a data-center base URL from a region code, with an explicit override.
 * @param {string} region
 * @param {string | undefined} override
 */
function resolveBaseUrl(region, override) {
    const explicit = String(override || '').trim().replace(/\/+$/, '');
    if (explicit) return explicit;
    const key = String(region || '').trim().toLowerCase();
    return DATA_CENTERS[key] || DATA_CENTERS[DEFAULT_REGION];
}

/**
 * Read the server's configuration from the environment.
 *
 * Deliberately does NOT throw on missing credentials: the marketplace probes a
 * freshly installed server without any user credentials to discover its tools,
 * so startup must always succeed. Credentials are enforced per call via
 * `requireCredentials()`.
 *
 * Every value can come from either the per-user credentials the MCP manager
 * injects or from operator env on the API container — the manager merges the
 * two, user first, so operator values act as defaults.
 * @param {NodeJS.ProcessEnv} [env]
 */
function readConfig(env = process.env) {
    const region = String(env.TUYA_REGION || '').trim().toLowerCase() || DEFAULT_REGION;

    return {
        accessId: String(env.TUYA_ACCESS_ID || '').trim(),
        accessSecret: String(env.TUYA_ACCESS_SECRET || '').trim(),
        // Optional: with a UID we list that app account's devices, without one we
        // fall back to every device in the cloud project.
        uid: String(env.TUYA_UID || '').trim(),
        region,
        baseUrl: resolveBaseUrl(region, env.TUYA_BASE_URL),
        // Operator escape hatch: expose the read tools only.
        readOnly: isTruthy(env.TUYA_READ_ONLY),
        // Operator opt-in: allow commands to locks, safes and gate openers.
        allowLocks: isTruthy(env.TUYA_ALLOW_LOCKS),
    };
}

/**
 * Throw a user-actionable error when the per-user credentials are missing.
 * @param {ReturnType<typeof readConfig>} config
 */
function requireCredentials(config) {
    if (!config.accessId || !config.accessSecret) {
        throw new Error(
            'Tuya credentials are not configured. Add your Tuya Access ID and Access Secret under Settings → Connections.'
        );
    }
    return config;
}

/**
 * @param {string} input
 */
const sha256Hex = (input) => crypto.createHash('sha256').update(input ?? '', 'utf8').digest('hex');

module.exports = { DATA_CENTERS, DEFAULT_REGION, DEFAULT_LIMIT, MAX_LIMIT, WRITE_TOOLS, LOCK_CATEGORIES, LOCK_NAME_HINT, DEVICE_SECRET_FIELDS, resolveBaseUrl, readConfig, requireCredentials, sha256Hex };
