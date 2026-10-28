// @typecheck noImplicitAny
/**
 * The writer of `automation_usage` for one STUDIO APP (P4 part C).
 *
 * The index answers one question: WHICH BUTTON RUNS THIS AUTOMATION? The automation
 * editor shows the answer as the capsule "Gebruikt door 1 knop", and that is not decoration:
 * it is the only screen on which someone about to delete, rename or deactivate an
 * automation sees that an app button hangs off it.
 *
 * This module has the exact shape of `core/webpages/webpageUsageSync.js` (W5),
 * with the same three rules — because these are the same three ways in which a
 * reconciler on a shared index silently goes wrong.
 *
 * ── THREE RULES THAT MUST NOT SHIFT ─────────────────────────────────
 *
 * 1. A FAILED SCAN DELETES NOTHING. `reconcileAutomationUsage` is
 *    delete-then-insert on `(consumer_kind, consumer_id)`: whoever gives it an EMPTY
 *    list wipes all rows of that app. The scan CAN fail — the database read falls
 *    over, the definition comes back as something that is not a definition — and then
 *    the honest outcome is "I don't know", not "this app uses nothing". Were that the
 *    latter here, one glitch would make the capsule read "is used nowhere", and
 *    someone would delete an automation that switches on a button in production.
 *    Unknown narrows: the old rows stay, and that is said LOUDLY (`ok:false` + a line
 *    in the log), never silently. This is the same trap that W5 closed at the 409 gate.
 *
 *    Note exactly where the trap sits: `studioAppStore` parses a definition with a
 *    `{}` fallback, so "unreadable" and "empty" look identical to the caller. Hence the
 *    shape check below — a canonical definition ALWAYS has a `screens` array
 *    (componentSpecs.emptyDefinition, and the validator requires it) — and NOT an
 *    `Object.keys(...).length === 0`, because a truly empty app is a valid app.
 *
 * 2. IT RUNS ON EVERY SAVE, SO IT HANGS BESIDE IT. Never IN the path of the save:
 *    `reconcileAppAutomationUsageDetached` is not awaited and never throws. An index is
 *    not worth an operation. It is moreover DEBOUNCED (same shape as W5 and as
 *    `datatableStore.notifyDatatableChanged`): the first save sets a timer, every save
 *    within it falls under it, and the pass reads the state only at the moment it fires
 *    — so the LAST state, not the first. The editor autosaves per group of keystrokes,
 *    so this costs one scan instead of ten.
 *
 *    It is idempotent by construction: `ref_id` is `act:<actionId>`, one row per
 *    (action, automation). A sequence step has no id, so its POSITION would be the only
 *    other key — and a position shifts on every edit. See appStudio/automationRefs.js.
 *
 * 3. A DELETED APP LEAVES NOTHING BEHIND. There is no FK from this index to
 *    `studio_apps` (another store, its own boot DDL), so nothing cleans up the rows.
 *    `listUsageOfAutomation` LEFT JOINs, and a leftover row tells an automation owner
 *    that a button he cannot see switches on his automation.
 *    Hence `purgeAppAutomationUsage` on the delete path — and, as a safety net,
 *    a reconcile that finds no app row any more and cleans up itself instead of
 *    writing. Cancelling also covers the pass that WAS ALREADY RUNNING: `_purgeEpoch`
 *    counts per app how often there was a purge, and a pass that comes back with an
 *    older number no longer writes.
 *
 * ── THE OWNER IS THE APP, NEVER THE SESSION ─────────────────────────
 *
 * `reconcileAutomationUsage` locks its INSERT on `automations.user_id =
 * ownerUserId`, and that owner comes here from the APP row (`app.userId`) —
 * never from whoever made the save. That is not the same person: `CreateAutomationRow`
 * creates an automation under `req.session.user.id`, and for an installed or transferred
 * Solution that diverges from `app.userId`. A reference across that boundary cannot run
 * anyway — `automationBridge` refuses when `automation.userId !== app.userId` — so indexing
 * it would show a link that refuses at the first click, with the name of someone else's
 * app attached.
 *
 * The consequence: `entries` non-empty and `written === 0` means "the automation no
 * longer exists, or is not of this owner" — a reason, not a success. Without that
 * branch it would be `{ok:true, written:0}` and the capsule would silently say
 * "is used nowhere".
 */

