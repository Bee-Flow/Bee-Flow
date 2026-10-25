// @typecheck strict
/**
 * Tuya MCP — pure helpers.
 *
 * Everything here is side-effect free so it can be unit tested without a Tuya
 * account; the HTTP work lives in index.mjs.
 *
 * Tuya publishes no MCP server of its own (`tuya/tuya-mcp-sdk` points the other
 * way — it exposes *your* capabilities to Tuya's agent, and is Python/Go/C#
 * only), so this server drives the Tuya Cloud OpenAPI directly. That API is
 * plain HTTPS with an HMAC-SHA256 request signature, which is why this whole
 * integration needs no dependency beyond node:crypto and fetch.
 *
 * Signature (developer.tuya.com → "Sign Requests"):
 *   stringToSign = METHOD \n sha256hex(body) \n <Signature-Headers> \n urlWithSortedQuery
 *   str          = client_id + [access_token] + t + nonce + stringToSign
 *   sign         = HMAC-SHA256(str, secret) as UPPERCASE hex
 * Token requests (/v1.0/token) omit the access_token; every other call includes
 * it. We never use Signature-Headers, so that line is always empty.
 */

'use strict';

const crypto = require('node:crypto');
const { DATA_CENTERS, DEFAULT_REGION, DEFAULT_LIMIT, MAX_LIMIT, WRITE_TOOLS, LOCK_CATEGORIES, LOCK_NAME_HINT, DEVICE_SECRET_FIELDS, resolveBaseUrl, readConfig, requireCredentials, sha256Hex } = require('./tuyaReadConfig');

/**
 * Clamp a caller-supplied result limit into a sane range.
 * @param {number} [fallback]
 * @param {number} [max]
 * @param {unknown} value
 */
function clampLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
}

/**
 * Build the path Tuya signs: query parameters sorted by key.
 *
 * The sorted form goes into stringToSign *and* onto the wire — sending the
 * params in a different order than they were signed fails with "sign invalid".
 * @param {string} path
 * @param {Record<string, unknown> | null} [query]
 */
function canonicalUrl(path, query = {}) {
    const entries = Object.entries(query || {})
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    if (entries.length === 0) return path;
    const qs = entries
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
    return `${path}?${qs}`;
}

/**
 * Sign one request and return the headers it needs.
 *
 * `url` must already be canonical (see `canonicalUrl`). `t` and `nonce` are
 * parameters rather than generated here so the unit tests can pin a vector.
 *
 * @param {{ method: string, url: string, body?: string, accessId: string, accessSecret: string, accessToken?: string, t: number, nonce?: string }} parts
 */
function signRequest({ method, url, body = '', accessId, accessSecret, accessToken = '', t, nonce }) {
    const verb = String(method || 'GET').toUpperCase();
    const timestamp = String(t ?? Date.now());
    const once = nonce ?? crypto.randomUUID();

    // The third line is the Signature-Headers block; we never use it, so it is
    // empty — but the newline itself is still part of the string.
    const stringToSign = [verb, sha256Hex(body), '', url].join('\n');
    const str = `${accessId}${accessToken}${timestamp}${once}${stringToSign}`;
    const sign = crypto.createHmac('sha256', accessSecret).update(str, 'utf8').digest('hex').toUpperCase();

    /** @type {{ client_id: string; sign: string; t: string; sign_method: string; nonce: string; access_token?: string; "Content-Type"?: string }} */
    const headers = {
        client_id: accessId,
        sign,
        t: timestamp,
        sign_method: 'HMAC-SHA256',
        nonce: once,
    };
    if (accessToken) headers.access_token = accessToken;
    return headers;
}

/**
 * Strip credentials out of a string before it leaves the process — Tuya echoes
 * request details back in some error payloads.
 * @param {string} [accessToken]
 * @param {unknown} message
 * @param {{ accessSecret?: string }} [config]
 */
function scrubSecrets(message, config = {}, accessToken = '') {
    let out = String(message ?? '');
    for (const secret of [config.accessSecret, accessToken]) {
        if (secret && secret.length > 4) out = out.split(secret).join('***');
    }
    return out;
}

/**
 * Is this a lock, safe, access controller or gate opener?
 * @typedef {{ id?: string, device_id?: string, name?: string, category?: string, product_name?: string, product_id?: string, online?: boolean, model?: string, [k: string]: unknown }} TuyaDevice
 * @param {TuyaDevice} [device]
 */
