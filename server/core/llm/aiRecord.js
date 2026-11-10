// @typecheck strict
/**
 * The `ai` config record, read for a change.
 *
 * configStore.getConfig hands out the object in its cache, shared by every
 * reader in the process. A caller that changes that object and then fails to
 * write it leaves the process's config ahead of the database until the cache
 * entry expires: a provider that is not in the database is listed, a deleted one is
 * gone, and the next successful write of someone else persists it after all.
 * So a writer works on a private copy and the cache only moves when setConfig
 * succeeded (it drops the entry).
 */

const configStore = require('../../stores/configStore');

/** @returns {Promise<Record<string, any>>} a private, deep copy of the `ai` record ({} when there is none) */
async function loadAiForWrite() {
    return structuredClone((await configStore.getConfig('ai')) || {});
}

module.exports = { loadAiForWrite };