'use strict';
const logger = require('../telemetry/log');

/** The log prefix, so that an ops line names the path. */
const LABEL = 'AppStudio';

/** Zelfde venster als W5 en als de live-tap op datatableStore. */
const RECONCILE_DEBOUNCE_MS = 5000;

/** Waarom er niets is geschreven — in mensentaal, voor de logregel. */
const REASONS = Object.freeze({
    'no-id': 'no app id',
    'no-app': 'the app no longer exists',
    'no-owner': 'the app row has no owner',
    'unreadable-app': 'the app row could not be read',
    'unreadable-definition': 'the app definition could not be read, so what it runs is unknown',
    'not-indexed': 'the automations it names do not exist, or do not belong to the app owner',
    superseded: 'the app was deleted while this pass was running',
    failed: 'the reconcile itself failed',
});

/**
 * Wat draait deze app NU aan automatiseringen?
 *
 * @returns {Promise<{ok:boolean, reason:string, ownerId?:string|null,
 *                    entries?:Parameters<typeof import('../stores/automationUsageStore').reconcileAutomationUsage>[3], unset?:number, error?:string, which?:string}>}
 *   `ok:false` betekent ALTIJD "laat de index staan" — nooit "schrijf een lege
 *   lijst". Het onderscheid staat in `reason`.
 * @param {string} appId
 * @param {UsageDeps} [deps]
 */
async function collectAppAutomationUsage(appId, deps = {}) {
    if (!appId) return { ok: false, reason: 'no-id' };
    const studioAppStore = deps.studioAppStore || require('../stores/studioAppStore');
    const refs = deps.automationRefs || require('./automationRefs');

    let app;
    try {
        app = await studioAppStore.getStudioApp(appId);
    } catch (e) {
        // A READ ERROR is not a vanished app. Were this read as 'no-app', a database
        // hiccup would clear the index of an app that simply exists.
        return { ok: false, reason: 'unreadable-app', error: /** @type {Error} */ (e).message };
    }
    if (!app) return { ok: false, reason: 'no-app' };
    if (!app.userId) return { ok: false, reason: 'no-owner' };

    // ── BOTH DEFINITIONS, AND THAT IS NO DETAIL ─────────────────────────
    //
    // The question this index answers is "who breaks if I throw this away", and that
    // is about PRODUCTION. Visitors run the PUBLISHED copy (routes/studioAppsRun.js:
    // `(isOwner && wantDraft) ? app.definition : app.publishedDefinition`), while the
    // author edits the working definition. Indexing only the draft goes wrong at
    // exactly one moment, and that is the most dangerous moment there is: the owner
    // takes the button off the screen in the middle of a redesign, does not publish
    // yet, the autosave re-indexes — and from that moment the capsule says with full
    // certainty "No app button runs this automation yet" while the LIVE app still has
    // that button. It throws the automation away and the live app breaks.
    //
    // So the UNION. One row too many makes a deletion louder, one row too few makes it
    // silent — the same direction as with the unwired action above. That also means that
    // a newly wired button not yet published counts: it is a button that will be there
    // soon, and the warning is about throwing away.
    //
    // (`appRefLookup.js` DOES pick the draft, and that stays right: that one links back
    // to the EDITOR, and there the draft is the truth.)
    const sources = [
        { what: 'draft', definition: app.definition, required: true },
        { what: 'published', definition: app.publishedDefinition, required: false },
    ];

    const merged = new Map();   // `${refId}|${automationId}` → entry
    let unset = 0;
    for (const src of sources) {
        // Never published: no copy, no problem. Only the WORKING definition must be there.
        if (!src.required && (src.definition === null || src.definition === undefined)) continue;
        // See line 1: the store parses with a `{}` fallback, so only the SHAPE can tell
        // unreadable from empty. A canonical definition always has a screens array;
        // an empty `actions`, on the other hand, is perfectly normal and may well empty
        // the index.
        if (!src.definition || typeof src.definition !== 'object' || Array.isArray(src.definition)
            || !Array.isArray(src.definition.screens)) {
            return { ok: false, reason: 'unreadable-definition', ownerId: app.userId, which: src.what };
        }
        const found = refs.collectAutomationRefs(src.definition);
        // `unset` counts only the DRAFT: that is what the author has in front of them,
        // and the published copy would count the same unwired actions a second time.
        if (src.what === 'draft') unset = found.unset;
        for (const e of found.entries) {
            const key = `${e.refId}|${e.automationId}`;
            // De DRAFT wint bij gelijke sleutel: zijn knoplabel en scherm zijn
            // wat de auteur op zijn scherm ziet staan.
            if (!merged.has(key)) merged.set(key, e);
        }
    }

    return { ok: true, reason: 'collected', ownerId: app.userId, entries: [...merged.values()], unset };
}

