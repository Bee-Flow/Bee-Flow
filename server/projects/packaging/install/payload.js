// @typecheck strict
/**
 * What an installed entity looks like NOW, read back from its store in the
 * same shape install hashed on arrival.
 *
 * Both halves of the Blueprint lifecycle read it: install's stamp pass
 * (install.js stampAll) records the hash of what was actually stored, and an
 * upgrade compares that hash against this payload to decide whether anybody
 * touched the entity since. It lives in a leaf rather than in upgrade.js, which would make install
 * and upgrade require each other; a leaf both require keeps the graph one-way.
 */

'use strict';

/**
 * What an entity looks like NOW, in the same shape install hashed on arrival.
 * @param {string} entityId
 */
async function currentPayload(/** @type {unknown} */ kind, entityId) {
    if (kind === 'automation') {
        const row = await require('../../../stores/automationStore').getAutomation(entityId);
        return row ? row.definition : null;
    }
    if (kind === 'app') {
        const row = await require('../../../stores/studioAppStore').getStudioApp(entityId);
        return row ? row.definition : null;
    }
    if (kind === 'webpage') {
        const store = require('../../../stores/webpageStore');
        const row = await store.getWebpageRaw(entityId);
        if (!row) return null;
        return await store.readAllSlots(row.userId, entityId);
    }
    if (kind === 'agent') {
        // `config` is what install hashed, and it is the whole of what a
        // Blueprint can change about an agent.
        const row = await require('../../../stores/agentStore').getAgent(entityId);
        return row ? (row.config || {}) : null;
    }
    return null;
}

module.exports = { currentPayload };
