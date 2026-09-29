/**
 * "Which button, in which screen, of which app" — resolved FOR ONE VIEWER.
 *
 * A routine made from a button in App Studio stores a back-pointer on its
 * trigger (`trigger.appRef`, shape in automation/appTriggerContract.js). The
 * builder wants to show it as a breadcrumb — App › Screen › button — and the
 * trigger card wants to name the app and the screen.
 *
 * Three answers that must stay apart, because they read the same on screen and
 * mean completely different things:
 *
 *   ok            the ids resolve and the viewer owns the app. Names, and a
 *                 link that will actually open.
 *   restricted    the app is not the viewer's. NO names, NO link. A name the
 *                 viewer was not allowed to read is a leak, and a link that
 *                 lands on 403 is worse than no link — so the id is shown
 *                 instead, which is honest and useless to anyone else.
 *   *_missing     the app, the screen or the button is gone. This is NOT "no
 *                 trigger": the routine still fires from an app action that no
 *                 longer has a button, and the card has to say so rather than
 *                 quietly rendering a bare "Studio App trigger".
 *
 * ── Why owner-equality, and nothing wider ─────────────────────────────────
 * The breadcrumb links into App Studio's EDITOR, and that is owner-only
 * (studioAppStore.updateStudioApp filters on user_id; routes/studioApps.js's
 * restore path checks app.userId !== userId explicitly). A reader who may see
 * the published app still cannot open the editor, so `canOpen` would be a
 * promise the product does not keep. Unknown narrows: anyone who is not the
 * owner gets `restricted`, ids only.
 *
 * `app_missing` is reported to everyone, and that is deliberate: a studio app
 * id is a crypto.randomUUID(), so "no app has this id" tells a prober nothing
 * it could not have assumed. What is NOT reported is "this id belongs to
 * someone else" — that answer is folded into `restricted` together with every
 * other refusal, so the two cannot be told apart.
 *
 * Pure: takes the app row (or null) and the viewer id, returns a record. The
 * route does the loading; the tests do neither.
 */

'use strict';

const { findScreen, findNode } = require('./definitionOps');

/**
 * The naming props a component carries, in the order the inspector reads them
 * (agent-hub/.../inspector/nodeLabel.js — `label` for an input or a button,
 * `title` for a card, `text` for a heading, `heading` for a section-ish one).
 * Mirrored rather than imported: this is the server, and the two copies drift
 * only when a component gains a fifth naming prop.
 */
const NAMING_PROPS = ['label', 'title', 'text', 'heading'];

const MAX_LABEL = 60;

function trimmed(value, max = MAX_LABEL) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/** A component's own text, or null when it has none (never a type name). */
function nodeOwnText(node) {
    const props = node?.props || {};
    for (const key of NAMING_PROPS) {
        const hit = trimmed(props[key]);
        if (hit) return hit;
    }
    return null;
}

/**
 * Resolve a back-pointer for one viewer.
 *
 * @param {object}      args
 * @param {object|null} args.app          the studio_apps row, or null when there is none
 * @param {object|null} args.ref          { appId, screenId, nodeId } — nodeId optional
 * @param {string|null} args.viewerUserId the signed-in user
 * @returns {{
 *   status: 'ok'|'restricted'|'app_missing'|'screen_missing'|'node_missing',
 *   appId: string|null, screenId: string|null, nodeId: string|null,
 *   appName: string|null, screenName: string|null, nodeLabel: string|null,
 *   canOpen: boolean,
 * }}
 */