/**
 * Sets the index equal to what this app now switches on in automations.
 *
 * Never throws. The answer says whether ANYTHING was written and why not:
 * `ok:false` means that the existing rows were left in place.
 * @param {string} appId
 * @param {UsageDeps} [deps]
 */
async function reconcileAppAutomationUsage(appId, deps = {}) {
    const log = deps.log || console;
    if (!appId) return { ok: false, reason: 'no-id', written: 0 };
    const store = deps.automationUsageStore || require('../stores/automationUsageStore');
    // See line 3: the number by which a pass notices that something was purged while
    // it was reading. Read before the first await, so every purge that comes after it
    // raises it.
    const epochAtStart = _purgeEpoch.get(appId) || 0;

    // One try for EVERYTHING. "Never throws" above is a promise to the save that calls
    // it, and that promise must not depend on whether every layer it calls keeps its
    // own promise.
    try {
        const collected = await collectAppAutomationUsage(appId, deps);

        // The app is gone. This is the SAFETY NET behind purgeAppAutomationUsage, not the
        // main road: the delete cleans up itself. If a reconcile nevertheless lands after
        // a deletion (a debounced pass that was still running), then cleaning up is the
        // right answer — writing would restore rows for an app nobody can open any more.
        if (collected.reason === 'no-app') {
            const purged = await store.purgeUsageForConsumer('app', appId);
            return { ok: true, reason: 'no-app', written: 0, purged };
        }

        if (!collected.ok) {
            // Regel 1: zeggen, niet wissen.
            log.warn(`[${LABEL}] ${appId}: automation usage index left as-is — ${/** @type {Record<string, string>} */ (REASONS)[collected.reason] || collected.reason}`);
            return { ok: false, reason: collected.reason, written: 0 };
        }

        // The app was deleted while this pass was reading. Writing through would restore
        // the rows that the purge just removed — a ghost row that then speaks on behalf of
        // a button nobody can press any more.
        if ((_purgeEpoch.get(appId) || 0) !== epochAtStart) {
            log.warn(`[${LABEL}] ${appId}: automation usage index left as-is — ${REASONS.superseded}`);
            return { ok: false, reason: 'superseded', written: 0 };
        }

        const written = await store.reconcileAutomationUsage('app', appId, collected.ownerId, collected.entries);

        // ZERO rows on a NON-empty list is not a successful reconcile. The INSERT is locked on
        // `automations.user_id = ownerId`, so this is exactly the shape in which a deleted or
        // someone else's automation announces itself: the DELETE ran, the INSERT did not.
        // Without this branch that would be `{ok:true, written:0}` and the capsule would
        // silently say "nergens gebruikt".
        if (written === 0 && collected.entries.length > 0) {
            log.warn(`[${LABEL}] ${appId}: ${collected.entries.length} automation reference(s) but nothing indexed — ${REASONS['not-indexed']}`);
            return {
                ok: false,
                reason: 'not-indexed',
                written: 0,
                entries: collected.entries,
                unset: collected.unset || 0,
            };
        }
        // A `run_automation` without a chosen automation is the state in which every template
        // is delivered. It blocks nothing, so it does not belong in `ok` — but without this
        // line an app with ten unwired actions gave zero signal, because the detached path
        // throws the return value away.
        if (collected.unset > 0) {
            log.warn(`[${LABEL}] ${appId}: ${collected.unset} action(s) still have no automation selected — indexed ${written} row(s) from the rest`);
        }
        return {
            ok: true,
            reason: 'reconciled',
            written,
            entries: collected.entries,
            unset: collected.unset || 0,
        };
    } catch (e) {
        log.warn(`[${LABEL}] ${appId}: automation usage index left as-is — ${REASONS.failed} (${/** @type {Error} */ (e).message})`);
        return { ok: false, reason: 'failed', written: 0 };
    }
}

