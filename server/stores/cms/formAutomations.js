// @typecheck noImplicitAny
// The allow-list of automations a website form may start, and which form
// blocks may target each.
//
// A CMS `form` block names an automation by id, but a block is editable by
// anyone who can edit the site (the admin panel, the MCP tools, an import),
// so naming an automation must not be enough to run it from the public web.
// An admin enables an automation for website forms HERE, and approves the
// block ids that may target it; the public endpoint (routes/cmsForms.js) runs
// an automation only for an approved block, and re-checks its organisation
// and state at use. The approved ids are the "form contract": the author of a
// site block cannot point a new block at an enabled automation by themselves.
//
// One config row per automation (`cms_form_automation:<id>`), changed under
// the store's per-key lock, so two admins cannot undo each other's change.

const configStore = require('../configStore');

const KEY_PREFIX = 'cms_form_automation:';
const keyOf = (/** @type {string} */ automationId) => `${KEY_PREFIX}${automationId}`;

/**
 * @typedef {object} FormAutomationEntry
 * @property {string | null} organizationId
 * @property {string} enabledAt
 * @property {string | null} enabledBy
 * @property {string[]} blockIds the form blocks an admin approved to target it
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {unknown} raw
 * @returns {FormAutomationEntry | null}
 */
function asEntry(raw) {
    if (!isPlainObject(raw) || typeof raw.enabledAt !== 'string') return null;
    return {
        organizationId: typeof raw.organizationId === 'string' ? raw.organizationId : null,
        enabledAt: raw.enabledAt,
        enabledBy: typeof raw.enabledBy === 'string' ? raw.enabledBy : null,
        blockIds: Array.isArray(raw.blockIds) ? raw.blockIds.filter((b) => typeof b === 'string') : [],
    };
}

/**
 * Read fresh, not cached: switching an automation OFF has to apply on every
 * replica at once, not after a cache window.
 * @param {string} automationId
 * @returns {Promise<FormAutomationEntry | null>}
 */
async function getFormAutomation(automationId) {
    return asEntry(await configStore.getConfigFresh(keyOf(automationId)));
}

/**
 * Enable an automation for website forms. Already enabled: nothing changes
 * (the approved blocks stay).
 * @param {string} automationId
 * @param {{ organizationId: string | null, enabledBy: string | null }} meta
 */
async function enableFormAutomation(automationId, meta) {
    await configStore.mutateConfig(keyOf(automationId), /** @param {unknown} current */ (current) => asEntry(current) || {
        organizationId: meta.organizationId,
        enabledAt: new Date().toISOString(),
        enabledBy: meta.enabledBy,
        blockIds: [],
    });
}

/** @param {string} automationId */
async function disableFormAutomation(automationId) {
    await configStore.deleteConfig(keyOf(automationId));
}

/**
 * Approve or withdraw one block. Does nothing for an automation that is not enabled.
 * @param {string} automationId
 * @param {string} blockId
 * @param {boolean} approved
 */
async function setBlockApproved(automationId, blockId, approved) {
    const key = keyOf(automationId);
    const next = await configStore.mutateConfig(key, /** @param {unknown} current */ (current) => {
        const entry = asEntry(current);
        if (!entry) return null;
        const rest = entry.blockIds.filter((b) => b !== blockId);
        return { ...entry, blockIds: approved ? [...rest, blockId] : rest };
    });
    // No entry: the lock created an empty row; take it away again.
    if (next === null) await configStore.deleteConfig(key);
}

/** @returns {Promise<Map<string, FormAutomationEntry>>} every enabled automation */
async function listFormAutomations() {
    const keys = await configStore.listKeysWithPrefix(KEY_PREFIX);
    const rows = await configStore.getConfigsByKeys(keys);
    /** @type {Map<string, FormAutomationEntry>} */
    const out = new Map();
    for (const key of keys) {
        const entry = asEntry(/** @type {Record<string, unknown>} */ (rows)[key]);
        if (entry) out.set(key.slice(KEY_PREFIX.length), entry);
    }
    return out;
}

module.exports = {
    getFormAutomation, enableFormAutomation, disableFormAutomation, setBlockApproved, listFormAutomations,
};
