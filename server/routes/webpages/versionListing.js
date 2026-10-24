/**
 * A version listing as the history list may read it: with a maker, with
 * the published row designated, and with the honest statement of WHAT a snapshot of this
 * page does and does not cover.
 *
 * The routes (./versions.js) fetch the rows; interpreting them happens here.
 */

const webpageStore = require('../../stores/webpageStore');
const userStore = require('../../stores/userStore');
const versionFacts = require('../../core/webpages/versionFacts');
const log = require('../../telemetry/log');

/**
 * Names for the `actor_user_id`s of a list of version listings (W4).
 *
 * THE RULE: an id that cannot be read is neither "you" nor empty. What does not get
 * resolved here stays absent from the map, and versionFacts.actorOf makes a maker of it
 * that is UNKNOWN.
 *
 * The session comes before the store, and in practice that saves EVERY query: a web page is
 * owner-scoped (every write path runs via getWebpage(id, userId)), so the maker of almost
 * every row IS the reader. Only when another id appears in the list — a page whose ownership
 * was once transferred — is the store queried once in a batch.
 *
 * `req.session.user` has no fixed shape (establishSession keeps it verbatim: a full user row,
 * an OCS object or a minimal sign-in shape), so all three of the usual name fields are tried,
 * and otherwise it falls through to the store.
 */
async function versionActorNames(rows, sessionUser) {
    const names = new Map();
    const self = sessionUser?.id || null;
    const selfName = sessionUser?.displayName || sessionUser?.name || sessionUser?.username || null;
    if (self && selfName) names.set(self, selfName);

    const missing = [...new Set(rows.map(r => r.actorUserId).filter(id => id && !names.has(id)))];
    if (missing.length === 0) return names;
    try {
        const found = await userStore.getUserAvatarsByIds(missing);
        for (const u of found || []) {
            const label = u.displayName || u.username || null;
            if (label) names.set(u.id, label);
        }
    } catch (e) {
        // A failed name lookup must not cost the history — the rows then come back with an
        // unknown maker, which is true.
        log.warn('[Webpages] Version actor lookup failed:', e.message);
    }
    return names;
}

/** Eén rij zoals de geschiedenislijst hem mag lezen: id-loos, met een maker. */
/**
 * WHAT a snapshot of this page does and does not capture.
 *
 * This is not a decorative field. A snapshot carries only the three primary slots
 * plus the page database (stores/webpage/shared.js: VERSIONED_SLOTS), and on a
 * react-mui page — the DEFAULT type of every new page — the app lives in
 * `src/*`, so in EXTRA files. The system prompt even forbids the model to write the
 * three slots (integrations/webpageFramework.js). Consequence: on such a page no 'ai'
 * or 'manual' row ever arises, the list stays empty, and the author read there
 * "you have not edited enough yet" — an explanation that is not true there. It should
 * say that the feature does not cover these files.
 *
 * @returns {{slots:string[], extraFiles:boolean, framework:string, coversProject:boolean}}
 */
function versionCoverage(wp) {
    // Loaded locally, just like the other webpageFramework reading in this file:
    // the module pulls in the whole framework catalogue, and that need not be paid on every route.
    const { resolveFramework } = require('../../integrations/webpageFramework');
    const framework = resolveFramework(wp);
    return {
        // De slots die daadwerkelijk in een momentopname belanden.
        slots: [...webpageStore.VERSIONED_SLOTS],
        // Extra files are in NO snapshot — not on a vanilla page with `modules/state.js`,
        // and not on a react page.
        extraFiles: false,
        framework,
        // Does the history cover the project the author is working on? On
        // react-mui that is NO: there everything lives in extra files.
        coversProject: framework !== 'react-mui',
    };
}

function decorateVersionRow(row, { viewerId, names, publishedVersionId }) {
    const { actorUserId, ...rest } = row;
    return {
        ...rest,
        actor: versionFacts.actorOf(actorUserId, { viewerId, names }),
        // The list need not compare the pointer itself; here it is already fixed
        // which row is the published one.
        isPublished: !!publishedVersionId && row.id === publishedVersionId,
    };
}

module.exports = { versionActorNames, versionCoverage, decorateVersionRow };