// ── the path the writers use ───────────────────────────────────────────
//
// Debounced per app, with the same shape as W5: the FIRST trigger sets the
// timer, every trigger within it falls under it, and the timer is removed when it
// fires — so a change that comes in afterwards sets a new one. The pass reads the
// state only at the moment it runs, so it sees the last save, not the first.

const _pending = new Map();

/**
 * How often a purge has happened for this app.
 *
 * `cancelPendingReconcile` only clears a timer that has not yet fired — a pass that is
 * already READING can no longer be cancelled that way. This number can: the pass reads
 * it before its first await and refuses to write if it has been raised after that.
 * The key stays in the map after the purge (a handful of bytes per deleted app, and a
 * UUID never comes back), so that a pass that still comes out of it after the purge sees it.
 */
const _purgeEpoch = new Map();

/**
 * Cancel a running pass (the app is being deleted).
 * @param {string} appId
 */
function cancelPendingReconcile(appId) {
    const timer = _pending.get(appId);
    if (!timer) return false;
    clearTimeout(timer);
    _pending.delete(appId);
    return true;
}

/**
 * "This app has been saved." Never await, never throw — a save must not wait for this
 * and must not fall over on it.
 *
 * @param {string} appId
 * @param {{delayMs?:number}} [deps] otherwise the same deps as reconcileAppAutomationUsage
 */
function reconcileAppAutomationUsageDetached(appId, deps = {}) {
    if (!appId) return;
    const delayMs = Number.isFinite(deps.delayMs) ? deps.delayMs : RECONCILE_DEBOUNCE_MS;
    if (_pending.has(appId)) return;                  // één pass dekt de reeks
    const timer = setTimeout(() => {
        _pending.delete(appId);
        Promise.resolve()
            .then(() => reconcileAppAutomationUsage(appId, deps))
            .catch(e => logger.warn(`[${LABEL}] automation usage reconcile failed for ${appId}: ${e.message}`));
    }, delayMs);
    // A pending pass must not keep the process open on shutdown.
    timer.unref?.();
    _pending.set(appId, timer);
}

/**
 * The app is deleted — remove her rows.
 *
 * First cancel the pending pass: otherwise it could write the rows back again right
 * after they were cleaned up. Never throws; a deletion must not fail over an index.
 * @param {string} appId
 * @param {UsageDeps} [deps]
 */
async function purgeAppAutomationUsage(appId, deps = {}) {
    if (!appId) return 0;
    cancelPendingReconcile(appId);
    // Before the purge itself: a pass that is reading RIGHT NOW must, on return, already
    // see a different number, even if the purge below takes a while.
    _purgeEpoch.set(appId, (_purgeEpoch.get(appId) || 0) + 1);
    try {
        const store = deps.automationUsageStore || require('../stores/automationUsageStore');
        return await store.purgeUsageForConsumer('app', appId);
    } catch (e) {
        // The deletion itself has already happened; throwing here would give the user a 500
        // over an app that IS gone. The rows then stay in place — annoying, but visible in the
        // log, and the next reconcile on that id cleans them up via the safety net.
        (deps.log || console).warn(`[${LABEL}] ${appId}: automation usage purge failed — ${/** @type {Error} */ (e).message}`);
        return 0;
    }
}