function describeAppRef({ app = null, ref = null, viewerUserId = null } = {}) {
    const base = {
        appId: typeof ref?.appId === 'string' ? ref.appId : null,
        screenId: typeof ref?.screenId === 'string' ? ref.screenId : null,
        nodeId: typeof ref?.nodeId === 'string' ? ref.nodeId : null,
        appName: null,
        screenName: null,
        nodeLabel: null,
        canOpen: false,
    };

    // No row at all — the app was deleted (or never existed). Said to
    // everyone; see the header for why that is not an oracle worth hiding.
    if (!app) return { ...base, status: 'app_missing' };

    // Anything that is not "you own this app" refuses identically. No name, no
    // link, and no hint about which refusal it was.
    if (!viewerUserId || app.userId !== viewerUserId) return { ...base, status: 'restricted' };

    const appName = trimmed(app.name);
    // The OWNER's working draft — the same definition App Studio's editor
    // shows. A published copy could be a generation behind, and a breadcrumb
    // that names a screen the author has already renamed is a small lie.
    const definition = app.definition || null;

    const screen = base.screenId ? findScreen(definition, base.screenId) : null;
    if (!screen) return { ...base, status: 'screen_missing', appName, canOpen: true };
    const screenName = trimmed(screen.name);

    // A ref without a node level still resolves down to the screen — an older
    // link, or one written for a screen-level action. Not an error.
    if (!base.nodeId) return { ...base, status: 'ok', appName, screenName, canOpen: true };

    const found = findNode(definition, base.nodeId);
    // The node has to live on the screen the ref names. A button that was
    // moved to another screen makes the breadcrumb wrong, and a wrong
    // breadcrumb is worse than one that admits the button is not there.
    if (!found || found.screen?.id !== screen.id) {
        return { ...base, status: 'node_missing', appName, screenName, canOpen: true };
    }
    return {
        ...base,
        status: 'ok',
        appName,
        screenName,
        nodeLabel: nodeOwnText(found.node),
        canOpen: true,
    };
}

/**
 * ── WHO a routine made from a button belongs to ────────────────────────────
 *
 * "New one from this button" mints a routine whose whole reason to exist is
 * that ONE app action runs it. The app action runs it ACTS-AS-OWNER: the
 * bridge (actionExecutor/automationBridge.js) refuses outright when the
 * routine's owner is not the app's owner, and a webpage bridge does the same.
 * So the owner of the new routine is not a detail — it decides whose
 * permissions the routine will run with.
 *
 * Two ways to get that wrong, and both have to be refused:
 *
 *   under the CLICKER — the app's owner then cannot run it at all (the bridge
 *   refuses), so the button is broken from the moment it is wired, and nothing
 *   says so until somebody presses it.
 *
 *   under the APP OWNER while somebody else is clicking — worse: the clicker
 *   has just authored a routine that runs with the owner's permissions. That
 *   is the leak this programme already found at O3 and A2.
 *
 * So the only case that may proceed is the one where those two are the SAME
 * person, and the routine is stamped with the app owner's id — the same value
 * either way, written from the app row so the rule is visible in the code
 * rather than assumed.
 *
 * Everything else refuses, INCLUDING "I could not tell": an app row that will
 * not load, or one that names no owner, is not a licence to guess. Unknown
 * narrows.
 *
 * Pure, like describeAppRef: the caller loads the app row (and turns a lookup
 * failure into `app: null`), this decides.
 */

const OWNER_REFUSALS = Object.freeze({
    actor_unknown: 'It is not clear who is asking, so no routine was made.',
    app_unknown: 'The app this button belongs to could not be read, so there is no owner to make the routine under. Try again, or make the routine from the Routines screen.',
    owner_unknown: 'The app this button belongs to names no owner, so there is nobody to make the routine under.',
    owner_mismatch: 'This app belongs to somebody else. A routine made here would run with the app owner\'s permissions, so only the owner can make one from this button.',
});

/**
 * @param {object}      args
 * @param {object|null} args.app          the studio_apps row, or null when it
 *                                        does not exist OR could not be read
 * @param {string|null} args.actorUserId  the signed-in user pressing the button
 * @returns {{ok: true, ownerId: string}|{ok: false, code: string, message: string}}
 */
function appRefOwnerVerdict({ app = null, actorUserId = null } = {}) {
    const refuse = (code) => ({ ok: false, code, message: OWNER_REFUSALS[code] });
    if (!actorUserId || typeof actorUserId !== 'string') return refuse('actor_unknown');
    if (!app) return refuse('app_unknown');
    if (!app.userId || typeof app.userId !== 'string') return refuse('owner_unknown');
    if (app.userId !== actorUserId) return refuse('owner_mismatch');
    return { ok: true, ownerId: app.userId };
}

module.exports = { describeAppRef, appRefOwnerVerdict, OWNER_REFUSALS, nodeOwnText, NAMING_PROPS, MAX_LABEL };
