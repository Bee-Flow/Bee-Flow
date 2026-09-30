// @typecheck
/**
 * Display names for the people a documents answer mentions: the owner and
 * last editor on a library row, the authors of versions, the peers present.
 *
 * Only a NAME, and only for a user of the reader's own organisation (an
 * org-less reader: org-less users only); anybody else stays an id the client
 * shows as "Former member" or "Someone". A lookup that fails leaves that
 * person unnamed rather than failing the answer.
 */

'use strict';

const MAX_PEOPLE = 100;

/** @param {any} user */
function displayNameOf(user) {
    const full = [user.firstName, user.lastName].filter((v) => typeof v === 'string' && v.trim()).join(' ');
    const name = (typeof user.displayName === 'string' && user.displayName.trim()) || full || user.username;
    return typeof name === 'string' && name ? name : undefined;
}

/**
 * @param {Iterable<string|null|undefined>} ids
 * @param {string|null|undefined} orgId  the reader's organisation
 * @param {{ getUser?: (id: string) => Promise<any>, log?: { warn: Function } }} [deps]
 * @returns {Promise<Record<string, { name?: string }>>}
 */
async function describePeople(ids, orgId, deps = {}) {
    const getUser = deps.getUser || ((id) => require('../../stores/userStore').getUser(id));
    const log = deps.log || require('../../telemetry/log');
    const unique = [...new Set([...ids].filter((id) => typeof id === 'string' && id))].slice(0, MAX_PEOPLE);
    /** @type {Record<string, { name?: string }>} */
    const people = {};
    await Promise.all(unique.map(async (id) => {
        let user = null;
        try { user = await getUser(id); } catch (err) {
            log.warn('[Documents] person lookup failed:', err && err.message);
            return;
        }
        if (!user || (user.organizationId || '') !== (orgId || '')) return;
        const name = displayNameOf(user);
        people[id] = name ? { name } : {};
    }));
    return people;
}

module.exports = { describePeople, displayNameOf };
