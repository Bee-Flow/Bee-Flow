'use strict';
/** The pin (learnMediaPack.json) a release carries, and where its assets are fetched from. */

const path = require('node:path');

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Validate the shape of a pin (learnMediaPack.json). Returns the pin; throws a precise reason otherwise. */
function validatePin(pin) {
    if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw new Error('pin is not an object');
    if (typeof pin.version !== 'string' || !VERSION.test(pin.version)) throw new Error('pin.version is not a valid version string');
    if (typeof pin.manifest !== 'string' || !SEGMENT.test(pin.manifest) || path.extname(pin.manifest).toLowerCase() !== '.json') {
        throw new Error('pin.manifest is not a plain .json file name');
    }
    if (typeof pin.manifestSha256 !== 'string' || !HEX64.test(pin.manifestSha256.toLowerCase())) throw new Error('pin.manifestSha256 is not a sha256 hex digest');
    if (typeof pin.baseUrl !== 'string') throw new Error('pin.baseUrl is not a string');
    try { new URL(pin.baseUrl); } catch { throw new Error('pin.baseUrl is not a URL'); }
    if (!Array.isArray(pin.videoIds) || !pin.videoIds.every((id) => typeof id === 'string' && SEGMENT.test(id))) {
        throw new Error('pin.videoIds is not a list of video ids');
    }
    return pin;
}

/** The base URL (with a trailing slash): LEARN_MEDIA_SOURCE / opts.source over pin.baseUrl. */
function resolveBase(pin, opts) {
    const env = opts.env || process.env;
    const override = (typeof opts.source === 'string' && opts.source.trim()) || (typeof env.LEARN_MEDIA_SOURCE === 'string' && env.LEARN_MEDIA_SOURCE.trim()) || '';
    const base = override || pin.baseUrl;
    return base.endsWith('/') ? base : `${base}/`;
}

module.exports = { validatePin, resolveBase };
