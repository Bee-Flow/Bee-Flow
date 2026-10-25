// @typecheck noImplicitAny
// How many submissions a website form dropped silently, per form block and
// reason. The honeypot and minimum-age drops answer 200 on purpose (a probe
// must not learn which signal caught it), so without a count an admin could
// never see leads going missing. Counts only: no address, no content.

const configStore = require('../configStore');
const log = require('../../telemetry/log');

const KEY_PREFIX = 'cms_form_drops:';

/** @typedef {{ honeypot: number, tooFast: number }} FormDrops */

/** @param {unknown} v */
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * @param {string} blockId
 * @param {'honeypot' | 'tooFast'} kind
 */
async function countFormDrop(blockId, kind) {
    try {
        await configStore.mutateConfig(`${KEY_PREFIX}${blockId}`, /** @param {unknown} current */ (current) => {
            const cur = current && typeof current === 'object' ? /** @type {Record<string, unknown>} */ (current) : {};
            return { honeypot: count(cur.honeypot), tooFast: count(cur.tooFast), [kind]: count(cur[kind]) + 1 };
        });
    } catch (e) {
        // A counter must never fail a visitor's request.
        log.warn(`[cms/forms] could not count a dropped submission: ${e instanceof Error ? e.name : 'error'}`);
    }
}

/**
 * @param {string[]} blockIds
 * @returns {Promise<Record<string, FormDrops>>}
 */
async function getFormDrops(blockIds) {
    const rows = await configStore.getConfigsByKeys(blockIds.map((b) => `${KEY_PREFIX}${b}`));
    /** @type {Record<string, FormDrops>} */
    const out = {};
    for (const id of blockIds) {
        const row = /** @type {Record<string, unknown>} */ (rows)[`${KEY_PREFIX}${id}`];
        const r = row && typeof row === 'object' ? /** @type {Record<string, unknown>} */ (row) : {};
        out[id] = { honeypot: count(r.honeypot), tooFast: count(r.tooFast) };
    }
    return out;
}

module.exports = { countFormDrop, getFormDrops };