/**
 * ── THE BACKFILL: THE INDEX DOES NOT EXIST FOR APPS NOBODY SAVES ────────
 *
 * The table is created empty and fills only on a save, a create or a restored version.
 * On the day of rollout it is therefore empty for EVERY existing app, and then every
 * automation owner reads "No app button runs this automatisering yet" about buttons that
 * work fine — a statement about the world, made on a table that was never filled. And
 * that stays so until someone happens to save that app.
 *
 * Two things together close that:
 *   1. `automation_usage_indexed` makes "empty" and "never looked at" distinguishable,
 *      so that the capsule can stay silent instead of asserting.
 *   2. This pass FILLS it, in pieces. It hangs on the read side (the route that feeds
 *      the capsule) instead of on boot: an app that is never read does not need anyone
 *      to be given a wrong answer, and boot must not get slower from an index.
 *
 * Never awaited by the caller, never throwing, and at most one pass at a time in this
 * process. Every app goes through the same reconcile as a save, so all three rules above
 * apply here too — an app that cannot be read is skipped and gets NO marking, so that the
 * next pass tries it again.
 */
const BACKFILL_BATCH = 25;
let _backfillRunning = false;

/** @param {UsageDeps} [deps] */
async function backfillAutomationUsage(deps = {}) {
    if (_backfillRunning) return { ok: true, reason: 'already-running', indexed: 0 };
    _backfillRunning = true;
    const log = deps.log || console;
    const store = deps.automationUsageStore || require('../stores/automationUsageStore');
    const limit = Number.isFinite(deps.limit) ? deps.limit : BACKFILL_BATCH;
    let indexed = 0;
    let failed = 0;
    try {
        const appIds = await store.listUnindexedApps(limit);
        for (const appId of appIds) {
            const out = await reconcileAppAutomationUsage(appId, deps);
            if (out.ok) indexed += 1; else failed += 1;
        }
        if (indexed || failed) {
            log.warn(`[${LABEL}] automation usage backfill: indexed ${indexed} app(s)`
                + (failed ? `, ${failed} left for the next pass` : ''));
        }
        return { ok: true, reason: 'backfilled', indexed, failed };
    } catch (e) {
        log.warn(`[${LABEL}] automation usage backfill failed — ${/** @type {Error} */ (e).message}`);
        return { ok: false, reason: 'failed', indexed, failed };
    } finally {
        _backfillRunning = false;
    }
}

/**
 * Same pass, but detached: a read does not wait for it.
 * @param {UsageDeps} [deps]
 */
function backfillAutomationUsageDetached(deps = {}) {
    Promise.resolve()
        .then(() => backfillAutomationUsage(deps))
        .catch(e => logger.warn(`[${LABEL}] automation usage backfill failed: ${e.message}`));
}

module.exports = {
    collectAppAutomationUsage,
    backfillAutomationUsage,
    backfillAutomationUsageDetached,
    BACKFILL_BATCH,
    reconcileAppAutomationUsage,
    reconcileAppAutomationUsageDetached,
    purgeAppAutomationUsage,
    cancelPendingReconcile,
    LABEL,
    RECONCILE_DEBOUNCE_MS,
    REASONS,
};

/**
 * De injecteerbare randen (tests): winkels, logger, en de tijd/hoeveelheid van een pass.
 * @typedef {{ studioAppStore?: typeof import('../stores/studioAppStore'), automationRefs?: typeof import('./automationRefs'),
 *   automationUsageStore?: typeof import('../stores/automationUsageStore'), log?: Pick<Console, 'warn'>,
 *   limit?: number, delayMs?: number }} UsageDeps
 */