function isLockDevice(device = {}) {
    const category = String(device.category || '').trim().toLowerCase();
    if (LOCK_CATEGORIES.has(category)) return true;
    return LOCK_NAME_HINT.test(`${device.product_name || ''} ${device.name || ''}`);
}

/**
 * Project a raw Tuya device onto the fields we are willing to hand to a model.
 * @param {TuyaDevice} [device]
 */
function summarizeDevice(device = {}) {
    /** @type {Record<string, string | boolean | null>} */
    const summary = {
        id: device.id || device.device_id || null,
        name: device.name || '',
        category: device.category || null,
        product_name: device.product_name || device.product_id || null,
        online: device.online === true,
        model: device.model || null,
        is_lock: isLockDevice(device),
    };
    // Guard against a future field rename quietly re-introducing a secret.
    for (const field of DEVICE_SECRET_FIELDS) delete summary[field];
    return summary;
}

/** Filter a device list by free-text query, online state and category. @param {any[]} devices @param {{ query?: string, online?: boolean, category?: string }} [opts] */
function filterDevices(devices, { query, online, category } = {}) {
    let out = Array.isArray(devices) ? devices.slice() : [];

    const q = String(query || '').trim().toLowerCase();
    if (q) {
        out = out.filter((d) =>
            `${d.name || ''} ${d.product_name || ''} ${d.category || ''}`.toLowerCase().includes(q)
        );
    }
    if (typeof online === 'boolean') out = out.filter((d) => (d.online === true) === online);

    const cat = String(category || '').trim().toLowerCase();
    if (cat) out = out.filter((d) => String(d.category || '').toLowerCase() === cat);

    return out;
}

/**
 * Resolve a caller's device reference — an id or a friendly name — to one device.
 *
 * Returns `{ device, candidates }`. An ambiguous name yields `device: null` and
 * the candidate list, so the caller can ask instead of guessing which lamp to
 * switch off.
 * @param {TuyaDevice[] | null | undefined} devices
 * @param {unknown} reference
 */
function matchDevice(devices, reference) {
    const list = Array.isArray(devices) ? devices : [];
    const raw = String(reference ?? '').trim();
    if (!raw) return { device: null, candidates: [] };

    const byId = list.find((d) => String(d.id || d.device_id || '') === raw);
    if (byId) return { device: byId, candidates: [byId] };

    const needle = raw.toLowerCase();
    const exact = list.filter((d) => String(d.name || '').trim().toLowerCase() === needle);
    if (exact.length === 1) return { device: exact[0], candidates: exact };
    if (exact.length > 1) return { device: null, candidates: exact };

    const partial = list.filter((d) => String(d.name || '').toLowerCase().includes(needle));
    if (partial.length === 1) return { device: partial[0], candidates: partial };
    return { device: null, candidates: partial };
}

/**
 * Tuya returns a spec's `values` as a JSON *string*; parse it defensively.
 * @typedef {{ min?: number, max?: number, step?: number, scale?: unknown, unit?: string, h?: TuyaSpecValues, s?: TuyaSpecValues, v?: TuyaSpecValues, range?: string[] }} TuyaSpecValues
 * @typedef {{ code?: string, type?: string, values?: unknown }} TuyaSpecEntry
 * @typedef {{ status?: TuyaSpecEntry[], functions?: TuyaSpecEntry[] }} TuyaSpecification
 * @param {unknown} values
 * @returns {TuyaSpecValues}
 */
