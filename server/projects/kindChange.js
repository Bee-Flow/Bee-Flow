// @typecheck
/**
 * What a project holds that the other side of the split refuses.
 *
 * A project row is a collaborative project ('workspace') or a Studio Solution
 * ('solution'), and each side shows and accepts only its own kinds of content
 * (projects/membership.js `containers`). Classifying a project (PUT
 * /api/projects/:id/kind) therefore cannot be a bare flag flip: whatever is
 * filed in it and not allowed on the new side would drop out of every listing
 * of the project while staying filed, and a filing IS a read grant. A
 * published app filed into a project that became a workspace would stay
 * readable and runnable by every member, including people invited later only
 * to chat, and no screen would show it or offer to take it out. The other way
 * round, documents and meeting notes in a new Solution would stay readable to
 * every member with no project page listing them.
 *
 * So the route asks this module first, and refuses while anything is held
 * that the target refuses. The owner takes those items out (a legacy project
 * lists every section, in Studio and on the Projects page), then classifies.
 * Nothing is detached on the owner's behalf: a silent detach would take a
 * colleague's work out of the place they filed it.
 *
 * Counted, per response section:
 *   - every registry kind with a `countIn` that the target does not take
 *     (automations, apps, webpages, tables and agents into a workspace;
 *     documents and meeting notes into a Solution);
 *   - into a Solution, also what the registry does not track but a Solution
 *     never holds: conversations filed in it (direct and agent, shared or
 *     not; SOLUTION_HOLDS_NO_CHATS), team chats, and uploaded project files
 *     (SOLUTION_HOLDS_NO_FILES).
 * Not counted, on purpose:
 *   - approvals: records, not resources. They are never moved or detached
 *     (membership.js), so counting them would make the change impossible for
 *     good; they go with the automation that raised them;
 *   - project memories: derived from the chats, which are counted.
 *
 * A count that cannot be read fails the whole check (the route answers 500):
 * the safe answer to "is anything hidden by this?" is never a guess.
 *
 * `makeKindChange(deps)` takes every collaborator, so its test runs on fakes;
 * routes/projects.js builds it over its own project store and registry.
 */

'use strict';

/**
 * @param {object} [deps]
 * @param {object} [deps.membership]    projects/membership ({ countableKinds, isAllowedIn })
 * @param {object} [deps.store]         stores/projectStore ({ countChatHoldings })
 * @param {object} [deps.projectFiles]  projects/projectFiles ({ listFiles })
 */
function makeKindChange(deps = {}) {
    const membership = () => deps.membership || require('./membership');
    const store = () => deps.store || require('../stores/projectStore');
    const projectFiles = () => deps.projectFiles || require('./projectFiles');

    /**
     * The sections the project holds items in that `targetKind` refuses, with
     * how many: `{ apps: 2, automations: 1 }`. Empty when the change hides
     * nothing.
     *
     * @param {{ id: string }} project  a getProject() result
     * @param {'workspace'|'solution'} targetKind
     * @returns {Promise<Record<string, number>>}
     */
    async function refusedContent(project, targetKind) {
        /** @type {Record<string, number>} */
        const held = {};
        const add = (/** @type {string} */ section, /** @type {unknown} */ n) => {
            const count = Number(n) || 0;
            if (count > 0) held[section] = count;
        };

        const registry = membership();
        for (const k of registry.countableKinds()) {
            if (registry.isAllowedIn(k.kind, targetKind)) continue;
            const counts = await k.countIn([project.id]);
            add(k.section, counts instanceof Map ? counts.get(project.id) : 0);
        }

        if (targetKind === 'solution') {
            const chats = await store().countChatHoldings(project.id);
            add('conversations', chats?.conversations);
            add('teamChats', chats?.teamChats);
            const listed = await projectFiles().listFiles(project);
            add('files', Array.isArray(listed?.files) ? listed.files.length : 0);
        }
        return held;
    }

    return { refusedContent };
}

const defaultInstance = makeKindChange();

module.exports = {
    makeKindChange,
    refusedContent: defaultInstance.refusedContent,
};