function parseSpecValues(values) {
    if (values && typeof values === 'object') return values;
    try {
        const parsed = JSON.parse(String(values || '{}'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
        return {};
    }
}

/**
 * Map a percentage onto a Tuya integer range and back.
 *
 * Tuya reports brightness as a raw integer in a per-product range (commonly
 * 10-1000), which is meaningless to a model — it wants "set it to 40%".
 * @param {unknown} percent
 * @param {{ values?: unknown } & TuyaSpecValues} [spec]
 */
function percentToRaw(percent, spec = {}) {
    const { min = 0, max = 100, step = 1 } = parseSpecValues(spec.values ?? spec);
    const pct = Math.min(100, Math.max(0, Number(percent)));
    if (!Number.isFinite(pct)) throw new Error('percent must be a number between 0 and 100');

    const raw = min + ((max - min) * pct) / 100;
    const stepped = step > 0 ? Math.round((raw - min) / step) * step + min : Math.round(raw);
    return Math.min(max, Math.max(min, Math.round(stepped)));
}

/**
 * @param {unknown} raw
 * @param {{ values?: unknown } & TuyaSpecValues} [spec]
 */
function rawToPercent(raw, spec = {}) {
    const { min = 0, max = 100 } = parseSpecValues(spec.values ?? spec);
    if (max === min) return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    return Math.round(((value - min) / (max - min)) * 100);
}

/**
 * Decorate raw status data points with what the product spec says they mean.
 * `scale` is a power of ten the device applies before reporting — a temperature
 * of 23.5 °C arrives as 235 with scale 1.
 * @param {{ code: string, value: unknown }[] | null | undefined} status
 * @param {TuyaSpecification} [specification]
 */
function summarizeStatus(status, specification = {}) {
    const specs = new Map();
    for (const entry of [...(specification.status || []), ...(specification.functions || [])]) {
        if (entry && entry.code) specs.set(entry.code, entry);
    }

    return (Array.isArray(status) ? status : []).map((point) => {
        /** @type {{ code: string, value: unknown, type?: string | null, unit?: string, display?: number, percent?: number }} */
        const out = { code: point.code, value: point.value };
        const spec = specs.get(point.code);
        if (!spec) return out;

        out.type = spec.type || null;
        const values = parseSpecValues(spec.values);
        if (values.unit) out.unit = values.unit;

        if (typeof point.value === 'number') {
            const scale = Number(values.scale) || 0;
            if (scale > 0) out.display = point.value / 10 ** scale;
            const percent = rawToPercent(point.value, spec);
            if (percent !== null && Number.isFinite(values.min) && Number.isFinite(values.max)) {
                out.percent = percent;
            }
        }
        return out;
    });
}

/**
 * Find the code that turns a device on and off. Products disagree: a plug uses
 * `switch_1`, a lamp `switch_led`, a fan plain `switch`.
 * @param {TuyaSpecification} [specification]
 */
function findSwitchCode(specification = {}) {
    const functions = Array.isArray(specification.functions) ? specification.functions : [];
    const booleans = functions.filter((f) => String(f.type || '').toLowerCase() === 'boolean');
    const preferred = ['switch', 'switch_led', 'switch_1'];
    for (const code of preferred) {
        if (booleans.some((f) => f.code === code)) return code;
    }
    const anySwitch = booleans.find((f) => String(f.code || '').startsWith('switch'));
    return anySwitch ? anySwitch.code : null;
}

/**
 * Check commands against the device's instruction set before sending them.
 * An unknown spec (some products return none) is not a reason to refuse.
 * @param {unknown} commands
 * @param {TuyaSpecification} [specification]
 * @returns {{ code: string, value: unknown }[]}
 */
function validateCommands(commands, specification = {}) {
    const list = Array.isArray(commands) ? commands : [];
    if (list.length === 0) throw new Error('At least one command is required');

    for (const command of list) {
        if (!command || typeof command.code !== 'string' || !command.code.trim()) {
            throw new Error('Every command needs a "code"');
        }
        if (!('value' in command)) throw new Error(`Command "${command.code}" needs a "value"`);
    }

    const functions = Array.isArray(specification.functions) ? specification.functions : [];
    if (functions.length === 0) return list;

    const known = new Set(functions.map((f) => f.code));
    const unknown = list.map((c) => c.code).filter((code) => !known.has(code));
    if (unknown.length > 0) {
        throw new Error(
            `This device does not accept ${unknown.join(', ')}. Supported: ${[...known].join(', ')}`
        );
    }
    return list;
}

/**
 * Hide the write tools when the operator has pinned this server to read-only.
 * @template {{ name: string }} T
 * @param {T[]} tools
 * @param {{ readOnly?: boolean }} [config]
 * @returns {T[]}
 */
function allowedTools(tools, config = {}) {
    if (!config.readOnly) return tools;
    return tools.filter((tool) => !WRITE_TOOLS.includes(tool.name));
}

module.exports = {
    DATA_CENTERS,
    DEFAULT_REGION,
    WRITE_TOOLS,
    LOCK_CATEGORIES,
    resolveBaseUrl,
    readConfig,
    requireCredentials,
    clampLimit,
    sha256Hex,
    canonicalUrl,
    signRequest,
    scrubSecrets,
    isLockDevice,
    summarizeDevice,
    filterDevices,
    matchDevice,
    parseSpecValues,
    percentToRaw,
    rawToPercent,
    summarizeStatus,
    findSwitchCode,
    validateCommands,
    allowedTools,
};
